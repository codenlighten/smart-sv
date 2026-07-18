'use strict';

/**
 * The UTXO set: the authoritative record of every unspent transaction output.
 * Keyed by "txid:vout". Values carry enough to validate a spend against them.
 */
class UTXOSet {
  constructor() {
    this.map = new Map();
  }

  static key(txid, vout) {
    return txid + ':' + vout;
  }

  get(txid, vout) {
    return this.map.get(UTXOSet.key(txid, vout));
  }

  has(txid, vout) {
    return this.map.has(UTXOSet.key(txid, vout));
  }

  /**
   * @param {string} txid
   * @param {number} vout
   * @param {{satoshis:number, script:string, height:number, coinbase:boolean}} entry
   */
  add(txid, vout, entry) {
    this.map.set(UTXOSet.key(txid, vout), entry);
  }

  remove(txid, vout) {
    return this.map.delete(UTXOSet.key(txid, vout));
  }

  get size() {
    return this.map.size;
  }

  /** Total satoshis currently held in the set (chain's circulating supply). */
  totalValue() {
    let total = 0;
    for (const e of this.map.values()) total += e.satoshis;
    return total;
  }

  /** All UTXOs locked to a given output-script hex (used for balance queries). */
  findByScript(scriptHex) {
    const out = [];
    for (const [k, e] of this.map.entries()) {
      if (e.script === scriptHex) {
        const [txid, vout] = k.split(':');
        out.push({ txid, vout: Number(vout), ...e });
      }
    }
    return out;
  }

  /**
   * A lightweight, layered view for validating a block without mutating the
   * base set until the whole block is known-good. Reads fall through to the
   * base set; spends/creates are staged in overlays and can be committed.
   */
  overlay() {
    return new UTXOView(this);
  }
}

class UTXOView {
  constructor(base) {
    this.base = base;
    this.added = new Map(); // key -> entry
    this.spent = new Set(); // key
  }

  get(txid, vout) {
    const key = UTXOSet.key(txid, vout);
    if (this.spent.has(key)) return undefined;
    if (this.added.has(key)) return this.added.get(key);
    return this.base.get(txid, vout);
  }

  has(txid, vout) {
    return this.get(txid, vout) !== undefined;
  }

  spend(txid, vout) {
    this.spent.add(UTXOSet.key(txid, vout));
  }

  add(txid, vout, entry) {
    this.added.set(UTXOSet.key(txid, vout), entry);
  }

  /** Apply all staged changes to the base UTXO set. */
  commit() {
    for (const key of this.spent) {
      const [txid, vout] = key.split(':');
      // A UTXO created and spent within the same block never touches base.
      if (this.added.has(key)) this.added.delete(key);
      else this.base.map.delete(key);
    }
    for (const [key, entry] of this.added) {
      this.base.map.set(key, entry);
    }
  }
}

module.exports = { UTXOSet, UTXOView };
