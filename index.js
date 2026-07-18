'use strict';

/**
 * SmartSV — public library surface.
 *
 * A standalone Bitcoin-SV-compatible blockchain built on the SmartSV primitives library.
 * Use `Node` to run an in-process chain, or the bin/ entrypoints for a daemon
 * and CLI.
 */
module.exports = {
  Node: require('./src/node').Node,
  Blockchain: require('./src/blockchain').Blockchain,
  Mempool: require('./src/mempool').Mempool,
  Wallet: require('./src/wallet').Wallet,
  createServer: require('./src/api/server').createServer,
  PeerManager: require('./src/p2p/manager').PeerManager,
  ChainStore: require('./src/store/chainstore').ChainStore,
  config: require('./src/config'),
  createLogger: require('./src/logger').createLogger,
  params: require('./src/params'),
  pow: require('./src/pow'),
  consensus: require('./src/consensus'),
  validation: require('./src/validation'),
  buildGenesis: require('./src/genesis').buildGenesis,
  sv: require('./src/sv'),
};
