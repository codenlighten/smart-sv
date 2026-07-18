#!/usr/bin/env node
'use strict';

/**
 * smartsvd — the SmartSV full-node daemon.
 *
 * Configuration is resolved from CLI flags, then a JSON file at $SMARTSV_CONFIG,
 * then SMARTSV_* environment variables, then defaults (see src/config.js). In
 * production the container is driven entirely by env vars.
 *
 * Flags (override env):
 *   --datadir DIR        data directory
 *   --rpc-port N         RPC/WS port
 *   --rpc-host HOST      RPC bind address (default 127.0.0.1)
 *   --p2p-port N         P2P listen port
 *   --connect H:P        dial a peer (repeatable)
 *   --api-key KEY        bearer key required for POST /tx,/block,/mine
 *   --mine ADDRESS       auto-mine to this address
 *   --interval SEC       seconds between auto-mined blocks
 *   --no-p2p             disable the P2P layer
 *   --reset              wipe chainstate before starting
 */

const { Node } = require('../src/node');
const { createServer } = require('../src/api/server');
const { PeerManager } = require('../src/p2p/manager');
const { createLogger } = require('../src/logger');
const config = require('../src/config');
const params = require('../src/params');

function parseFlags(argv) {
  const o = { connect: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--datadir') o.dataDir = argv[++i];
    else if (a === '--rpc-port' || a === '--port') o.rpcPort = Number(argv[++i]);
    else if (a === '--rpc-host') o.rpcHost = argv[++i];
    else if (a === '--p2p-port') o.p2pPort = Number(argv[++i]);
    else if (a === '--connect') o.connect.push(argv[++i]);
    else if (a === '--api-key') o.apiKey = argv[++i];
    else if (a === '--mine') o.mineAddress = argv[++i];
    else if (a === '--interval') o.mineInterval = Number(argv[++i]);
    else if (a === '--no-p2p') o.noP2p = true;
    else if (a === '--reset') o.reset = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function main() {
  const flags = parseFlags(process.argv);
  if (flags.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1]);
    return;
  }

  const cfg = config.load(flags);
  if (flags.noP2p) cfg.p2pEnabled = false;
  if (flags.connect.length) cfg.connect = flags.connect;

  const log = createLogger({ level: cfg.logLevel, json: cfg.logJson, name: 'smartsvd' });

  const node = new Node({ dataDir: cfg.dataDir });
  if (flags.reset) node.store.reset();
  node.start();
  log.info(`${params.chainName} node started`, {
    datadir: cfg.dataDir,
    height: node.chain.height(),
    tip: node.chain.tip().hash,
    network: params.name,
  });

  node.on('block', ({ height, block, reorg }) =>
    log.info('block', { height, id: block.id, txs: block.transactions.length, reorg: !!reorg })
  );

  // --- P2P ---
  let p2p = null;
  if (cfg.p2pEnabled) {
    p2p = new PeerManager(node, {
      port: cfg.p2pPort,
      maxPeers: cfg.maxPeers,
      log: (m) => log.debug(m),
    });
    p2p.start();
    node.peerCount = () => p2p.peerCount();
    for (const target of cfg.connect) p2p.connect(target);
    if (cfg.connect.length) log.info('dialing peers', { peers: cfg.connect });
  }

  // --- RPC / WS ---
  if (!cfg.apiKey) {
    log.warn('no API key set — POST /tx,/block,/mine are OPEN (dev mode only)');
  }
  const { server } = createServer(node, { apiKey: cfg.apiKey });
  server.listen(cfg.rpcPort, cfg.rpcHost, () =>
    log.info('RPC/WS listening', { host: cfg.rpcHost, port: cfg.rpcPort, auth: !!cfg.apiKey })
  );

  // --- built-in miner ---
  let miner = null;
  if (cfg.mineAddress) {
    log.info('auto-mining enabled', { address: cfg.mineAddress, interval: cfg.mineInterval });
    miner = setInterval(() => {
      try {
        const r = node.mine(cfg.mineAddress);
        log.info('mined', { height: r.height, reward: r.reward, fees: r.fees });
      } catch (e) {
        log.error('mine error', { error: e.message });
      }
    }, cfg.mineInterval * 1000);
  }

  // --- graceful shutdown ---
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal: sig });
    if (miner) clearInterval(miner);
    if (p2p) p2p.stop();
    server.close(() => {
      node.close();
      process.exit(0);
    });
    setTimeout(() => {
      node.close();
      process.exit(0);
    }, 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception', { error: e.message, stack: e.stack });
  });
}

main();
