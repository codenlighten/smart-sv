'use strict';

const net = require('net');
const EventEmitter = require('events');
const sv = require('../sv');
const params = require('../params');
const { Peer } = require('./peer');

const PROTOCOL_VERSION = 1;
const MAX_INV_PER_BATCH = 500; // block hashes announced per getblocks response
const PING_INTERVAL_MS = 30000;

/**
 * PeerManager: the SmartSV P2P network layer.
 *
 * Responsibilities:
 *   - accept inbound and dial outbound TCP connections
 *   - version/verack handshake (with self-connection detection)
 *   - initial block download: getblocks → inv → getdata → block, applied in order
 *   - inv/getdata gossip relay of new blocks and transactions, wired to the
 *     node's `block`/`tx` events
 *   - a small address book with getaddr/addr exchange
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
    this.peers = new Set();
    this.addrBook = new Map(); // "host:port" -> lastSeen (epoch sec)
    this.server = null;
    this.nonce = sv.crypto.Random.getRandomBuffer(8).toString('hex');
    this._pingTimer = null;
    this._log = opts.log || (() => {});
  }

  // --- lifecycle ----------------------------------------------------------

  start() {
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
    return this;
  }

  stop() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    for (const peer of this.peers) peer.destroy();
    this.peers.clear();
    if (this.server) this.server.close();
  }

  /** Dial a peer at "host:port" (or {host, port}). */
  connect(target) {
    const { host, port } = normalizeAddr(target);
    const socket = net.connect({ host, port }, () => {
      this._log(`[p2p] connected out to ${host}:${port}`);
    });
    socket.on('error', (e) => this._log(`[p2p] dial ${host}:${port} failed: ${e.message}`));
    this._addPeer(socket, false, `${host}:${port}`);
  }

  peerCount() {
    return this.peers.size;
  }

  // --- peer wiring --------------------------------------------------------

  _addPeer(socket, inbound, addrKey) {
    if (this.peers.size >= this.maxPeers) {
      socket.destroy();
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
      peer.destroy();
      return;
    }
    peer.versionReceived = true;
    peer.height = payload.height || 0;
    peer.userAgent = payload.userAgent;
    peer.remoteNonce = payload.nonce;
    if (payload.port && peer.socket.remoteAddress) {
      this._noteAddr(`${cleanHost(peer.socket.remoteAddress)}:${payload.port}`);
    }
    peer.send('verack', {});
  }

  _onVerack(peer) {
    if (peer.handshakeDone) return;
    peer.handshakeDone = true;
    this._log(`[p2p] handshake done with ${peer.id} (their height ${peer.height})`);
    this.emit('peer', peer);

    // Learn about more peers, and start syncing if this peer is ahead.
    peer.send('getaddr', {});
    if (peer.height > this.node.chain.height()) this._requestBlocks(peer);
  }

  // --- address book --------------------------------------------------------

  _onGetAddr(peer) {
    const addrs = [...this.addrBook.keys()].slice(0, 1000);
    peer.send('addr', { addrs });
  }

  _onAddr(peer, payload) {
    for (const a of payload.addrs || []) this._noteAddr(a);
  }

  _noteAddr(addrKey) {
    if (!addrKey || addrKey.startsWith('undefined')) return;
    this.addrBook.set(addrKey, this.node.now());
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
      this._log(`[p2p] undecodable block from ${peer.id}: ${e.message}`);
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
        this._log(`[p2p] invalid block ${block.id.slice(0, 12)} from ${peer.id}: ${res.error}`);
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
