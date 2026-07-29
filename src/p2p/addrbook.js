'use strict';

/**
 * AddrBook — the persistent P2P address book.
 *
 * Every address the node ever learns (from a peer's `version` port, from `addr`
 * gossip, or from a configured seed) is recorded here together with how well it
 * has behaved: when we last saw it announced, when we last dialled it, whether
 * that dial succeeded, and how many consecutive failures it has accumulated.
 *
 * Two things fall out of that record:
 *   - **Restart survival.** The book is written through to SQLite, so a node
 *     that is stopped and started again re-dials the peers it already knows
 *     instead of depending on a hard-coded seed list.
 *   - **Sane retry behaviour.** `select()` only returns addresses whose
 *     exponential backoff has elapsed, preferring peers that have connected
 *     successfully before, then never-tried ones, then the least-failed.
 *
 * The store is optional: pass `null` (or a node with no chainstore) and the book
 * is a pure in-memory cache with identical semantics — which is what the
 * in-process tests and `--no-p2p` style embedding use.
 */

const RETRY_BASE_SEC = 30; // first retry delay after a failed dial
const RETRY_MAX_SEC = 3600; // ceiling on the exponential backoff
const MAX_ENTRIES = 2500; // capacity before eviction kicks in
const SELF_BAN_SEC = 24 * 3600; // how long to shun our own advertised address
const MISBEHAVE_BAN_SEC = 3600; // ban applied to a peer that sends us garbage
const FORGET_FAILURES = 12; // never-connected addresses are dropped after this many failures

class AddrBook {
  /**
   * @param {object|null} store  ChainStore-like: putPeer/delPeer/allPeers/transaction
   * @param {object} [opts]
   * @param {() => number} [opts.now]      clock in epoch seconds
   * @param {number} [opts.maxEntries]
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(store, opts = {}) {
    this.store = store && typeof store.allPeers === 'function' ? store : null;
    this.now = opts.now || (() => Math.floor(Date.now() / 1000));
    this.maxEntries = opts.maxEntries || MAX_ENTRIES;
    this._log = opts.log || (() => {});
    this.entries = new Map(); // "host:port" -> entry
    if (this.store) this._load();
  }

  _load() {
    let rows = [];
    try {
      rows = this.store.allPeers();
    } catch (e) {
      this._log(`[addr] load failed: ${e.message}`);
      return;
    }
    for (const r of rows) this.entries.set(r.addr, { ...r });
    if (rows.length) this._log(`[addr] loaded ${rows.length} known peers`);
  }

  // --- reads ---------------------------------------------------------------

  size() {
    return this.entries.size;
  }

  /** Address strings, newest-seen first. Mirrors the old `Map#keys()` usage. */
  keys() {
    return [...this.entries.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((e) => e.addr);
  }

  has(addr) {
    return this.entries.has(addr);
  }

  get(addr) {
    return this.entries.get(addr) || null;
  }

  /** Full entries, newest-seen first — used by the `/peers` RPC route. */
  list() {
    return [...this.entries.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  isBanned(addr, now = this.now()) {
    const e = this.entries.get(addr);
    return !!e && e.bannedUntil > now;
  }

  /** Seconds until `entry` may be dialled again (0 = right now). */
  backoffRemaining(entry, now = this.now()) {
    if (entry.bannedUntil > now) return entry.bannedUntil - now;
    if (!entry.failures) return 0;
    const delay = Math.min(RETRY_BASE_SEC * 2 ** (entry.failures - 1), RETRY_MAX_SEC);
    return Math.max(0, entry.lastTry + delay - now);
  }

  /**
   * Up to `count` addresses worth dialling now.
   * @param {object} [opts]
   * @param {Set<string>|string[]} [opts.exclude]  already connected/in-flight
   */
  select(count, opts = {}) {
    const now = this.now();
    const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || []);
    const eligible = [];
    for (const e of this.entries.values()) {
      if (exclude.has(e.addr)) continue;
      if (this.backoffRemaining(e, now) > 0) continue;
      eligible.push(e);
    }
    eligible.sort(rank);
    return eligible.slice(0, count).map((e) => e.addr);
  }

  // --- writes --------------------------------------------------------------

  /**
   * Record an address we learned about. Returns the entry, or null if the
   * address is unusable (malformed, port 0, wildcard host).
   */
  add(addr, opts = {}) {
    const parsed = parseAddr(addr);
    if (!parsed) return null;
    const now = opts.now != null ? opts.now : this.now();
    let e = this.entries.get(parsed.addr);
    if (e) {
      e.lastSeen = now;
      // A later gossip sighting must not erase a stickier tag: an address we
      // were configured with stays a seed, and one that turned out to be us
      // stays 'self'.
      if (opts.source && sourceRank(opts.source) >= sourceRank(e.source)) e.source = opts.source;
    } else {
      e = {
        addr: parsed.addr,
        host: parsed.host,
        port: parsed.port,
        firstSeen: now,
        lastSeen: now,
        lastTry: 0,
        lastSuccess: 0,
        failures: 0,
        successes: 0,
        bannedUntil: 0,
        source: opts.source || 'gossip',
      };
      this.entries.set(e.addr, e);
    }
    this._persist(e);
    this._evict();
    return e;
  }

  /** Bulk-add gossiped addresses in one SQLite transaction. @returns {number} added/refreshed */
  addMany(addrs, opts = {}) {
    const run = () => {
      let n = 0;
      for (const a of addrs) if (this.add(a, opts)) n++;
      return n;
    };
    return this.store ? this.store.transaction(run) : run();
  }

  markAttempt(addr) {
    return this._touch(addr, (e, now) => {
      e.lastTry = now;
    });
  }

  markSuccess(addr) {
    return this._touch(addr, (e, now) => {
      e.lastSuccess = now;
      e.lastSeen = now;
      e.successes++;
      e.failures = 0;
    });
  }

  markFailure(addr) {
    const e = this._touch(addr, (entry, now) => {
      entry.lastTry = now;
      entry.failures++;
    });
    // An address that has never once connected is not worth keeping forever —
    // but keep banned ones so the ban is not lost by forgetting them.
    const banned = e && e.bannedUntil > this.now();
    if (e && !banned && !e.successes && e.failures >= FORGET_FAILURES && e.source !== 'seed') {
      this.forget(e.addr);
    }
    return e;
  }

  /** Ban an address for `seconds` (defaults to the misbehaviour ban). */
  ban(addr, seconds = MISBEHAVE_BAN_SEC) {
    return this._touch(addr, (e, now) => {
      e.bannedUntil = now + seconds;
    });
  }

  /** We dialled ourselves — shun the address without treating it as a failure. */
  markSelf(addr) {
    return this._touch(addr, (e, now) => {
      e.bannedUntil = now + SELF_BAN_SEC;
      e.source = 'self';
      e.failures = 0;
    });
  }

  forget(addr) {
    if (!this.entries.delete(addr)) return false;
    if (this.store) {
      try {
        this.store.delPeer(addr);
      } catch (e) {
        this._log(`[addr] delete failed: ${e.message}`);
      }
    }
    return true;
  }

  // --- internals -----------------------------------------------------------

  /** Apply `fn` to an existing entry (creating it if the address is valid) and persist. */
  _touch(addr, fn) {
    let e = this.entries.get(addr);
    if (!e) {
      e = this.add(addr);
      if (!e) return null;
    }
    fn(e, this.now());
    this._persist(e);
    return e;
  }

  _persist(entry) {
    if (!this.store) return;
    try {
      this.store.putPeer(entry);
    } catch (e) {
      this._log(`[addr] persist failed: ${e.message}`);
    }
  }

  /** Trim to capacity, dropping the least valuable entries first. */
  _evict() {
    if (this.entries.size <= this.maxEntries) return;
    const doomed = [...this.entries.values()].sort(rank).slice(this.maxEntries);
    for (const e of doomed) this.forget(e.addr);
  }
}

/**
 * Dial-worthiness order (best first): peers that have connected before, then
 * never-tried ones, then fewest failures, then most recently announced.
 */
function rank(a, b) {
  if (!!b.successes !== !!a.successes) return b.successes ? 1 : -1;
  if (a.failures !== b.failures) return a.failures - b.failures;
  if (a.lastSuccess !== b.lastSuccess) return b.lastSuccess - a.lastSuccess;
  return b.lastSeen - a.lastSeen;
}

/** How authoritative a `source` tag is; a weaker one never overwrites a stronger. */
function sourceRank(source) {
  if (source === 'self') return 3;
  if (source === 'seed') return 2;
  return 1; // 'gossip' | 'book' | unknown
}

/** Parse and sanity-check "host:port". Returns null for anything undialable. */
function parseAddr(addr) {
  if (!addr || typeof addr !== 'string') return null;
  const idx = addr.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = addr.slice(0, idx).replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  const port = Number(addr.slice(idx + 1));
  if (!host || host === 'undefined' || host === '0.0.0.0' || host === '::') return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { addr: `${host}:${port}`, host, port };
}

module.exports = {
  AddrBook,
  parseAddr,
  RETRY_BASE_SEC,
  RETRY_MAX_SEC,
  SELF_BAN_SEC,
  MISBEHAVE_BAN_SEC,
  FORGET_FAILURES,
};
