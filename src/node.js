'use strict';

const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const sv = require('./sv');
require('./network'); // register the SmartSV network with sv

const params = require('./params');
const { ChainStore } = require('./store/chainstore');
const { Blockchain } = require('./blockchain');
const { Mempool } = require('./mempool');
const { mineBlock } = require('./miner');
const { ValidationError } = require('./validation');

const { Transaction } = sv;

/**
 * A full SmartSV node: chain state, mempool, and a built-in miner, exposed
 * through a small programmatic API. The REST/WS server (src/api/server.js) and
 * the CLI are thin wrappers over these methods. A future P2P layer would drive
 * the same `submitTransaction` / `submitBlock` entry points.
 */
class Node extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.params = params;
    this.dataDir =
      opts.dataDir || path.join(os.homedir(), '.smartsv');
    this.store = new ChainStore(this.dataDir);
    const clock =
      opts.now || (() => Math.floor(Date.now() / 1000));
    this.chain = new Blockchain(this.store, {
      now: clock,
      pruneDepth: opts.pruneDepth,
      pruneInterval: opts.pruneInterval,
    });
    this.mempool = new Mempool(this.chain);
    this._clock = clock;

    // Every active-tip change (simple extension OR reorg) arrives as a single
    // `update`. Reconcile the mempool, then re-emit `block` for the new tip.
    this.chain.on('update', ({ newTip, connected, disconnected }) => {
      this._reconcileMempool(connected, disconnected);
      this.emit('block', {
        block: newTip.block,
        height: newTip.height,
        reorg: disconnected.length > 0,
      });
    });
  }

  /**
   * Rebuild the mempool after the active chain changes. Transactions from
   * disconnected blocks (minus coinbases) become candidates again; transactions
   * included in connected blocks are dropped; everything is re-validated against
   * the new UTXO set, and anything no longer valid is discarded.
   */
  _reconcileMempool(connected, disconnected) {
    const minedTxids = new Set();
    for (const block of connected)
      for (const tx of block.transactions) minedTxids.add(tx.hash);

    const returning = [];
    for (const block of disconnected)
      for (const tx of block.transactions.slice(1)) returning.push(tx); // skip coinbase

    const survivors = [...this.mempool.txs.values()].map((e) => e.tx).concat(returning);
    this.mempool.clear();
    for (const tx of survivors) {
      if (minedTxids.has(tx.hash)) continue;
      try {
        this.mempool.accept(tx);
      } catch (_) {
        /* drop txs invalidated by the new chain */
      }
    }
  }

  start() {
    this.chain.init(); // bootstraps genesis, or loads persisted chainstate
    this.emit('started', this.info());
    return this;
  }

  /** Release the durable store (flushes WAL). */
  close() {
    if (this.store && this.store.close) this.store.close();
  }

  now() {
    return this._clock();
  }

  // --- Chain queries -------------------------------------------------------

  info() {
    const tip = this.chain.tip();
    return {
      chain: params.chainName,
      network: params.name,
      height: this.chain.height(),
      tip: tip.hash,
      bits: tip.bits.toString(16),
      difficulty: this.chain.getBlockByHeight(tip.height)
        ? this.chain.getBlockByHeight(tip.height).header.getDifficulty()
        : 1,
      mempool: this.mempool.size(),
      utxos: this.chain.utxo.size,
      supply: this.chain.utxo.totalValue(),
      medianTime: this.chain.medianTimePast(),
      blocksIndexed: this.chain.byHash.size,
      prunedSideChainBlocks: this.chain.prunedCount,
      undoRecords: this.chain.undo.size,
      prunedUndoRecords: this.chain.prunedUndoCount,
    };
  }

  getBlock(idOrHeight) {
    if (/^\d+$/.test(String(idOrHeight))) {
      return this.chain.getBlockByHeight(Number(idOrHeight));
    }
    return this.chain.getBlock(idOrHeight);
  }

  getTransaction(txid) {
    // Search mempool then scan blocks (MVP: no tx index).
    const memp = this.mempool.get(txid);
    if (memp) return { tx: memp, confirmations: 0 };
    for (let h = this.chain.height(); h >= 0; h--) {
      const block = this.chain.getBlockByHeight(h);
      const tx = block.transactions.find((t) => t.hash === txid);
      if (tx)
        return { tx, blockHeight: h, confirmations: this.chain.height() - h + 1 };
    }
    return null;
  }

  /** Confirmed spendable UTXOs for an address. */
  getUTXOs(address) {
    const script = sv.Script.buildPublicKeyHashOut(address).toHex();
    return this.chain.getUTXOsForScript(script).map((u) => ({
      txid: u.txid,
      outputIndex: u.vout,
      script: u.script,
      satoshis: u.satoshis,
      height: u.height,
      coinbase: u.coinbase,
      confirmations: this.chain.height() - u.height + 1,
    }));
  }

  getBalance(address) {
    return this.getUTXOs(address).reduce((s, u) => s + u.satoshis, 0);
  }

  // --- Mutations -----------------------------------------------------------

  /** Accept a transaction into the mempool. @returns {{txid, fee}} */
  submitTransaction(txOrHex) {
    const tx =
      typeof txOrHex === 'string' ? new Transaction(txOrHex) : txOrHex;
    const res = this.mempool.accept(tx);
    this.emit('tx', { txid: res.txid, fee: res.fee });
    return res;
  }

  /** Accept an externally-produced (e.g. P2P) block. */
  submitBlock(blockOrHex) {
    const block =
      typeof blockOrHex === 'string'
        ? new sv.Block(Buffer.from(blockOrHex, 'hex'))
        : blockOrHex;
    return this.chain.acceptBlock(block);
  }

  /** Mine one block to `rewardAddress`, including current mempool txs. */
  mine(rewardAddress, opts = {}) {
    const { block, fees, subsidy, tries } = mineBlock(
      this.chain,
      this.mempool,
      rewardAddress,
      { now: this.now(), ...opts }
    );
    if (!block) throw new Error('mining failed (maxTries exhausted)');
    const { height, id } = this.chain.acceptBlock(block);
    return { height, id, fees, subsidy, reward: subsidy + fees, tries, block };
  }
}

module.exports = { Node, ValidationError };
