'use strict';

const { validateTransaction, ValidationError } = require('./validation');

/**
 * The mempool holds validated, not-yet-mined transactions. Each entry is
 * validated against the current UTXO set plus the outputs created by other
 * in-pool transactions (so chains of unconfirmed txs are accepted).
 */
class Mempool {
  constructor(chain) {
    this.chain = chain;
    this.txs = new Map(); // txid -> { tx, fee, size }
    // outpoints spent by pool txs, to reject in-pool double spends
    this.spent = new Map(); // "txid:vout" -> spending txid
  }

  has(txid) {
    return this.txs.has(txid);
  }

  get(txid) {
    const e = this.txs.get(txid);
    return e ? e.tx : undefined;
  }

  size() {
    return this.txs.size;
  }

  /** A UTXO view = confirmed set + outputs from txs already in the pool. */
  _poolView() {
    const view = this.chain.utxo.overlay();
    for (const { tx } of this.txs.values()) {
      const txid = tx.hash;
      tx.outputs.forEach((out, vout) => {
        view.add(txid, vout, {
          satoshis: out.satoshis,
          script: out.script.toHex(),
          height: this.chain.height() + 1,
          coinbase: false,
        });
      });
    }
    return view;
  }

  /**
   * Accept a transaction into the pool.
   * @returns {{ txid:string, fee:number }}
   * @throws {ValidationError}
   */
  accept(tx) {
    const txid = tx.hash;
    if (this.txs.has(txid))
      throw new ValidationError('txn-already-in-mempool');
    if (tx.isCoinbase())
      throw new ValidationError('coinbase', 'coinbase not allowed in mempool');

    // Reject if any input is already spent by another pool tx.
    for (const input of tx.inputs) {
      const key = input.prevTxId.toString('hex') + ':' + input.outputIndex;
      if (this.spent.has(key))
        throw new ValidationError(
          'txn-mempool-conflict',
          `input ${key} already spent in mempool`
        );
    }

    const view = this._poolView();
    const { fee } = validateTransaction(tx, view, this.chain.height() + 1);

    const size = tx.toBuffer().length;
    this.txs.set(txid, { tx, fee, size });
    for (const input of tx.inputs) {
      const key = input.prevTxId.toString('hex') + ':' + input.outputIndex;
      this.spent.set(key, txid);
    }
    return { txid, fee };
  }

  /** Drop every transaction from the pool. */
  clear() {
    this.txs.clear();
    this.spent.clear();
  }

  /** Remove a tx (e.g. once mined) and free its spent outpoints. */
  remove(txid) {
    const entry = this.txs.get(txid);
    if (!entry) return;
    for (const input of entry.tx.inputs) {
      const key = input.prevTxId.toString('hex') + ':' + input.outputIndex;
      this.spent.delete(key);
    }
    this.txs.delete(txid);
  }

  /**
   * After a block connects, drop mined txs and any now-invalid ones (their
   * inputs may have been consumed). Remaining txs are re-checked lazily.
   */
  reconcile(minedTxids) {
    for (const txid of minedTxids) this.remove(txid);
    // Revalidate the rest; drop any that no longer apply.
    const survivors = [...this.txs.values()].map((e) => e.tx);
    this.txs.clear();
    this.spent.clear();
    for (const tx of survivors) {
      try {
        this.accept(tx);
      } catch (_) {
        /* silently drop txs invalidated by the new block */
      }
    }
  }

  /** Fee-rate-ordered transactions for block assembly. */
  orderedForBlock() {
    return [...this.txs.values()]
      .sort((a, b) => b.fee / b.size - a.fee / a.size)
      .map((e) => e.tx);
  }
}

module.exports = { Mempool };
