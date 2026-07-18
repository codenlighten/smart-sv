'use strict';

const sv = require('./sv');
const params = require('./params');
const pow = require('./pow');
const { getBlockSubsidy, buildCoinbase } = require('./consensus');

const { Block } = sv;

/**
 * Assemble a candidate block from the mempool and mine it (grind PoW nonce).
 *
 * @param {Blockchain} chain
 * @param {Mempool} mempool
 * @param {Address|string} rewardAddress
 * @param {object} [opts] { now, extraNonce, coinbaseData, maxTries }
 * @returns {{ block: Block, fees:number, subsidy:number, tries:number }}
 */
function mineBlock(chain, mempool, rewardAddress, opts = {}) {
  const tip = chain.tip();
  const height = tip.height + 1;

  // Select transactions (highest fee-rate first) that still validate together.
  const candidateTxs = mempool.orderedForBlock();
  const included = [];
  let fees = 0;
  const view = chain.utxo.overlay();
  const { validateTransaction } = require('./validation');
  for (const tx of candidateTxs) {
    try {
      const { fee } = validateTransaction(tx, view, height);
      // stage the tx into the view so dependent txs can follow
      for (const input of tx.inputs)
        view.spend(input.prevTxId.toString('hex'), input.outputIndex);
      tx.outputs.forEach((o, vout) =>
        view.add(tx.hash, vout, {
          satoshis: o.satoshis,
          script: o.script.toHex(),
          height,
          coinbase: false,
        })
      );
      included.push(tx);
      fees += fee;
    } catch (_) {
      /* skip txs that don't fit this block */
    }
  }

  const subsidy = getBlockSubsidy(height);
  const coinbase = buildCoinbase(
    height,
    subsidy + fees,
    rewardAddress,
    opts.extraNonce,
    opts.coinbaseData
  );

  const transactions = [coinbase, ...included];

  // Strictly-increasing timestamp so rapid mining never trips time-too-old.
  const clockNow = opts.now != null ? opts.now : chain.now();
  const time = Math.max(clockNow, tip.time + 1);

  const block = new Block({
    header: {
      version: 1,
      prevHash: Buffer.from(tip.hash, 'hex').reverse(),
      merkleRoot: Buffer.alloc(32, 0),
      time,
      bits: chain.expectedNextBits(),
      nonce: 0,
    },
    transactions,
  });

  // Fix the merkle root, then grind PoW.
  block.header.merkleRoot = block.getMerkleRoot();
  const result = pow.mine(block.header, { maxTries: opts.maxTries });
  if (!result.found) {
    return { block: null, fees, subsidy, tries: result.tries };
  }

  return { block, fees, subsidy, tries: result.tries };
}

module.exports = { mineBlock };
