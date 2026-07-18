'use strict';

const sv = require('./sv');
const params = require('./params');

const { Transaction, Script, Opcode } = sv;

/** Block subsidy (reward, excluding fees) at a given height, with halvings. */
function getBlockSubsidy(height) {
  const halvings = Math.floor(height / params.halvingInterval);
  if (halvings >= 64) return 0;
  // integer right-shift of the subsidy
  return Math.floor(params.initialSubsidy / Math.pow(2, halvings));
}

/**
 * Build a coinbase transaction paying `address`.
 *
 * @param {number} height  block height (embedded per BIP34)
 * @param {number} value   total coinbase value = subsidy + fees
 * @param {Address|string} address  reward recipient
 * @param {Buffer} [extraNonce]  extra entropy for the mining search space
 * @param {Buffer|string} [dataTag]  optional OP_RETURN data in the coinbase
 */
function buildCoinbase(height, value, address, extraNonce, dataTag) {
  const tx = new Transaction();

  // BIP34: height as the first push in the coinbase scriptSig, followed by the
  // chain flag and an extra nonce for the miner's search space.
  const heightBuf = scriptNumFromHeight(height);
  const flag = Buffer.from(params.coinbaseFlag, 'utf8');
  const extra = extraNonce || Buffer.alloc(8, 0);
  const scriptSig = new Script()
    .add(heightBuf)
    .add(flag)
    .add(extra);

  tx.uncheckedAddInput(
    new Transaction.Input({
      prevTxId: Buffer.alloc(32, 0),
      outputIndex: 0xffffffff,
      script: scriptSig,
      sequenceNumber: 0xffffffff,
    })
  );

  tx.addOutput(
    new Transaction.Output({
      script: Script.buildPublicKeyHashOut(address),
      satoshis: value,
    })
  );

  if (dataTag) {
    tx.addOutput(
      new Transaction.Output({
        script: Script.buildDataOut(dataTag),
        satoshis: 0,
      })
    );
  }

  return tx;
}

/** Encode a height as a minimal little-endian script number (BIP34). */
function scriptNumFromHeight(height) {
  if (height === 0) return Buffer.alloc(0);
  const bytes = [];
  let n = height;
  while (n > 0) {
    bytes.push(n & 0xff);
    n = Math.floor(n / 256);
  }
  // if high bit set, push a 0 byte so it's read as positive
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return Buffer.from(bytes);
}

module.exports = {
  getBlockSubsidy,
  buildCoinbase,
  scriptNumFromHeight,
  Opcode,
};
