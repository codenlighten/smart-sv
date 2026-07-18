'use strict';

const sv = require('./sv');
const BN = sv.crypto.BN;
const params = require('./params');

/**
 * Proof-of-work helpers: compact "bits" <-> 256-bit target conversion, PoW
 * checking, mining (nonce grinding), and Bitcoin-style difficulty retargeting.
 */

/** Convert a compact `bits` value into a 256-bit target BN. */
function bitsToTarget(bits) {
  const exponent = bits >>> 24;
  const mantissa = bits & 0x007fffff;
  let target;
  if (exponent <= 3) {
    target = new BN(mantissa >>> (8 * (3 - exponent)));
  } else {
    target = new BN(mantissa).mul(new BN(256).pow(new BN(exponent - 3)));
  }
  return target;
}

/** Convert a 256-bit target BN back into compact `bits`. */
function targetToBits(target) {
  let hex = target.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex');
  // strip leading zero bytes
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  bytes = bytes.slice(i);
  let exponent = bytes.length;
  let mantissa;
  if (exponent === 0) {
    return 0;
  }
  mantissa =
    (bytes[0] << 16) | ((bytes[1] || 0) << 8) | (bytes[2] || 0);
  // If the high bit of the mantissa is set, shift down one byte (sign bit).
  if (mantissa & 0x00800000) {
    mantissa >>>= 8;
    exponent += 1;
  }
  return ((exponent << 24) | (mantissa & 0x007fffff)) >>> 0;
}

/**
 * The "work" a block contributes to its chain: 2^256 / (target + 1). Summing
 * this over a chain gives cumulative chainwork, the basis for fork choice.
 * Returned as a BN for exact comparison across differing difficulties.
 */
function getBlockProof(bits) {
  const target = bitsToTarget(bits);
  if (target.isNeg() || target.isZero()) return new BN(0);
  const twoTo256 = new BN(1).ushln(256);
  return twoTo256.div(target.addn(1));
}

/** The block hash as a numeric BN (hashes are little-endian for PoW comparison). */
function hashToBN(header) {
  // header.hash is the big-endian display id; the internal PoW compares the
  // little-endian double-sha256. Recompute from the serialized header.
  const buf = header.toBufferWriter().toBuffer();
  const h = sv.crypto.Hash.sha256sha256(buf); // little-endian byte order
  return new BN(h.toString('hex'), 16, 'le');
}

/** True if the header's PoW hash meets its own difficulty target. */
function checkProofOfWork(header) {
  const target = bitsToTarget(header.bits);
  if (target.isNeg() || target.isZero()) return false;
  const powLimit = bitsToTarget(params.powLimitBits);
  if (target.gt(powLimit)) return false;
  return hashToBN(header).lte(target);
}

/**
 * Mine a header by grinding the nonce (and rolling time/extra-nonce on
 * overflow). Returns the winning nonce; mutates header.nonce.
 *
 * @param {BlockHeader} header  a sv.BlockHeader instance (mutable)
 * @param {object} [opts]
 * @param {number} [opts.maxTries]  give up after this many attempts
 * @param {function} [opts.onProgress]  called every ~1e5 tries with count
 */
function mine(header, opts = {}) {
  const target = bitsToTarget(header.bits);
  const maxTries = opts.maxTries || Number.MAX_SAFE_INTEGER;
  let tries = 0;
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    header.nonce = nonce;
    if (hashToBN(header).lte(target)) {
      return { found: true, nonce, tries };
    }
    tries++;
    if (opts.onProgress && tries % 100000 === 0) opts.onProgress(tries);
    if (tries >= maxTries) return { found: false, nonce, tries };
  }
  return { found: false, nonce: 0xffffffff, tries };
}

/**
 * Compute the `bits` for the next block given the previous block index and the
 * timestamp of the first block in the current retarget window.
 */
function nextWorkRequired(prevIndex, firstBlockTime) {
  if (!params.retargeting) return params.genesisBits;
  if (!prevIndex) return params.genesisBits;

  const height = prevIndex.height + 1;
  if (height % params.retargetInterval !== 0) {
    return prevIndex.bits;
  }

  const targetTimespan = params.retargetInterval * params.targetBlockTimeSec;
  let actual = prevIndex.time - firstBlockTime;
  // clamp to [timespan/4, timespan*4]
  if (actual < targetTimespan / 4) actual = targetTimespan / 4;
  if (actual > targetTimespan * 4) actual = targetTimespan * 4;

  let newTarget = bitsToTarget(prevIndex.bits)
    .mul(new BN(actual))
    .div(new BN(targetTimespan));

  const powLimit = bitsToTarget(params.powLimitBits);
  if (newTarget.gt(powLimit)) newTarget = powLimit;

  return targetToBits(newTarget);
}

module.exports = {
  bitsToTarget,
  targetToBits,
  getBlockProof,
  hashToBN,
  checkProofOfWork,
  mine,
  nextWorkRequired,
};
