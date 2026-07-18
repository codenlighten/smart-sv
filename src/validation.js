'use strict';

const sv = require('./sv');
const params = require('./params');
const pow = require('./pow');
const { getBlockSubsidy } = require('./consensus');

const { Transaction, Script, crypto } = sv;
const Interpreter = Script.Interpreter;
const BN = crypto.BN;

/** Standard SmartSV script-verification flags (incl. SIGHASH_FORKID). */
const SCRIPT_FLAGS =
  Interpreter.SCRIPT_VERIFY_P2SH |
  Interpreter.SCRIPT_VERIFY_STRICTENC |
  Interpreter.SCRIPT_VERIFY_DERSIG |
  Interpreter.SCRIPT_VERIFY_LOW_S |
  Interpreter.SCRIPT_VERIFY_NULLFAIL |
  Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID;

class ValidationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** Context-free sanity checks on a single transaction. */
function checkTransactionSanity(tx) {
  if (!tx.inputs.length) throw new ValidationError('bad-txns-vin-empty');
  if (!tx.outputs.length) throw new ValidationError('bad-txns-vout-empty');

  let totalOut = 0;
  for (const out of tx.outputs) {
    if (out.satoshis < 0) throw new ValidationError('bad-txns-vout-negative');
    if (out.satoshis > params.maxMoney)
      throw new ValidationError('bad-txns-vout-toolarge');
    totalOut += out.satoshis;
    if (totalOut > params.maxMoney)
      throw new ValidationError('bad-txns-txouttotal-toolarge');
  }

  // Detect duplicate inputs (spending the same outpoint twice in one tx).
  const seen = new Set();
  for (const inp of tx.inputs) {
    const key = inp.prevTxId.toString('hex') + ':' + inp.outputIndex;
    if (seen.has(key)) throw new ValidationError('bad-txns-inputs-duplicate');
    seen.add(key);
  }
  return true;
}

/**
 * Validate a non-coinbase transaction against a UTXO view.
 * Returns { fee }. Throws ValidationError on any failure.
 *
 * @param {Transaction} tx
 * @param {UTXOView|UTXOSet} view
 * @param {number} spendHeight  height at which this tx would be included
 */
function validateTransaction(tx, view, spendHeight) {
  checkTransactionSanity(tx);
  if (tx.isCoinbase())
    throw new ValidationError('unexpected-coinbase', 'coinbase in tx context');

  let valueIn = 0;
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i];
    const txid = input.prevTxId.toString('hex');
    const vout = input.outputIndex;
    const utxo = view.get(txid, vout);
    if (!utxo)
      throw new ValidationError(
        'bad-txns-inputs-missingorspent',
        `input ${i} spends missing/spent output ${txid}:${vout}`
      );

    // Coinbase maturity.
    if (utxo.coinbase && spendHeight - utxo.height < params.coinbaseMaturity) {
      throw new ValidationError(
        'bad-txns-premature-spend-of-coinbase',
        `coinbase spent at depth ${spendHeight - utxo.height} < ${params.coinbaseMaturity}`
      );
    }

    valueIn += utxo.satoshis;
    if (valueIn > params.maxMoney)
      throw new ValidationError('bad-txns-inputvalues-outofrange');

    // Full script verification (unlocking script vs. the referenced locking script).
    const interp = new Interpreter();
    const ok = interp.verify(
      input.script,
      Script.fromHex(utxo.script),
      tx,
      i,
      SCRIPT_FLAGS,
      new BN(utxo.satoshis)
    );
    if (!ok)
      throw new ValidationError(
        'mandatory-script-verify-flag-failed',
        `input ${i} script failed: ${interp.errstr}`
      );
  }

  const valueOut = tx.outputs.reduce((s, o) => s + o.satoshis, 0);
  if (valueIn < valueOut)
    throw new ValidationError(
      'bad-txns-in-belowout',
      `inputs ${valueIn} < outputs ${valueOut}`
    );

  const fee = valueIn - valueOut;
  if (fee > params.maxMoney)
    throw new ValidationError('bad-txns-fee-outofrange');

  return { fee };
}

/**
 * Contextual block checks that need only the block and its parent context —
 * NO UTXO state. Safe to run for any block (active-chain or side-chain) as soon
 * as its parent is known. Covers PoW, difficulty bits, prevHash link, timestamp
 * rules, coinbase structure, merkle root and size.
 *
 * @param {Block} block
 * @param {object} ctx  { prevHash, medianTimePast, expectedBits, now }
 */
function checkBlockContextual(block, ctx) {
  const header = block.header;
  const txs = block.transactions;

  if (!pow.checkProofOfWork(header))
    throw new ValidationError('high-hash', 'proof of work failed');
  if (ctx.expectedBits != null && header.bits !== ctx.expectedBits)
    throw new ValidationError('bad-diffbits', 'incorrect difficulty bits');
  if (header.prevHash.toString('hex') !== reverseHex(ctx.prevHash))
    throw new ValidationError('bad-prevblk', 'prevHash mismatch');

  if (ctx.medianTimePast != null && header.time <= ctx.medianTimePast)
    throw new ValidationError('time-too-old');
  if (header.time > ctx.now + params.maxFutureBlockTimeSec)
    throw new ValidationError('time-too-new');

  if (!txs.length) throw new ValidationError('bad-blk-length', 'no transactions');
  if (!txs[0].isCoinbase())
    throw new ValidationError('bad-cb-missing', 'first tx not coinbase');
  for (let i = 1; i < txs.length; i++) {
    if (txs[i].isCoinbase())
      throw new ValidationError('bad-cb-multiple', 'multiple coinbases');
  }
  if (!block.validMerkleRoot())
    throw new ValidationError('bad-txnmrklroot', 'merkle root mismatch');
  if (block.toBuffer().length > params.maxBlockSize)
    throw new ValidationError('bad-blk-length', 'block too large');
}

/**
 * Connect-time validation: apply every transaction to the UTXO view, running
 * full script/signature checks and enforcing the coinbase value. Mutates
 * `ctx.view` (an overlay) so the caller can derive undo data and commit.
 *
 * @param {Block} block
 * @param {object} ctx  { height, view }
 * @returns {{ totalFees:number, subsidy:number }}
 */
function connectBlock(block, ctx) {
  const txs = block.transactions;
  const view = ctx.view;
  const height = ctx.height;
  let totalFees = 0;
  const seenTxids = new Set();

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    const txid = tx.hash;
    if (seenTxids.has(txid)) throw new ValidationError('bad-txns-duplicate');
    seenTxids.add(txid);

    if (i === 0) {
      checkTransactionSanity(tx); // coinbase: value checked after fees are summed
    } else {
      const { fee } = validateTransaction(tx, view, height);
      totalFees += fee;
      for (const input of tx.inputs) {
        view.spend(input.prevTxId.toString('hex'), input.outputIndex);
      }
    }
    tx.outputs.forEach((out, vout) => {
      view.add(txid, vout, {
        satoshis: out.satoshis,
        script: out.script.toHex(),
        height,
        coinbase: i === 0,
      });
    });
  }

  const subsidy = getBlockSubsidy(height);
  const coinbaseOut = txs[0].outputs.reduce((s, o) => s + o.satoshis, 0);
  if (coinbaseOut > subsidy + totalFees)
    throw new ValidationError(
      'bad-cb-amount',
      `coinbase pays ${coinbaseOut} > subsidy ${subsidy} + fees ${totalFees}`
    );

  return { totalFees, subsidy };
}

/**
 * Convenience wrapper: contextual checks followed by a full connect against
 * `chainCtx.view`. Kept for direct/single-shot validation and tests.
 */
function validateBlock(block, chainCtx) {
  checkBlockContextual(block, chainCtx);
  return connectBlock(block, chainCtx);
}

/** sv stores prevHash reversed relative to a block id string. */
function reverseHex(hex) {
  return Buffer.from(hex, 'hex').reverse().toString('hex');
}

module.exports = {
  ValidationError,
  SCRIPT_FLAGS,
  checkTransactionSanity,
  validateTransaction,
  checkBlockContextual,
  connectBlock,
  validateBlock,
  reverseHex,
};
