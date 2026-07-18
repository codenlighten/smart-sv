'use strict';

const sv = require('./sv');
const params = require('./params');
const pow = require('./pow');
const { getBlockSubsidy } = require('./consensus');

const { Transaction, Script, Block, BlockHeader, crypto } = sv;

/**
 * Deterministically construct (and PoW-mine) the SmartSV genesis block.
 *
 * The genesis coinbase embeds `params.genesisMessage`, and its single output is
 * an unspendable OP_RETURN so no premine exists. Because inputs/outputs and the
 * timestamp are fixed, every node computes the identical genesis hash.
 */
let _cached = null;

function buildGenesis() {
  if (_cached) return _cached;

  const coinbase = new Transaction();
  coinbase.uncheckedAddInput(
    new Transaction.Input({
      prevTxId: Buffer.alloc(32, 0),
      outputIndex: 0xffffffff,
      script: new Script().add(Buffer.from(params.genesisMessage, 'utf8')),
      sequenceNumber: 0xffffffff,
    })
  );
  // Genesis reward is provably unspendable (no premine).
  coinbase.addOutput(
    new Transaction.Output({
      script: Script.buildDataOut('SmartSV genesis'),
      satoshis: 0,
    })
  );

  const merkleRoot = crypto.Hash.sha256sha256(coinbase.toBuffer());

  const header = new BlockHeader({
    version: 1,
    prevHash: Buffer.alloc(32, 0),
    merkleRoot: Buffer.from(merkleRoot), // reversed handling done by lib
    time: params.genesisTimestamp,
    bits: params.genesisBits,
    nonce: 0,
  });

  // Mine genesis (instant at the default low difficulty).
  pow.mine(header);

  const block = new Block({
    header: header.toObject(),
    transactions: [coinbase],
  });

  _cached = block;
  return block;
}

module.exports = { buildGenesis };
