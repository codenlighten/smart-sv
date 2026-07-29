'use strict';

const net = require('net');
const EventEmitter = require('events');
const sv = require('../sv');
const params = require('../params');
const { Peer } = require('./peer');
const { AddrBook } = require('./addrbook');
const { HeaderChain } = require('./headerchain');
const compact = require('./compact');
const pow = require('../pow');

const PROTOCOL_VERSION = 1;
const MAX_INV_PER_BATCH = 500; // block hashes announced per getblocks response
const MAX_HEADERS_PER_BATCH = 2000; // headers served per getheaders
const MAX_BLOCKS_IN_FLIGHT = 16; // body requests outstanding during sync
const BODY_TIMEOUT_MS = 30000; // re-request a body that never arrived
const MAX_UNCONNECTING_HEADERS = 3; // strikes before dropping a peer sending dangling chains
const COMPACT_TIMEOUT_MS = 30000; // give up on a half-reconstructed compact block
const PING_INTERVAL_MS = 30000;
const SYNC_INTERVAL_MS = 5000; // re-drive a download that stalled
const DIAL_INTERVAL_MS = 15000; // how often to top up outbound connections
const FIRST_DIAL_DELAY_MS = 500; // reconnect to known peers promptly after start
const MAX_ADDRS_PER_MSG = 1000;

/**
 * PeerManager: the SmartSV P2P network layer.
 *
 * Responsibilities:
 *   - accept inbound and dial outbound TCP connections
 *   - version/verack handshake (with self-connection detection)
 *   - headers-first initial block download: getheaders → headers → getdata →
 *     block, so the most-work chain is established from 80-byte PoW-checked
 *     headers before any body is fetched (see headerchain.js)
 *   - inv/getdata gossip relay of new blocks and transactions, wired to the
 *     node's `block`/`tx` events, with compact-block announcement of new tips
 *     to peers that support it (see compact.js)
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
    this.headers = new HeaderChain(node.chain); // headers-first download plan
    this.inFlight = new Map(); // block hash -> { peer, at } body requests outstanding
    this.pendingCompact = new Map(); // block hash -> partially reconstructed compact block
    this.compactEnabled = opts.compact !== false;
    this.stats = { compactBlocks: 0, compactTxsSaved: 0, compactFallbacks: 0 };
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
    this.node.on('block', ({ block }) => this._announceBlock(block));
    this.node.on('tx', ({ txid }) => this._announce('tx', txid));

    this._pingTimer = setInterval(() => this._pingAll(), PING_INTERVAL_MS);
    if (this._pingTimer.unref) this._pingTimer.unref();

    this._syncTimer = setInterval(() => this._syncTick(), SYNC_INTERVAL_MS);
    if (this._syncTimer.unref) this._syncTimer.unref();

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
    if (this._syncTimer) clearInterval(this._syncTimer);
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
      // Release this peer's outstanding body requests so another peer can serve them.
      for (const [hash, req] of this.inFlight) {
        if (req.peer === peer) this.inFlight.delete(hash);
      }
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
      compact: this.compactEnabled, // we can receive cmpctblock announcements
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
      case 'getheaders':
        return this._onGetHeaders(peer, payload);
      case 'headers':
        return this._onHeaders(peer, payload);
      case 'cmpctblock':
        return this._onCompactBlock(peer, payload);
      case 'getblocktxn':
        return this._onGetBlockTxn(peer, payload);
      case 'blocktxn':
        return this._onBlockTxn(peer, payload);
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
    // Only send sketches to peers that said they understand them; older nodes
    // keep getting plain inv announcements.
    peer.wantsCompact = this.compactEnabled && !!payload.compact;
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
    if (peer.height > this.node.chain.height()) this._requestHeaders(peer);
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

  /**
   * Announce a new tip. Peers that support compact relay get the sketch
   * directly — one round trip instead of inv/getdata, and without re-sending
   * transactions they already hold in their mempool.
   */
  _announceBlock(block) {
    for (const peer of this.peers) {
      if (!peer.handshakeDone) continue;
      if (peer.known.has(block.id)) continue;
      peer.markKnown(block.id);
      if (peer.wantsCompact) {
        const nonce = sv.crypto.Random.getRandomBuffer(8).toString('hex');
        peer.send('cmpctblock', compact.buildCompact(block, nonce));
      } else {
        peer.send('inv', { items: [{ type: 'block', hash: block.id }] });
      }
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

  // --- compact block relay --------------------------------------------------

  /**
   * A peer sketched its new tip. Fill in what our mempool already holds and ask
   * only for the rest; if everything is present the block is complete without a
   * single transaction crossing the wire.
   */
  _onCompactBlock(peer, payload) {
    // Check the header before touching the mempool: matching short ids costs a
    // hash per mempool entry, so it must not be reachable for free.
    let header;
    try {
      header = sv.BlockHeader.fromBuffer(Buffer.from(payload.header || '', 'hex'));
    } catch (e) {
      this._penalize(peer, `undecodable compact block header: ${e.message}`);
      return;
    }
    const hash = header.hash;
    peer.markKnown(hash);
    if (this.node.chain.byHash.has(hash) || this.pendingCompact.has(hash)) return;
    if (!pow.checkProofOfWork(header)) {
      this._penalize(peer, `compact block ${hash.slice(0, 12)} fails proof of work`);
      return;
    }

    let slots;
    let missing;
    try {
      ({ slots, missing } = compact.reconstruct(payload, this._mempoolTxs()));
    } catch (e) {
      this._penalize(peer, `malformed compact block: ${e.message}`);
      return;
    }

    this.stats.compactBlocks++;
    this.stats.compactTxsSaved += slots.length - missing.length - 1; // minus the prefilled coinbase

    if (!missing.length) {
      this._log(
        `[p2p] compact block ${hash.slice(0, 12)} rebuilt from mempool ` +
          `(${slots.length} txs, 0 requested)`
      );
      this._acceptReconstructed(peer, header, slots);
      return;
    }

    this.pendingCompact.set(hash, { peer, header, slots, missing, at: Date.now() });
    this._log(
      `[p2p] compact block ${hash.slice(0, 12)}: ${missing.length}/${slots.length} txs missing`
    );
    peer.send('getblocktxn', { blockHash: hash, indexes: missing });
  }

  /** Serve the transactions a peer couldn't find for one of our blocks. */
  _onGetBlockTxn(peer, payload) {
    const block = this.node.chain.getBlock(payload.blockHash);
    if (!block) return;
    const txs = [];
    for (const index of payload.indexes || []) {
      const tx = block.transactions[index];
      if (!tx) return; // bogus index: say nothing rather than guess
      txs.push(tx.toBuffer().toString('hex'));
    }
    peer.send('blocktxn', { blockHash: payload.blockHash, txs });
  }

  _onBlockTxn(peer, payload) {
    const pending = this.pendingCompact.get(payload.blockHash);
    if (!pending) return;
    this.pendingCompact.delete(payload.blockHash);

    const txs = payload.txs || [];
    if (txs.length !== pending.missing.length) {
      this._fallbackToFullBlock(peer, payload.blockHash, 'wrong number of transactions');
      return;
    }
    try {
      pending.missing.forEach((index, i) => {
        pending.slots[index] = new sv.Transaction(Buffer.from(txs[i], 'hex'));
      });
    } catch (e) {
      this._fallbackToFullBlock(peer, payload.blockHash, `undecodable transaction: ${e.message}`);
      return;
    }
    this._acceptReconstructed(peer, pending.header, pending.slots);
  }

  /**
   * Hand a rebuilt block to consensus. The merkle check inside `assemble` is
   * what makes short ids safe: a collision (or a peer feeding us the wrong
   * transactions) produces a block that doesn't match the header, and we simply
   * ask for the real thing instead.
   */
  _acceptReconstructed(peer, header, slots) {
    const block = compact.assemble(header, slots);
    if (!block) {
      this._fallbackToFullBlock(peer, header.hash, 'merkle root mismatch after reconstruction');
      return;
    }
    this._acceptBlock(peer, block);
  }

  /** Compact reconstruction failed — request the block the plain way. */
  _fallbackToFullBlock(peer, hash, reason) {
    this.stats.compactFallbacks++;
    this._log(`[p2p] compact block ${hash.slice(0, 12)} failed (${reason}); requesting in full`);
    this.pendingCompact.delete(hash);
    peer.send('getdata', { items: [{ type: 'block', hash }] });
  }

  /** Drop compact reconstructions whose missing transactions never arrived. */
  _expirePendingCompact() {
    const cutoff = Date.now() - COMPACT_TIMEOUT_MS;
    for (const [hash, pending] of this.pendingCompact) {
      if (pending.at < cutoff) {
        this.pendingCompact.delete(hash);
        if (!pending.peer.socket.destroyed) {
          this._fallbackToFullBlock(pending.peer, hash, 'timed out');
        }
      }
    }
  }

  /** Mempool transactions, the candidate pool for short-id matching. */
  _mempoolTxs() {
    return [...this.node.mempool.txs.values()].map((e) => e.tx);
  }

  // --- block sync (headers first) -------------------------------------------

  /**
   * Ask a peer for the headers that follow the best chain we know. The locator
   * starts from our furthest *header* when a download is already in progress, so
   * successive batches continue rather than restarting at our block tip.
   */
  _requestHeaders(peer) {
    const best = this.headers.best();
    const locator =
      best && best.height > this.node.chain.height()
        ? this.headers.locatorFrom(best)
        : this._buildLocator();
    peer.send('getheaders', { locator });
  }

  _onGetHeaders(peer, payload) {
    const from = this._forkHeightFromLocator(payload) + 1;
    const top = Math.min(this.node.chain.height(), from - 1 + MAX_HEADERS_PER_BATCH);
    const headers = [];
    for (let h = from; h <= top; h++) {
      const entry = this.node.chain.index[h];
      if (entry) headers.push(entry.block.header.toBuffer().toString('hex'));
    }
    peer.send('headers', { headers });
  }

  _onHeaders(peer, payload) {
    const batch = (payload.headers || []).slice(0, MAX_HEADERS_PER_BATCH);
    let added = 0;
    for (const hex of batch) {
      let header;
      try {
        header = sv.BlockHeader.fromBuffer(Buffer.from(hex, 'hex'));
      } catch (e) {
        this._penalize(peer, `undecodable header: ${e.message}`);
        return;
      }
      const res = this.headers.add(header);
      if (res.status === 'bad-pow') {
        this._penalize(peer, `header ${header.hash.slice(0, 12)} fails proof of work`);
        return;
      }
      if (res.status === 'orphan') {
        // The batch does not attach to anything we know. Usually our locator
        // was just stale, so retry once from our own tip — but a peer that
        // keeps sending chains that lead nowhere is wasting our time, and
        // answering it forever would be a request/response loop.
        peer.unconnectingHeaders = (peer.unconnectingHeaders || 0) + 1;
        if (peer.unconnectingHeaders > MAX_UNCONNECTING_HEADERS) {
          this._penalize(peer, 'repeatedly sent headers that connect to nothing');
          return;
        }
        this._log(
          `[p2p] headers from ${peer.id} do not connect ` +
            `(${peer.unconnectingHeaders}/${MAX_UNCONNECTING_HEADERS}); retrying from our tip`
        );
        peer.send('getheaders', { locator: this._buildLocator() });
        return;
      }
      if (res.status === 'added') added++;
    }

    peer.unconnectingHeaders = 0; // this batch attached; forgive earlier misses
    if (added) {
      const best = this.headers.best();
      this._log(
        `[p2p] +${added} headers from ${peer.id}` +
          (best ? ` (best header height ${best.height})` : '')
      );
    }
    // A full batch means the peer has more; keep pulling headers while the
    // bodies for what we already have are downloading.
    if (batch.length >= MAX_HEADERS_PER_BATCH) this._requestHeaders(peer);
    this._requestBodies(peer);
  }

  /**
   * Fetch the next window of block bodies along the best header path. Called
   * whenever headers arrive and after every block is applied, so the in-flight
   * window stays full without ever running unbounded.
   */
  _requestBodies(peer) {
    if (!peer || !peer.handshakeDone || peer.socket.destroyed) return;
    this._expireInFlight();
    const budget = MAX_BLOCKS_IN_FLIGHT - this.inFlight.size;
    if (budget <= 0) return;

    const want = this.headers.missingBodies(budget, this.inFlight);
    if (!want.length) return;

    const at = Date.now();
    for (const hash of want) this.inFlight.set(hash, { peer, at });
    peer.send('getdata', { items: want.map((hash) => ({ type: 'block', hash })) });
  }

  /**
   * Periodic nudge so a download can't die quietly. Sync is normally driven by
   * arriving messages, which means a peer that simply stops replying would
   * leave us stuck; here timed-out requests are released and the window is
   * refilled — from a different peer if the original one is gone.
   */
  _syncTick() {
    if (!this._running) return;
    this._expireInFlight();
    this._expirePendingCompact();
    const ready = [...this.peers].filter((p) => p.handshakeDone && !p.socket.destroyed);
    if (!ready.length) return;

    if (this.headers.best()) {
      // We know of a better chain and still owe ourselves bodies for it.
      for (const peer of ready) {
        this._requestBodies(peer);
        if (this.inFlight.size >= MAX_BLOCKS_IN_FLIGHT) break;
      }
      return;
    }
    // Otherwise ask anyone claiming a longer chain for their headers.
    for (const peer of ready) {
      if (peer.height > this.node.chain.height()) this._requestHeaders(peer);
    }
  }

  /** Drop body requests a peer never answered so another attempt can be made. */
  _expireInFlight() {
    const cutoff = Date.now() - BODY_TIMEOUT_MS;
    for (const [hash, req] of this.inFlight) {
      if (req.at < cutoff || req.peer.socket.destroyed) this.inFlight.delete(hash);
    }
  }

  /** The highest locator hash that is on our active chain (0 = only genesis). */
  _forkHeightFromLocator(payload) {
    if (Array.isArray(payload.locator)) {
      for (const hash of payload.locator) {
        const node = this.node.chain.byHash.get(hash);
        if (node && node.main) return node.height;
      }
    } else if (payload.height != null) {
      return payload.height; // back-compat with the height-only form
    }
    return 0;
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

  /**
   * Serve the pre-headers-first sync protocol. Nothing in this build sends
   * `getblocks` any more, but already-deployed nodes still do, so we keep
   * answering them.
   */
  _onGetBlocks(peer, payload) {
    const from = this._forkHeightFromLocator(payload) + 1;
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
    this._acceptBlock(peer, block);
  }

  /** Apply a block that arrived either whole or rebuilt from a compact sketch. */
  _acceptBlock(peer, block) {
    peer.markKnown(block.id);
    this.inFlight.delete(block.id);
    this.pendingCompact.delete(block.id);

    let res;
    try {
      res = this.node.submitBlock(block);
    } catch (e) {
      this._log(`[p2p] rejected block from ${peer.id}: ${e.message}`);
      this.headers.drop(block.id);
      return;
    }

    switch (res.status) {
      case 'connected':
        this._log(
          `[p2p] connected block ${res.height} ${block.id.slice(0, 12)}` +
            `${res.reorg ? ' (reorg)' : ''} from ${peer.id}`
        );
        break;
      case 'orphan':
        // Missing ancestors — get the headers that lead here first.
        this._requestHeaders(peer);
        break;
      case 'sidechain':
        this._log(`[p2p] stored side-chain block ${block.id.slice(0, 12)} from ${peer.id}`);
        break;
      case 'invalid':
        this.headers.drop(block.id);
        this._penalize(peer, `invalid block ${block.id.slice(0, 12)}: ${res.error}`);
        return;
      default:
        break; // duplicate
    }

    // The body landed: retire its header and pull the next slice of the window.
    this.headers.prune();
    this._requestBodies(peer);
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
