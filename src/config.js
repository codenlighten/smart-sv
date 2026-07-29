'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const params = require('./params');

/**
 * Node configuration, resolved from (in order of precedence):
 *   1. explicit overrides passed to load()
 *   2. a JSON file at SMARTSV_CONFIG (if set)
 *   3. SMARTSV_* environment variables
 *   4. built-in defaults
 *
 * This is the single place the daemon reads deployment settings, so the same
 * image runs a seed, a peer, or a local dev node purely via env.
 */
function envBool(v, dflt) {
  if (v == null) return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function load(overrides = {}) {
  const env = process.env;

  let fileCfg = {};
  if (env.SMARTSV_CONFIG) {
    fileCfg = JSON.parse(fs.readFileSync(env.SMARTSV_CONFIG, 'utf8'));
  }

  const cfg = {
    dataDir:
      overrides.dataDir ||
      fileCfg.dataDir ||
      env.SMARTSV_DATADIR ||
      path.join(os.homedir(), '.smartsv'),

    // RPC / API — bind to loopback by default; a TLS reverse proxy fronts it.
    rpcHost: overrides.rpcHost || fileCfg.rpcHost || env.SMARTSV_RPC_HOST || '127.0.0.1',
    rpcPort: Number(overrides.rpcPort || fileCfg.rpcPort || env.SMARTSV_RPC_PORT || params.rpcPort),

    // P2P — listen on all interfaces so peers can reach it.
    p2pHost: overrides.p2pHost || fileCfg.p2pHost || env.SMARTSV_P2P_HOST || '0.0.0.0',
    p2pPort: Number(overrides.p2pPort || fileCfg.p2pPort || env.SMARTSV_P2P_PORT || params.p2pPort),
    p2pEnabled: envBool(env.SMARTSV_P2P, fileCfg.p2pEnabled !== false),
    maxPeers: Number(env.SMARTSV_MAX_PEERS || fileCfg.maxPeers || 16),
    // Outbound connections the node keeps open, refilled from the persistent
    // address book. Inbound slots make up the rest of maxPeers.
    targetOutbound: Number(env.SMARTSV_TARGET_OUTBOUND || fileCfg.targetOutbound || 8),

    // Peers to dial on startup (comma-separated host:port). An empty override
    // array must not mask the env/file value, so treat it as "unset".
    connect: parseList(
      firstNonEmpty(overrides.connect, fileCfg.connect, env.SMARTSV_CONNECT)
    ),

    // Bearer token required for mutating RPC routes (/tx, /block, /mine).
    // When empty, mutating routes are OPEN — intended only for local dev.
    apiKey: overrides.apiKey || fileCfg.apiKey || env.SMARTSV_API_KEY || '',

    // Built-in miner (optional).
    mineAddress: overrides.mineAddress || fileCfg.mineAddress || env.SMARTSV_MINE_ADDRESS || '',
    mineInterval: Number(overrides.mineInterval || fileCfg.mineInterval || env.SMARTSV_MINE_INTERVAL || 10),

    // Side-chain pruning. 0 keeps every losing fork's body forever.
    pruneDepth: numberOr(
      [overrides.pruneDepth, fileCfg.pruneDepth, env.SMARTSV_PRUNE_DEPTH],
      params.pruneDepth
    ),

    logLevel: overrides.logLevel || fileCfg.logLevel || env.SMARTSV_LOG_LEVEL || 'info',
    logJson: envBool(env.SMARTSV_LOG_JSON, fileCfg.logJson || false),
  };

  return cfg;
}

/**
 * First numeric candidate, falling back to `dflt`. Unlike `a || b` this keeps
 * an explicit 0 — which for pruneDepth means "disabled", not "unset".
 */
function numberOr(candidates, dflt) {
  for (const v of candidates) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}

/** First argument that is non-null and non-empty (handles empty arrays/strings). */
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return null;
}

function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { load };
