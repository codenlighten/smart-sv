'use strict';

/**
 * SmartSV consensus parameters.
 *
 * SmartSV is a standalone UTXO blockchain. It reuses the transaction, script,
 * signature (BIP143 + SIGHASH_FORKID) and block formats provided by the SmartSV
 * primitives library, but runs its own genesis, its own network magic and its
 * own consensus rules defined here.
 *
 * The defaults below use a regtest-style low PoW target so blocks mine in
 * milliseconds during development. Raise `genesisBits` / enable `retargeting`
 * for a slower chain with real difficulty.
 */

const COIN = 100000000; // 1 SSV = 100,000,000 satoshis (identical to Bitcoin)

const params = {
  name: 'smartsv',
  chainName: 'SmartSV',
  ticker: 'SSV',

  // Monetary policy
  COIN,
  initialSubsidy: 50 * COIN, // block reward at height 1
  halvingInterval: 210000, // subsidy halves every N blocks
  maxMoney: 21000000 * COIN,

  // Proof of work
  // 0x207fffff is the highest (easiest) practical target — mines instantly.
  genesisBits: 0x207fffff,
  powLimitBits: 0x207fffff, // difficulty can never get easier than this
  targetBlockTimeSec: 600, // 10 minutes (only relevant when retargeting)
  retargetInterval: 2016, // blocks between difficulty adjustments
  retargeting: false, // regtest-style: keep difficulty fixed at genesisBits
  allowMinDifficultyBlocks: true,

  // Consensus limits
  coinbaseMaturity: 100, // blocks before a coinbase output can be spent
  maxBlockSize: 32 * 1024 * 1024, // 32 MB — large blocks by design
  medianTimeSpan: 11, // blocks used for median-time-past
  maxFutureBlockTimeSec: 2 * 60 * 60, // 2 hours

  // Coinbase
  coinbaseFlag: 'SmartSV/', // human-readable tag embedded in coinbase scriptSig

  // Network identity (used for P2P + address encoding)
  // 4-byte message-start magic that prefixes P2P messages: "SSV!" style marker.
  networkMagic: 0xe5534856, // arbitrary, distinct from other chains
  // Address/key version bytes, chosen so wallets and the SmartSV primitives
  // library Address class round-trip cleanly.
  pubkeyhash: 0x00,
  privatekey: 0x80,
  scripthash: 0x05,
  xpubkey: 0x0488b21e,
  xprivkey: 0x0488ade4,

  // Default daemon ports
  p2pPort: 8433,
  rpcPort: 8432,

  // Genesis
  genesisTimestamp: 1752710400, // 2025-07-17T00:00:00Z, fixed for determinism
  // Genesis coinbase message (in the tradition of Bitcoin's headline).
  // Tao Te Ching 17: on leadership so light the people feel self-governed.
  genesisMessage:
    'Tao Te Ching 17 — When the work is done, the people say: we did it ourselves.',
};

module.exports = params;
