'use strict';

const http = require('http');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const sv = require('../sv');
const params = require('../params');
const { ValidationError } = require('../validation');

/**
 * REST + WebSocket API over a Node instance.
 *
 * REST (JSON):
 *   GET  /                          node banner
 *   GET  /health                    liveness (always 200 if up)  [no auth]
 *   GET  /ready                     readiness (200 once chain loaded) [no auth]
 *   GET  /metrics                   Prometheus text metrics  [no auth]
 *   GET  /info                      chain/mempool summary
 *   GET  /block/:idOrHeight         a block (JSON)
 *   GET  /block/:idOrHeight/raw     a block (hex)
 *   GET  /tx/:txid                  a transaction + confirmations
 *   GET  /address/:addr/balance     confirmed balance
 *   GET  /address/:addr/utxos       spendable UTXOs
 *   GET  /mempool                   mempool txids
 *   GET  /peers                     connected peers + the persistent address book
 *   POST /tx        { rawtx }       broadcast a transaction   [auth]
 *   POST /block     { rawblock }    submit a block (P2P-style) [auth]
 *   POST /mine      { address }     mine one block             [auth]
 *
 * Mutating (POST) routes require a bearer API key when `opts.apiKey` is set —
 * via `Authorization: Bearer <key>` or the `X-API-Key` header. When no apiKey
 * is configured the routes are open (local-dev mode).
 *
 * WebSocket: connect to the same host/port. The server pushes
 *   { type:'block', height, id } and { type:'tx', txid, fee } events.
 */
function createServer(node, opts = {}) {
  const apiKey = opts.apiKey || '';
  const server = http.createServer((req, res) => handle(node, req, res, apiKey));
  const wss = new WebSocketServer({ server });

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  };
  node.on('block', ({ block, height }) =>
    broadcast({ type: 'block', height, id: block.id, txCount: block.transactions.length })
  );
  node.on('tx', ({ txid, fee }) => broadcast({ type: 'tx', txid, fee }));

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', ...node.info() }));
  });

  return { server, wss, broadcast };
}

function send(res, code, body) {
  const data = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Constant-time-ish bearer check. Returns true when auth passes (or is off). */
function authorized(req, apiKey) {
  if (!apiKey) return true; // open mode
  const hdr = req.headers['authorization'] || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const key = bearer || req.headers['x-api-key'] || '';
  return key === apiKey;
}

async function handle(node, req, res, apiKey) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method;

    // --- unauthenticated operational endpoints ---
    if (method === 'GET' && parts[0] === 'health') {
      return send(res, 200, { status: 'ok', uptime: process.uptime() });
    }
    if (method === 'GET' && parts[0] === 'ready') {
      const ready = node.chain && node.chain.height() >= 0;
      return send(res, ready ? 200 : 503, { ready, height: ready ? node.chain.height() : null });
    }
    if (method === 'GET' && parts[0] === 'metrics') {
      return sendMetrics(res, node);
    }

    // --- auth gate for mutating routes ---
    if (method === 'POST' && ['tx', 'block', 'mine'].includes(parts[0])) {
      if (!authorized(req, apiKey)) {
        return send(res, 401, { error: 'unauthorized', code: 'auth-required' });
      }
    }

    if (method === 'GET' && parts.length === 0) {
      return send(res, 200, {
        service: `${params.chainName} node`,
        ticker: params.ticker,
        ...node.info(),
      });
    }

    if (method === 'GET' && parts[0] === 'info') {
      return send(res, 200, node.info());
    }

    if (method === 'GET' && parts[0] === 'block' && parts[1]) {
      const block = node.getBlock(parts[1]);
      if (!block) return send(res, 404, { error: 'block not found' });
      if (parts[2] === 'raw') return send(res, 200, block.toBuffer().toString('hex'));
      return send(res, 200, blockToJSON(block, node));
    }

    if (method === 'GET' && parts[0] === 'tx' && parts[1]) {
      const found = node.getTransaction(parts[1]);
      if (!found) return send(res, 404, { error: 'tx not found' });
      return send(res, 200, {
        txid: found.tx.hash,
        confirmations: found.confirmations,
        blockHeight: found.blockHeight,
        hex: found.tx.toString(),
        tx: found.tx.toObject(),
      });
    }

    if (method === 'GET' && parts[0] === 'address' && parts[1]) {
      const addr = parts[1];
      if (parts[2] === 'balance') {
        return send(res, 200, { address: addr, balance: node.getBalance(addr) });
      }
      if (parts[2] === 'utxos') {
        return send(res, 200, { address: addr, utxos: node.getUTXOs(addr) });
      }
    }

    if (method === 'GET' && parts[0] === 'peers') {
      const p2p = node.p2p;
      if (!p2p) return send(res, 200, { enabled: false, connected: [], known: [] });
      const now = node.now();
      return send(res, 200, {
        enabled: true,
        connected: [...p2p.peers]
          .filter((p) => p.handshakeDone)
          .map((p) => ({
            id: p.id,
            addr: p.addrKey || p.advertisedAddr || p.id,
            inbound: p.inbound,
            height: p.height,
            userAgent: p.userAgent,
          })),
        outbound: p2p.outboundCount(),
        targetOutbound: p2p.targetOutbound,
        compact: { ...p2p.stats },
        known: p2p.addrBook.list().map((e) => ({
          addr: e.addr,
          source: e.source,
          lastSeen: e.lastSeen,
          lastSuccess: e.lastSuccess,
          failures: e.failures,
          successes: e.successes,
          banned: e.bannedUntil > now,
          retryIn: p2p.addrBook.backoffRemaining(e, now),
        })),
      });
    }

    if (method === 'GET' && parts[0] === 'mempool') {
      return send(res, 200, {
        size: node.mempool.size(),
        txids: [...node.mempool.txs.keys()],
      });
    }

    if (method === 'POST' && parts[0] === 'tx') {
      const body = await readBody(req);
      const result = node.submitTransaction(body.rawtx);
      return send(res, 200, result);
    }

    if (method === 'POST' && parts[0] === 'block') {
      const body = await readBody(req);
      const result = node.submitBlock(body.rawblock);
      return send(res, 200, result);
    }

    if (method === 'POST' && parts[0] === 'mine') {
      const body = await readBody(req);
      const address = body.address;
      if (!address) return send(res, 400, { error: 'address required' });
      const result = node.mine(address, { coinbaseData: body.data });
      return send(res, 200, {
        height: result.height,
        id: result.id,
        reward: result.reward,
        fees: result.fees,
        txCount: result.block.transactions.length,
      });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    const code = err instanceof ValidationError ? 400 : 500;
    return send(res, code, { error: err.message, code: err.code });
  }
}

function blockToJSON(block, node) {
  const idx = node.chain.byHash.get(block.id);
  return {
    id: block.id,
    height: idx ? idx.height : undefined,
    header: {
      version: block.header.version,
      prevHash: Buffer.from(block.header.prevHash).reverse().toString('hex'),
      merkleRoot: Buffer.from(block.header.merkleRoot).reverse().toString('hex'),
      time: block.header.time,
      bits: block.header.bits.toString(16),
      nonce: block.header.nonce,
      difficulty: block.header.getDifficulty(),
    },
    txCount: block.transactions.length,
    txids: block.transactions.map((t) => t.hash),
    size: block.toBuffer().length,
  };
}

/** Minimal Prometheus-format metrics. */
function sendMetrics(res, node) {
  const info = node.info();
  const lines = [
    '# HELP smartsv_height Active chain height',
    '# TYPE smartsv_height gauge',
    `smartsv_height ${info.height}`,
    '# HELP smartsv_mempool_size Transactions in the mempool',
    '# TYPE smartsv_mempool_size gauge',
    `smartsv_mempool_size ${info.mempool}`,
    '# HELP smartsv_utxos UTXO set size',
    '# TYPE smartsv_utxos gauge',
    `smartsv_utxos ${info.utxos}`,
    '# HELP smartsv_supply_sat Circulating supply in satoshis',
    '# TYPE smartsv_supply_sat gauge',
    `smartsv_supply_sat ${info.supply}`,
    '# HELP smartsv_peers Connected P2P peers',
    '# TYPE smartsv_peers gauge',
    `smartsv_peers ${node.peerCount ? node.peerCount() : 0}`,
    '# HELP smartsv_peers_outbound Outbound P2P connections',
    '# TYPE smartsv_peers_outbound gauge',
    `smartsv_peers_outbound ${node.p2p ? node.p2p.outboundCount() : 0}`,
    '# HELP smartsv_addrbook_size Addresses in the persistent address book',
    '# TYPE smartsv_addrbook_size gauge',
    `smartsv_addrbook_size ${node.p2p ? node.p2p.addrBook.size() : 0}`,
    '# HELP smartsv_blocks_indexed Blocks in the block tree (active + side chains)',
    '# TYPE smartsv_blocks_indexed gauge',
    `smartsv_blocks_indexed ${info.blocksIndexed}`,
    '# HELP smartsv_pruned_side_chain_blocks Side-chain blocks whose bodies were discarded',
    '# TYPE smartsv_pruned_side_chain_blocks gauge',
    `smartsv_pruned_side_chain_blocks ${info.prunedSideChainBlocks}`,
    '# HELP smartsv_compact_blocks Blocks received as compact sketches',
    '# TYPE smartsv_compact_blocks counter',
    `smartsv_compact_blocks ${node.p2p ? node.p2p.stats.compactBlocks : 0}`,
    '# HELP smartsv_compact_txs_saved Transactions matched from the mempool instead of re-sent',
    '# TYPE smartsv_compact_txs_saved counter',
    `smartsv_compact_txs_saved ${node.p2p ? node.p2p.stats.compactTxsSaved : 0}`,
    '# HELP smartsv_compact_fallbacks Compact blocks that had to be refetched in full',
    '# TYPE smartsv_compact_fallbacks counter',
    `smartsv_compact_fallbacks ${node.p2p ? node.p2p.stats.compactFallbacks : 0}`,
    '# HELP smartsv_uptime_seconds Process uptime',
    '# TYPE smartsv_uptime_seconds counter',
    `smartsv_uptime_seconds ${Math.floor(process.uptime())}`,
  ];
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
  res.end(lines.join('\n') + '\n');
}

module.exports = { createServer };

