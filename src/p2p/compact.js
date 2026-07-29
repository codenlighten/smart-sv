'use strict';

const sv = require('../sv');

/**
 * Compact block relay.
 *
 * A node that has been relaying transactions already holds most of the next
 * block in its mempool, so shipping those transactions again is pure waste —
 * and with 32 MB blocks it is a lot of waste. Instead the announcer sends a
 * *sketch*: the 80-byte header, a nonce, one short id per transaction, and the
 * coinbase (which no peer can have) prefilled. The receiver matches the short
 * ids against its mempool, and only asks for the transactions it is actually
 * missing.
 *
 * Short ids are 6 bytes of `sha256(key || txid)`, where the key is derived from
 * the header and a per-announcement nonce. The nonce matters: it means two
 * peers compute different short ids for the same block, so an attacker cannot
 * search for a transaction pair that collides for everyone at once. A collision
 * still yields a wrong transaction set, which is why reconstruction is only
 * accepted if the rebuilt block's merkle root matches the header — the same
 * check that makes this safe rather than merely fast.
 *
 * This is BIP152 in spirit, not on the wire: SmartSV's protocol is its own, and
 * the messages here are JSON like the rest of the control plane.
 */

const SHORT_ID_BYTES = 6;

/** Per-announcement key binding short ids to this header and nonce. */
function shortIdKey(header, nonce) {
  const headerBuf = Buffer.isBuffer(header) ? header : header.toBuffer();
  const nonceBuf = Buffer.from(String(nonce), 'utf8');
  return sv.crypto.Hash.sha256(Buffer.concat([headerBuf, nonceBuf]));
}

/** The short id of a transaction under `key`. */
function shortId(key, txid) {
  const digest = sv.crypto.Hash.sha256(Buffer.concat([key, Buffer.from(txid, 'hex')]));
  return digest.slice(0, SHORT_ID_BYTES).toString('hex');
}

/** Index candidate transactions (typically the mempool) by short id. */
function shortIdTable(key, txs) {
  const table = new Map();
  for (const tx of txs) table.set(shortId(key, tx.hash), tx);
  return table;
}

/**
 * Build the compact announcement for a block.
 * @param {Block} block
 * @param {string} nonce  per-announcement, per-peer
 */
function buildCompact(block, nonce) {
  const key = shortIdKey(block.header, nonce);
  const shortids = [];
  const prefilled = [];
  block.transactions.forEach((tx, index) => {
    // The coinbase is unique to this block, so no peer can have it: send it.
    if (index === 0) prefilled.push({ index, tx: tx.toBuffer().toString('hex') });
    else shortids.push(shortId(key, tx.hash));
  });
  return {
    header: block.header.toBuffer().toString('hex'),
    nonce,
    shortids,
    prefilled,
  };
}

/**
 * Slot the transactions we can find into their positions in the block.
 *
 * @param {object} compact   a decoded cmpctblock payload
 * @param {Iterable<Transaction>} available  candidate txs (the mempool)
 * @returns {{header, slots:Array<Transaction|null>, missing:number[]}}
 * @throws if the payload is malformed
 */
function reconstruct(compact, available) {
  const header = sv.BlockHeader.fromBuffer(Buffer.from(compact.header, 'hex'));
  const shortids = compact.shortids || [];
  const prefilled = compact.prefilled || [];
  const total = shortids.length + prefilled.length;
  if (total === 0) throw new Error('empty compact block');

  const slots = new Array(total).fill(null);
  for (const entry of prefilled) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= total) {
      throw new Error('prefilled index out of range');
    }
    slots[entry.index] = new sv.Transaction(Buffer.from(entry.tx, 'hex'));
  }

  const table = shortIdTable(shortIdKey(header, compact.nonce), available);
  const missing = [];
  let next = 0;
  for (let i = 0; i < total; i++) {
    if (slots[i]) continue;
    const tx = table.get(shortids[next++]);
    if (tx) slots[i] = tx;
    else missing.push(i);
  }
  return { header, slots, missing };
}

/**
 * Assemble a block from filled slots. Returns null when the result doesn't
 * match the header's merkle root — i.e. a short id collided, or a peer sent
 * transactions that don't belong — in which case the caller must fall back to
 * requesting the block in full.
 */
function assemble(header, slots) {
  if (slots.some((s) => !s)) return null;
  const block = new sv.Block({ header, transactions: slots });
  return block.validMerkleRoot() ? block : null;
}

module.exports = {
  SHORT_ID_BYTES,
  shortIdKey,
  shortId,
  shortIdTable,
  buildCompact,
  reconstruct,
  assemble,
};
