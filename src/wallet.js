'use strict';

const sv = require('./sv');
require('./network');

const { PrivateKey, Transaction } = sv;

/**
 * A minimal client-side wallet: key handling plus transaction construction
 * using the SmartSV primitives library. It knows nothing about the chain except
 * the UTXOs it is handed, so it works identically against a local Node or the
 * remote REST API.
 */
const Wallet = {
  /** Generate a new key. Returns { wif, address, publicKey }. */
  newKey() {
    const priv = new PrivateKey();
    return {
      wif: priv.toWIF(),
      address: priv.toAddress().toString(),
      publicKey: priv.toPublicKey().toString(),
    };
  },

  fromWIF(wif) {
    const priv = new PrivateKey(wif);
    return { priv, address: priv.toAddress() };
  },

  /**
   * Build & sign a payment.
   * @param {string} wif
   * @param {Array} utxos   from Node.getUTXOs / REST /address/:a/utxos
   * @param {string} toAddress
   * @param {number} satoshis
   * @param {object} [opts]  { data: string|Buffer for OP_RETURN }
   * @returns {Transaction}
   */
  buildPayment(wif, utxos, toAddress, satoshis, opts = {}) {
    const { priv, address } = Wallet.fromWIF(wif);
    const tx = new Transaction();
    for (const u of utxos) {
      tx.from({
        txId: u.txid,
        outputIndex: u.outputIndex,
        script: u.script,
        satoshis: u.satoshis,
      });
    }
    tx.to(toAddress, satoshis);
    if (opts.data != null) tx.addData(opts.data);
    tx.change(address);
    tx.sign(priv);
    return tx;
  },

  /** Build & sign a data-only (OP_RETURN) transaction. */
  buildData(wif, utxos, data) {
    const { priv, address } = Wallet.fromWIF(wif);
    const tx = new Transaction();
    for (const u of utxos)
      tx.from({ txId: u.txid, outputIndex: u.outputIndex, script: u.script, satoshis: u.satoshis });
    tx.addData(data);
    tx.change(address);
    tx.sign(priv);
    return tx;
  },

  /** Greedily pick UTXOs covering `target` + a fee estimate. */
  selectUTXOs(utxos, target, feeReserve = 1000) {
    const sorted = [...utxos].sort((a, b) => b.satoshis - a.satoshis);
    const picked = [];
    let sum = 0;
    for (const u of sorted) {
      picked.push(u);
      sum += u.satoshis;
      if (sum >= target + feeReserve) break;
    }
    if (sum < target + feeReserve)
      throw new Error(`insufficient funds: have ${sum}, need ~${target + feeReserve}`);
    return picked;
  },
};

module.exports = { Wallet };
