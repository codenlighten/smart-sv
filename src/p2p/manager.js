'use strict';

const net = require('net');
const EventEmitter = require('events');
const sv = require('../sv');
const params = require('../params');
const { Peer } = require('./peer');
const { AddrBook } = require('./addrbook');

const PROTOCOL_VERSION = 1;
const MAX_INV_PER_BATCH = 500; // block hashes announced per getblocks response
const PING_INTERVAL_MS = 30000;
const DIAL_INTERVAL_MS = 15000; // how often to top up outbound connections
const FIRST_DIAL_DELAY_MS = 500; // reconnect to known peers promptly after start
const MAX_ADDRS_PER_MSG = 1000;

/**
 * PeerManager: the SmartSV P2P network layer.
 *
 * Responsibilities:
 *   - accept inbound and dial outbound TCP connections
 *   - version/verack handshake (with self-connection detection)
 *   - initial block download: getblocks → inv → getdata → block, applied in order
 *   - inv/getdata gossip relay of new blocks and transactions, wired to the
 *     node's `block`/`tx` events
 *   - a persistent address book (see addrbook.js) fed by getaddr/addr exchange,
 *     and automatic outbound peer management on top of it
 *
 * It drives the node purely through `submitBlock` / `submitTransaction`, so it
 * is fully decoupled from consensus.
 */
class PeerManager extends EventEmitter {
  constructor(node, opts = {}) {
    super();
    this.node = node;
    this.port = opts.port != null ? opts.port : params.p2pPort; // 0 => OS-assigned
    this.maxPeers = opts.maxPeers || 16;
    this.targetOutbound = Math.min(
      opts.targetOutbound != null ? opts.targetOutbound : 8,
      this.maxPeers
    );
    this.peers = new Set();
    this.dialing = new Set(); // addrKeys with a dial in flight
    this.server = null;
    this.nonce = sv.crypto.Random.getRandomBuffer(8).toString('hex');
    this._pingTimer = null;
    this._dialTimer = null;
    this._dialIntervalMs = opts.dialInterval || DIAL_INTERVAL_MS;
    this._running = false;
    this._log = opts.log || (() => {});

    // Peers are persisted alongside chain state unless persistence is opted out
    // of (opts.store === null), which keeps the book purely in-memory.
    const store = opts.store !== undefined ? opts.store : node.store;
    this.addrBook = new AddrBook(store, {
      now: () => this.node.now(),
      log: this._log,
    });
  }

  // --- lifecycle ----------------------------------------------------------

  start() {
    this._running = true;
    this.server = net.createServer((socket) => this._addPeer(socket, true));
    this.server.on('error', (e) => this._log(`[p2p] server error: ${e.message}`));
    this.server.listen(this.port, () => {
      this.actualPort = this.server.address().port; // resolves port 0 to the OS-assigned port
      this._log(`[p2p] listening on ${this.actualPort} (nonce ${this.nonce.slice(0, 8)})`);
      this.emit('listening', this.actualPort);
    });

    // Relay locally-accepted blocks/txs to peers.
    this.node.on('block', ({ block }) => this._announce('block', block.id));
    this.node.on('tx', ({ txid }) => this._announce('tx', txid));

    this._pingTimer = setInterval(() => this._pingAll(), PING_INTERVAL_MS);
    if (this._pingTimer.unref) this._pingTimer.unref();

    // Keep outbound connections topped up from the address book. The first pass
    // runs almost immediately so a restarted node reconnects to peers it already
    // knows without waiting a full interval.
    this._firstDial = setTimeout(() => this._maintainOutbound(), FIRST_DIAL_DELAY_MS);
    if (this._firstDial.unref) this._firstDial.unref();
    this._dialTimer = setInterval(() => this._maintainOutbound(), this._dialIntervalMs);
    if (this._dialTimer.unref) this._dialTimer.unref();
    return this;
  }

  stop() {
    this._running = false;
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._dialTimer) clearInterval(this._dialTimer);
    if (this._firstDial) clearTimeout(this._firstDial);
    for (const peer of this.peers) peer.destroy();
    this.peers.clear();
    this.dialing.clear();
    if (this.server) this.server.close();
  }

  /**
   * Dial a peer at "host:port" (or {host, port}).
   * @param {object} [opts]
   * @param {string} [opts.source] how we learned the address ('seed'|'book'|'gossip')
   * @returns {boolean} whether a dial was actually started
   */
  connect(target, opts = {}) {
    const { host, port } = normalizeAddr(target);
    const addrKey = `${host}:${port}`;
    if (!this.addrBook.add(addrKey, { source: opts.source || 'seed' })) {
      this._log(`[p2p] refusing to dial unusable address ${addrKey}`);
      return false;
    }
    if (this.dialing.has(addrKey) || this._connectedAddrs().has(addrKey)) return false;
    if (this.peers.size >= this.maxPeers) return false;

    this.dialing.add(addrKey);
    this.addrBook.markAttempt(addrKey);
    const socket = net.connect({ host, port }, () => {
      this._log(`[p2p] connected out to ${addrKey}`);
    });
    socket.on('error', (e) => this._log(`[p2p] dial ${addrKey} failed: ${e.message}`));
    this._addPeer(socket, false, addrKey);
    return true;
  }

  peerCount() {
    return this.peers.size;
  }

  outboundCount() {
    let n = 0;
    for (const peer of this.peers) if (!peer.inbound) n++;
    return n;
  }

  // --- outbound peer management -------------------------------------------

  /**
   * Top up outbound connections towards `targetOutbound`, picking the most
   * promising addresses that are not already connected, in flight, or backing
   * off after a failure.
   */
  _maintainOutbound() {
    if (!this._running) return;
    // Every in-flight dial already has a Peer object, so outboundCount() covers
    // both connected and connecting outbound slots.
    const need = Math.min(
      this.targetOutbound - this.outboundCount(),
      this.maxPeers - this.peers.size
    );
    if (need <= 0) return;

    const candidates = this.addrBook.select(need, { exclude: this._connectedAddrs() });
    if (!candidates.length) return;
    this._log(`[p2p] dialing ${candidates.length} peer(s) from the address book`);
    for (const addr of candidates) this.connect(addr, { source: 'book' });
  }

  /** Addresses we are already connected to or dialling — never dial these again. */
  _connectedAddrs() {
    const busy = new Set(this.dialing);
    for (const peer of this.peers) {
      if (peer.addrKey) busy.add(peer.addrKey);
      if (peer.advertisedAddr) busy.add(peer.advertisedAddr);
    }
    return busy;
  }

  // --- peer wiring --------------------------------------------------------

  _addPeer(socket, inbound, addrKey) {
    if (this.peers.size >= this.maxPeers) {
      socket.destroy();
      if (addrKey) this.dialing.delete(addrKey);
      return;
    }
    const peer = new Peer(socket, { inbound });
    peer.addrKey = addrKey;
    if (addrKey) peer.id = addrKey; // outbound socket has no remoteAddress until connected
    else socket.once('connect', () => (peer.id = `${cleanHost(socket.remoteAddress)}:${socket.remotePort}`));
    this.peers.add(peer);

    peer.on('message', (msg) => this._onMessage(peer, msg));
    peer.on('close', () => {
      this.peers.delete(peer);
      if (addrKey) {
        this.dialing.delete(addrKey);
        // A dial that never reached verack counts against the address, so its
        // backoff grows and better candidates get tried first.
        if (!peer.handshakeDone && !peer.selfConnection) this.addrBook.markFailure(addrKey);
      }
      this._log(`[p2p] peer ${peer.id} closed (${this.peers.size} left)`);
    });
    peer.on('error', () => peer.destroy());

    // Both sides send version on connect; the initiator's is answered with verack.
    this._sendVersion(peer);
  }

  _sendVersion(peer) {
    peer.send('version', {
      version: PROTOCOL_VERSION,
      height: this.node.chain.height(),
      nonce: this.nonce,
      userAgent: `/${params.chainName}:1.0/`,
      port: this.actualPort || this.port,
    });
  }

  // --- message dispatch ---------------------------------------------------

  _onMessage(peer, { command, payload }) {
    switch (command) {
      case 'version':
        return this._onVersion(peer, payload);
      case 'verack':
        return this._onVerack(peer);
      case 'ping':
        return peer.send('pong', { nonce: payload.nonce });
      case 'pong':
        return;
      case 'getaddr':
        return this._onGetAddr(peer);
      case 'addr':
        return this._onAddr(peer, payload);
      case 'inv':
        return this._onInv(peer, payload);
      case 'getdata':
        return this._onGetData(peer, payload);
      case 'getblocks':
        return this._onGetBlocks(peer, payload);
      case 'block':
        return this._onBlock(peer, payload);
      case 'tx':
        return this._onTx(peer, payload);
      default:
        this._log(`[p2p] unknown command '${command}' from ${peer.id}`);
    }
  }

  _onVersion(peer, payload) {
    if (payload.nonce && payload.nonce === this.nonce) {
      this._log('[p2p] self-connection detected, dropping');
      peer.selfConnection = true;
      // Remember that this address is us, so the dialer stops picking it.
      if (peer.addrKey) this.addrBook.markSelf(peer.addrKey);
      peer.destroy();
      return;
    }
    peer.versionReceived = true;
    peer.height = payload.height || 0;
    peer.userAgent = payload.userAgent;
    peer.remoteNonce = payload.nonce;
    if (payload.port && peer.socket.remoteAddress) {
      // The peer's *listening* address (their source port is ephemeral).
      peer.advertisedAddr = `${cleanHost(peer.socket.remoteAddress)}:${payload.port}`;
      this._noteAddr(peer.advertisedAddr);
    }
    peer.send('verack', {});
  }

  _onVerack(peer) {
    if (peer.handshakeDone) return;
    peer.handshakeDone = true;
    if (peer.addrKey) {
      this.dialing.delete(peer.addrKey);
      this.addrBook.markSuccess(peer.addrKey);
    }
    this._log(`[p2p] handshake done with ${peer.id} (their height ${peer.height})`);
    this.emit('peer', peer);

    // Learn about more peers, and start syncing if this peer is ahead.
    peer.send('getaddr', {});
    if (peer.height > this.node.chain.height()) this._requestBlocks(peer);
  }

  // --- address book --------------------------------------------------------

  _onGetAddr(peer) {
    // Don't advertise addresses we know to be bad (banned, or ourselves).
    const now = this.node.now();
    const addrs = this.addrBook
      .list()
      .filter((e) => e.bannedUntil <= now && e.source !== 'self')
      .slice(0, MAX_ADDRS_PER_MSG)
      .map((e) => e.addr);
    peer.send('addr', { addrs });
  }

  _onAddr(peer, payload) {
    const addrs = (payload.addrs || []).slice(0, MAX_ADDRS_PER_MSG);
    const added = this.addrBook.addMany(addrs, { source: 'gossip' });
    if (added) this._log(`[p2p] learned ${added} address(es) from ${peer.id}`);
  }

  _noteAddr(addrKey) {
    this.addrBook.add(addrKey, { source: 'gossip' });
  }

  // --- inventory / relay ---------------------------------------------------

  /** Announce a newly-accepted block/tx to peers that haven't seen it. */
  _announce(type, hash) {
    for (const peer of this.peers) {
      if (!peer.handshakeDone) continue;
      if (peer.known.has(hash)) continue;
      peer.markKnown(hash);
      peer.send('inv', { items: [{ type, hash }] });
    }
  }

  _onInv(peer, payload) {
    const want = [];
    for (const item of payload.items || []) {
      peer.markKnown(item.hash);
      if (item.type === 'block' && !this.node.chain.byHash.has(item.hash)) {
        want.push(item);
      } else if (item.type === 'tx' && !this._haveTx(item.hash)) {
        want.push(item);
      }
    }
    if (want.length) peer.send('getdata', { items: want });
  }

  _onGetData(peer, payload) {
    for (const item of payload.items || []) {
      if (item.type === 'block') {
        const block = this.node.chain.getBlock(item.hash);
        if (block) {
          peer.markKnown(item.hash);
          peer.send('block', block.toBuffer());
        }
      } else if (item.type === 'tx') {
        const tx = this.node.mempool.get(item.hash) || this._confirmedTx(item.hash);
        if (tx) {
          peer.markKnown(item.hash);
          peer.send('tx', tx.toBuffer());
        }
      }
    }
  }

  // --- block sync ----------------------------------------------------------

  _requestBlocks(peer) {
    peer.send('getblocks', { locator: this._buildLocator() });
  }

  /**
   * A block locator: active-chain hashes from the tip backwards with an
   * exponentially growing step, always ending at genesis. It lets a peer find
   * the highest block we share even when our chains have diverged.
   */
  _buildLocator() {
    const locator = [];
    let step = 1;
    let h = this.node.chain.height();
    while (h > 0) {
      const entry = this.node.chain.index[h];
      if (entry) locator.push(entry.hash);
      if (locator.length > 10) step *= 2;
      h -= step;
    }
    const genesis = this.node.chain.index[0];
    if (genesis) locator.push(genesis.hash);
    return locator;
  }

  _onGetBlocks(peer, payload) {
    // Find the fork height: the highest locator hash that is on our active chain.
    let forkHeight = 0;
    if (Array.isArray(payload.locator)) {
      for (const hash of payload.locator) {
        const node = this.node.chain.byHash.get(hash);
        if (node && node.main) {
          forkHeight = node.height;
          break;
        }
      }
    } else if (payload.height != null) {
      forkHeight = payload.height; // back-compat with the height-only form
    }

    const from = forkHeight + 1;
    const top = Math.min(this.node.chain.height(), from - 1 + MAX_INV_PER_BATCH);
    const items = [];
    for (let h = from; h <= top; h++) {
      const entry = this.node.chain.index[h];
      if (entry) items.push({ type: 'block', hash: entry.hash });
    }
    if (items.length) {
      for (const it of items) peer.markKnown(it.hash);
      peer.send('inv', { items });
    }
  }

  _onBlock(peer, payload) {
    let block;
    try {
      block = sv.Block.fromBuffer(payload);
    } catch (e) {
      this._penalize(peer, `undecodable block: ${e.message}`);
      return;
    }
    peer.markKnown(block.id);
    let res;
    try {
      res = this.node.submitBlock(block);
    } catch (e) {
      this._log(`[p2p] rejected block from ${peer.id}: ${e.message}`);
      return;
    }

    switch (res.status) {
      case 'connected':
        this._log(
          `[p2p] connected block ${res.height} ${block.id.slice(0, 12)}` +
            `${res.reorg ? ' (reorg)' : ''} from ${peer.id}`
        );
        // Keep pulling if the peer is still ahead.
        if (peer.height > this.node.chain.height()) this._requestBlocks(peer);
        break;
      case 'orphan':
        // Missing ancestors — ask this peer to fill the gap.
        this._requestBlocks(peer);
        break;
      case 'sidechain':
        this._log(`[p2p] stored side-chain block ${block.id.slice(0, 12)} from ${peer.id}`);
        break;
      case 'invalid':
        this._penalize(peer, `invalid block ${block.id.slice(0, 12)}: ${res.error}`);
        break;
      default:
        break; // duplicate
    }
  }

  _onTx(peer, payload) {
    let tx;
    try {
      tx = new sv.Transaction(payload);
    } catch (e) {
      return;
    }
    peer.markKnown(tx.hash);
    try {
      this.node.submitTransaction(tx); // emits 'tx' → relays onward
    } catch (e) {
      // already-have / invalid: ignore silently (normal in gossip)
    }
  }

  // --- helpers -------------------------------------------------------------

  /** Drop a misbehaving peer and ban its address so the dialer skips it. */
  _penalize(peer, reason) {
    const addr = peer.addrKey || peer.advertisedAddr;
    this._log(`[p2p] dropping ${peer.id}: ${reason}${addr ? ' (address banned)' : ''}`);
    if (addr) this.addrBook.ban(addr);
    peer.destroy();
  }

  _haveTx(txid) {
    return this.node.mempool.has(txid) || !!this._confirmedTx(txid);
  }

  _confirmedTx(txid) {
    const found = this.node.getTransaction(txid);
    return found ? found.tx : null;
  }

  _pingAll() {
    const nonce = sv.crypto.Random.getRandomBuffer(8).toString('hex');
    for (const peer of this.peers) {
      if (peer.handshakeDone) peer.send('ping', { nonce });
    }
  }
}

function normalizeAddr(target) {
  if (typeof target === 'object') return target;
  const idx = target.lastIndexOf(':');
  return { host: target.slice(0, idx), port: Number(target.slice(idx + 1)) };
}

function cleanHost(addr) {
  return addr.replace(/^::ffff:/, '');
}

module.exports = { PeerManager, PROTOCOL_VERSION };
