'use strict';

const EventEmitter = require('events');
const sv = require('./sv');
const params = require('./params');
const pow = require('./pow');
const { UTXOSet } = require('./utxoset');
const { buildGenesis } = require('./genesis');
const {
  checkBlockContextual,
  connectBlock,
  ValidationError,
  reverseHex,
} = require('./validation');

const { Block } = sv;
const BN = sv.crypto.BN;

/**
 * The block tree and active chain.
 *
 * Every valid block becomes an index node keyed by its id, carrying its parent
 * link and cumulative chainwork. The *active chain* is the path with the most
 * work; `this.active[h]` is the node at height h on that path and `this.utxo`
 * reflects exactly the outputs it produces.
 *
 * State lives in two places that are kept in lock-step:
 *   - an in-memory working set (byHash tree, active array, UTXO set, undo) for
 *     fast validation and queries, and
 *   - a durable SQLite ChainStore that is the source of truth.
 * On startup the working set is LOADED from the store (no chain replay / re-
 * validation). Every tip change (a simple extension or a multi-block reorg) is
 * written to the store inside ONE atomic transaction, so a crash mid-reorg can
 * never leave inconsistent state.
 *
 * Consumers see one event, `update` { newTip, connected[], disconnected[] },
 * every time the active tip changes.
 */
class Blockchain extends EventEmitter {
  constructor(store, opts = {}) {
    super();
    this.store = store;
    this.utxo = new UTXOSet();
    this.byHash = new Map(); // id -> node
    this.active = []; // active-chain nodes, indexed by height
    this.undo = new Map(); // id -> undo record for active blocks
    this.orphans = new Map(); // parentId -> Block[]
    this.now = opts.now || (() => Math.floor(params.genesisTimestamp));
  }

  get index() {
    return this.active;
  }

  // --- init / load ---------------------------------------------------------

  init() {
    if (this.store.isEmpty()) {
      const g = buildGenesis();
      this._applyGenesis(g);
      this.store.putBlock({
        hash: g.id,
        height: 0,
        prev: null,
        bits: g.header.bits,
        time: g.header.time,
        chainwork: this.active[0].chainwork.toBuffer(),
        main: 1,
        body: g.toBuffer(),
      });
      this.store.setTip(g.id);
      this.emit('ready', { height: 0 });
      return;
    }
    this._loadFromStore();
    this.emit('ready', { height: this.height() });
  }

  /** Rebuild the in-memory working set from the durable store — no replay. */
  _loadFromStore() {
    // 1. Reconstruct every block-tree node.
    for (const row of this.store.allBlocks()) {
      const block = Block.fromBuffer(row.body);
      this.byHash.set(row.hash, {
        hash: row.hash,
        height: row.height,
        prevHash: row.prev,
        bits: row.bits,
        time: row.time,
        chainwork: new BN(row.chainwork),
        block,
        main: !!row.main,
        invalid: !!row.invalid,
      });
    }
    // 2. Rebuild the active chain from the `main` flag (one block per height).
    for (const node of this.byHash.values()) {
      if (node.main) this.active[node.height] = node;
    }
    // 3. Load the UTXO set.
    for (const u of this.store.allUtxos()) {
      this.utxo.add(u.txid, u.vout, {
        satoshis: u.satoshis,
        script: u.script,
        height: u.height,
        coinbase: !!u.coinbase,
      });
    }
    // 4. Load undo records for active (non-genesis) blocks.
    for (let h = 1; h < this.active.length; h++) {
      const node = this.active[h];
      const undo = this.store.getUndo(node.hash);
      if (undo) this.undo.set(node.hash, undo);
    }
    // 5. Sanity: stored tip must equal the reconstructed active tip.
    const storedTip = this.store.getTip();
    if (storedTip && storedTip !== this.tip().hash) {
      throw new Error(
        `chainstate corrupt: stored tip ${storedTip} != active tip ${this.tip().hash}`
      );
    }
  }

  _applyGenesis(block) {
    const node = {
      hash: block.id,
      height: 0,
      prevHash: null,
      bits: block.header.bits,
      time: block.header.time,
      chainwork: pow.getBlockProof(block.header.bits),
      block,
      main: true,
    };
    this.byHash.set(block.id, node);
    this.active[0] = node;
    // Genesis outputs are unspendable and intentionally excluded from the UTXO set.
  }

  // --- accessors -----------------------------------------------------------

  height() {
    return this.active.length - 1;
  }
  tip() {
    return this.active[this.height()];
  }
  getBlock(id) {
    const n = this.byHash.get(id);
    return n ? n.block : undefined;
  }
  getBlockByHeight(h) {
    const n = this.active[h];
    return n ? n.block : undefined;
  }
  getUTXOsForScript(scriptHex) {
    return this.utxo.findByScript(scriptHex);
  }

  _medianTimePastForNode(node) {
    const times = [];
    let n = node;
    for (let i = 0; i < params.medianTimeSpan && n; i++) {
      times.push(n.time);
      n = n.prevHash ? this.byHash.get(n.prevHash) : null;
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  }
  medianTimePast() {
    return this._medianTimePastForNode(this.tip());
  }

  _expectedBitsForParent(parent) {
    if (!params.retargeting) return params.genesisBits;
    const height = parent.height + 1;
    if (height % params.retargetInterval !== 0) return parent.bits;
    const start = height - params.retargetInterval;
    let n = parent;
    while (n && n.height > start) n = this.byHash.get(n.prevHash);
    return pow.nextWorkRequired(parent, n ? n.time : parent.time);
  }
  expectedNextBits() {
    return this._expectedBitsForParent(this.tip());
  }

  // --- block acceptance ----------------------------------------------------

  /**
   * @returns {{status:'connected'|'sidechain'|'orphan'|'duplicate'|'invalid',
   *            id:string, height?:number, reorg?:boolean, error?:string}}
   */
  acceptBlock(block) {
    const id = block.id;
    const existing = this.byHash.get(id);
    if (existing) return { status: 'duplicate', id, height: existing.height };

    const parentId = Buffer.from(block.header.prevHash).reverse().toString('hex');
    const parent = this.byHash.get(parentId);
    if (!parent) {
      this._stashOrphan(parentId, block);
      return { status: 'orphan', id, parent: parentId };
    }
    if (parent.invalid)
      throw new ValidationError('bad-prevblk', 'builds on an invalid block');

    checkBlockContextual(block, {
      prevHash: parent.hash,
      expectedBits: this._expectedBitsForParent(parent),
      medianTimePast: this._medianTimePastForNode(parent),
      now: this.now(),
    });

    const node = {
      hash: id,
      height: parent.height + 1,
      prevHash: parentId,
      bits: block.header.bits,
      time: block.header.time,
      chainwork: parent.chainwork.add(pow.getBlockProof(block.header.bits)),
      block,
      main: false,
    };
    this.byHash.set(id, node);
    // Persist the block body immediately as a side-chain block.
    this.store.putBlock({
      hash: id,
      height: node.height,
      prev: parentId,
      bits: node.bits,
      time: node.time,
      chainwork: node.chainwork.toBuffer(),
      main: 0,
      body: block.toBuffer(),
    });

    let result = { status: 'sidechain', id, height: node.height };

    if (node.chainwork.gt(this.tip().chainwork) && !node.invalid) {
      try {
        const change = this._activateBestChain(node);
        this._persistTipChange(change); // atomic write of the whole tip change
        result = {
          status: 'connected',
          id,
          height: this.height(),
          reorg: change.disconnected.length > 0,
        };
        this.emit('update', {
          newTip: this.tip(),
          connected: change.connected.map((c) => c.node.block),
          disconnected: change.disconnected.map((c) => c.node.block),
        });
      } catch (err) {
        // In-memory chain was restored by _activateBestChain; mark the bad
        // branch invalid durably so it is not retried after a restart.
        if (err.invalidated) {
          for (const hash of err.invalidated) this.store.markInvalid(hash);
        }
        result = { status: 'invalid', id, error: err.message, code: err.code };
      }
    }

    this._processOrphans(id);
    return result;
  }

  // --- fork activation / reorg (in-memory) --------------------------------

  _activateBestChain(newTip) {
    const connectPath = [];
    let node = newTip;
    while (node && !node.main) {
      connectPath.push(node);
      node = this.byHash.get(node.prevHash);
    }
    const forkNode = node;
    connectPath.reverse(); // forkNode+1 .. newTip

    const disconnected = [];
    while (this.tip().hash !== forkNode.hash) {
      disconnected.push(this._disconnectTip());
    }

    const connected = [];
    try {
      for (const n of connectPath) {
        const undo = this._connectTip(n);
        connected.push({ node: n, undo });
      }
    } catch (err) {
      // Roll back the partial connect and restore the original active chain.
      while (this.tip().hash !== forkNode.hash) this._disconnectTip();
      for (const n of connectPath) n.invalid = true;
      for (let i = disconnected.length - 1; i >= 0; i--) {
        this._connectTip(disconnected[i].node);
      }
      err.invalidated = connectPath.map((n) => n.hash);
      throw err;
    }

    return { connected, disconnected };
  }

  /** Connect `node` (parent must be the current tip). Returns its undo record. */
  _connectTip(node) {
    const view = this.utxo.overlay();
    connectBlock(node.block, { height: node.height, view });
    const undo = this._commitWithUndo(view);
    node.main = true;
    this.undo.set(node.hash, undo);
    this.active.push(node);
    return undo;
  }

  /** Remove the active tip, reversing its UTXO changes. Returns {node, undo}. */
  _disconnectTip() {
    const node = this.tip();
    if (node.height === 0) throw new Error('cannot disconnect genesis');
    const undo = this.undo.get(node.hash);
    for (const { key, entry } of undo.spent) this.utxo.map.set(key, entry);
    for (const key of undo.created) this.utxo.map.delete(key);
    node.main = false;
    this.undo.delete(node.hash);
    this.active.pop();
    return { node, undo };
  }

  _commitWithUndo(view) {
    const undo = { spent: [], created: [] };
    for (const key of view.spent) {
      if (view.added.has(key)) continue;
      undo.spent.push({ key, entry: this.utxo.map.get(key) });
    }
    for (const key of view.added.keys()) {
      if (view.spent.has(key)) continue;
      undo.created.push(key);
    }
    view.commit();
    return undo;
  }

  // --- durable tip-change write (atomic) -----------------------------------

  _persistTipChange(change) {
    this.store.transaction(() => {
      // Disconnects first: reverse their UTXO effect in the store.
      for (const { node, undo } of change.disconnected) {
        for (const { key, entry } of undo.spent) {
          const { txid, vout } = splitKey(key);
          this.store.addUtxo(txid, vout, entry);
        }
        for (const key of undo.created) {
          const { txid, vout } = splitKey(key);
          this.store.delUtxo(txid, vout);
        }
        this.store.delUndo(node.hash);
        this.store.setBlockMain(node.hash, 0);
      }
      // Connects: apply their UTXO effect.
      for (const { node, undo } of change.connected) {
        for (const { key } of undo.spent) {
          const { txid, vout } = splitKey(key);
          this.store.delUtxo(txid, vout);
        }
        for (const key of undo.created) {
          const { txid, vout } = splitKey(key);
          this.store.addUtxo(txid, vout, this.utxo.map.get(key));
        }
        this.store.putUndo(node.hash, undo);
        this.store.setBlockMain(node.hash, 1);
      }
      this.store.setTip(this.tip().hash);
    });
  }

  // --- orphan handling -----------------------------------------------------

  _stashOrphan(parentId, block) {
    let list = this.orphans.get(parentId);
    if (!list) {
      list = [];
      this.orphans.set(parentId, list);
    }
    if (!list.some((b) => b.id === block.id)) list.push(block);
    if (this.orphans.size > 500) {
      const oldest = this.orphans.keys().next().value;
      this.orphans.delete(oldest);
    }
  }

  _processOrphans(parentId) {
    const children = this.orphans.get(parentId);
    if (!children) return;
    this.orphans.delete(parentId);
    for (const child of children) {
      try {
        this.acceptBlock(child);
      } catch (_) {
        /* drop invalid orphans */
      }
    }
  }
}

/** "txid:vout" -> { txid, vout } (txid is a fixed 64-char hex string). */
function splitKey(key) {
  const i = key.lastIndexOf(':');
  return { txid: key.slice(0, i), vout: Number(key.slice(i + 1)) };
}

module.exports = { Blockchain };
