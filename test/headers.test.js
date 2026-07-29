'use strict';

/**
 * SmartSV headers-first sync test. Runs with `node test/headers.test.js`.
 *
 * Verifies the property that headers-first exists for: a node commits to the
 * most-work chain from 80-byte proof-of-work-checked headers BEFORE it
 * downloads any block body, and then fetches bodies in a bounded window.
 *
 *   1. ordering + windowing — headers arrive before the first body, the
 *      in-flight window never exceeds its cap, and the header index is pruned
 *      away as bodies connect
 *   2. serving   — a getheaders locator is answered with the right headers
 *   3. hostility — a peer offering headers that fail PoW is banned and gets no
 *      body request at all; headers that don't connect restart sync instead,
 *      but only a bounded number of times
 *   4. recovery  — a peer that goes silent mid-sync doesn't wedge the download
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const assert = require('assert');
const sv = require('../src/sv');
const pow = require('../src/pow');
const params = require('../src/params');
const { Node } = require('../src/node');
const { PeerManager } = require('../src/p2p/manager');
const { encode, decode } = require('../src/p2p/messages');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  console.log('  ✓', label);
  passed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function mk(tag) {
  const dir = path.join(os.tmpdir(), `smartsv-headers-${process.pid}-${tag}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const node = new Node({ dataDir: dir });
  node.start();
  const p2p = new PeerManager(node, { port: 0, log: () => {} });
  return { node, p2p, dir };
}

function listen(p2p) {
  return new Promise((resolve) => {
    p2p.once('listening', resolve);
    p2p.start();
  });
}

/** Record the order of wire commands a manager receives. */
function traceMessages(p2p) {
  const seen = [];
  const original = p2p._onMessage.bind(p2p);
  p2p._onMessage = (peer, msg) => {
    seen.push(msg.command);
    return original(peer, msg);
  };
  return seen;
}

/**
 * A minimal hand-rolled peer that speaks the wire protocol directly, so the
 * test can offer a node headers it would never produce itself.
 */
function rawPeer(port, opts = {}) {
  const p = {
    received: [],
    sent: [],
    closed: false,
    socket: null,
    buffer: Buffer.alloc(0),
    listenPort: opts.listenPort || 59991,
    height: opts.height != null ? opts.height : 100,
  };
  p.send = (command, payload) => {
    p.sent.push(command);
    if (!p.socket.destroyed) p.socket.write(encode(command, payload));
  };
  p.got = (command) => p.received.some((m) => m.command === command);
  p.last = (command) => [...p.received].reverse().find((m) => m.command === command);

  p.socket = net.connect({ host: '127.0.0.1', port }, () => {
    p.send('version', {
      version: 1,
      height: p.height,
      nonce: sv.crypto.Random.getRandomBuffer(8).toString('hex'),
      userAgent: '/rawpeer:1.0/',
      port: p.listenPort,
    });
  });
  p.socket.on('data', (chunk) => {
    p.buffer = Buffer.concat([p.buffer, chunk]);
    const { messages, rest } = decode(p.buffer);
    p.buffer = rest;
    for (const msg of messages) {
      p.received.push(msg);
      if (msg.command === 'version') p.send('verack', {});
      if (msg.command === 'ping') p.send('pong', { nonce: msg.payload.nonce });
      if (msg.command === 'getheaders' && opts.onGetHeaders) opts.onGetHeaders(p, msg.payload);
    }
  });
  p.socket.on('close', () => (p.closed = true));
  p.socket.on('error', () => {});
  return p;
}

/** Build a header on top of `prevId`. `mode` picks how (or whether) it is valid. */
function craftHeader(prevId, time, mode = 'valid') {
  const header = new sv.BlockHeader({
    version: 1,
    prevHash: Buffer.from(prevId, 'hex').reverse(),
    merkleRoot: sv.crypto.Random.getRandomBuffer(32),
    time,
    bits: mode === 'easy-bits' ? 0x217fffff : params.genesisBits,
    nonce: 0,
  });
  if (mode === 'valid') {
    while (!pow.checkProofOfWork(header)) header.nonce++;
  } else if (mode === 'bad-pow') {
    while (pow.checkProofOfWork(header)) header.nonce++;
  }
  return header;
}

// --- 1. ordering, windowing, pruning -------------------------------------

async function syncTest() {
  console.log('headers-first initial block download');
  const A = mk('A');
  const B = mk('B');
  await Promise.all([listen(A.p2p), listen(B.p2p)]);

  const miner = new sv.PrivateKey().toAddress();
  for (let i = 0; i < 60; i++) A.node.mine(miner);
  ok(A.node.chain.height() === 60, 'A solo-mined to height 60');

  const trace = traceMessages(B.p2p);

  // Sample the in-flight window while the download runs.
  let maxInFlight = 0;
  let maxHeaderIndex = 0;
  const sampler = setInterval(() => {
    maxInFlight = Math.max(maxInFlight, B.p2p.inFlight.size);
    maxHeaderIndex = Math.max(maxHeaderIndex, B.p2p.headers.size());
  }, 5);

  B.p2p.connect(`127.0.0.1:${A.p2p.actualPort}`);
  await waitFor(() => B.node.chain.height() === 60, 'B syncs to 60');
  clearInterval(sampler);

  ok(B.node.chain.tip().hash === A.node.chain.tip().hash, 'B tip matches A');

  const firstHeaders = trace.indexOf('headers');
  const firstBlock = trace.indexOf('block');
  ok(firstHeaders !== -1, 'B received a headers message');
  ok(firstBlock !== -1, 'B received block bodies');
  ok(firstHeaders < firstBlock, 'headers arrived BEFORE the first block body');
  ok(!trace.includes('inv'), 'no inv-driven download was needed');

  ok(maxHeaderIndex >= 60, 'the whole 60-header chain was indexed up front');
  ok(maxInFlight > 1, 'bodies were requested in batches, not one at a time');
  ok(maxInFlight <= 16, `the in-flight window stayed capped (peak ${maxInFlight})`);

  await waitFor(() => B.p2p.headers.size() === 0, 'header index drains');
  ok(B.p2p.headers.size() === 0, 'headers are pruned once their bodies connect');
  ok(B.p2p.inFlight.size === 0, 'no body requests left outstanding');

  console.log('sync continues past a batch boundary and onto new tips');
  for (let i = 0; i < 40; i++) A.node.mine(miner);
  await waitFor(() => B.node.chain.height() === 100, 'B follows A to height 100');
  ok(B.node.chain.tip().hash === A.node.chain.tip().hash, 'B tracks A at height 100');
  ok(B.node.info().supply === A.node.info().supply, 'B agrees on total supply');

  for (const n of [A, B]) {
    n.p2p.stop();
    n.node.close();
    fs.rmSync(n.dir, { recursive: true, force: true });
  }
}

// --- 2. serving getheaders ------------------------------------------------

async function serveTest() {
  console.log('\nserving getheaders');
  const S = mk('S');
  await listen(S.p2p);
  const miner = new sv.PrivateKey().toAddress();
  for (let i = 0; i < 12; i++) S.node.mine(miner);

  // A raw peer that claims to be BEHIND, so the node won't try to sync from it.
  const rp = rawPeer(S.p2p.actualPort, { height: 0 });
  await waitFor(() => rp.got('verack'), 'raw peer completed the handshake');

  rp.send('getheaders', { locator: [S.node.chain.index[0].hash] });
  await waitFor(() => rp.got('headers'), 'node answered getheaders');
  const { headers } = rp.last('headers').payload;
  ok(headers.length === 12, 'all 12 headers after the locator were returned');

  const decoded = headers.map((h) => sv.BlockHeader.fromBuffer(Buffer.from(h, 'hex')));
  ok(
    decoded.every((h, i) => h.hash === S.node.chain.index[i + 1].hash),
    'headers are the active chain in ascending height order'
  );
  ok(
    decoded.every((h) => pow.checkProofOfWork(h)),
    'every served header carries valid proof of work'
  );

  // A locator from mid-chain resumes from there.
  rp.received.length = 0;
  rp.send('getheaders', { locator: [S.node.chain.index[9].hash] });
  await waitFor(() => rp.got('headers'), 'node answered the second getheaders');
  ok(rp.last('headers').payload.headers.length === 3, 'a mid-chain locator returns the remainder');

  rp.socket.destroy();
  S.p2p.stop();
  S.node.close();
  fs.rmSync(S.dir, { recursive: true, force: true });
}

// --- 3. hostile headers ---------------------------------------------------

async function hostileTest(mode, label) {
  const V = mk(`V-${mode}`);
  await listen(V.p2p);
  const genesis = V.node.chain.index[0].hash;

  const listenPort = 59990 + Math.floor(Math.random() * 1000);
  const rp = rawPeer(V.p2p.actualPort, {
    height: 50,
    listenPort,
    onGetHeaders: (p) => {
      // Offer a chain that looks longer than ours but is not real work.
      const headers = [];
      let prev = genesis;
      for (let i = 0; i < 5; i++) {
        const h = craftHeader(prev, params.genesisTimestamp + 100 + i, mode);
        headers.push(h.toBuffer().toString('hex'));
        prev = h.hash;
      }
      p.send('headers', { headers });
    },
  });

  await waitFor(() => rp.sent.includes('headers'), `${label}: node asked for headers`);
  await sleep(600); // give the node every chance to ask for bodies

  ok(!rp.got('getdata'), `${label}: no block bodies were requested`);
  ok(rp.closed, `${label}: the peer was dropped`);
  ok(V.p2p.addrBook.isBanned(`127.0.0.1:${listenPort}`), `${label}: its address was banned`);
  ok(V.node.chain.height() === 0, `${label}: the chain did not advance`);
  ok(V.p2p.headers.size() === 0, `${label}: nothing entered the header index`);

  rp.socket.destroy();
  V.p2p.stop();
  V.node.close();
  fs.rmSync(V.dir, { recursive: true, force: true });
}

async function danglingTest() {
  console.log('\nheaders that do not connect to anything we know');
  const V = mk('V-dangle');
  await listen(V.p2p);

  const listenPort = 58880;
  let served = 0;
  const rp = rawPeer(V.p2p.actualPort, {
    height: 50,
    listenPort,
    onGetHeaders: (p) => {
      served++;
      // Valid PoW, but built on a hash the node has never seen.
      const fakeAncestor = sv.crypto.Random.getRandomBuffer(32).toString('hex');
      const h = craftHeader(fakeAncestor, params.genesisTimestamp + 500, 'valid');
      p.send('headers', { headers: [h.toBuffer().toString('hex')] });
    },
  });

  // A stale locator is a normal condition, so the node retries from its own
  // tip — but it must not answer a peer that keeps dangling us forever.
  await waitFor(() => served >= 2, 'node retried getheaders from its own tip');
  await waitFor(() => rp.closed, 'node eventually gave up on the peer');
  const settled = served;
  await sleep(400);
  ok(served === settled, `the retry loop is bounded (${served} rounds, then it stopped)`);
  ok(!rp.got('getdata'), 'no bodies were requested for the dangling chain');
  ok(V.p2p.headers.size() === 0, 'the dangling header was not indexed');
  ok(V.node.chain.height() === 0, 'the chain did not advance');
  ok(
    V.p2p.addrBook.isBanned(`127.0.0.1:${listenPort}`),
    'the persistent offender was banned in the end'
  );

  rp.socket.destroy();
  V.p2p.stop();
  V.node.close();
  fs.rmSync(V.dir, { recursive: true, force: true });
}

// --- 4. a stalled peer doesn't wedge the sync -----------------------------

async function stallTest() {
  console.log('\nrecovery from a peer that never answers');
  const V = mk('V-stall');
  await listen(V.p2p);

  // Claims a longer chain, then simply never replies to getheaders.
  const rp = rawPeer(V.p2p.actualPort, { height: 50, listenPort: 58881 });
  await waitFor(() => rp.got('getheaders'), 'node asked the peer for headers');
  const first = rp.received.filter((m) => m.command === 'getheaders').length;

  await waitFor(
    () => rp.received.filter((m) => m.command === 'getheaders').length > first,
    'node re-asked after the request went unanswered',
    15000
  );
  ok(true, 'a silent peer does not wedge the download — the sync tick retries');
  ok(!rp.closed, 'the silent peer is not banned, just retried');

  rp.socket.destroy();
  V.p2p.stop();
  V.node.close();
  fs.rmSync(V.dir, { recursive: true, force: true });
}

async function main() {
  await syncTest();
  await serveTest();
  console.log('\nheaders that fail proof of work');
  await hostileTest('bad-pow', 'hash above target');
  await hostileTest('easy-bits', 'difficulty below the PoW limit');
  await danglingTest();
  await stallTest();

  console.log(`\nAll ${passed} headers-first checks passed ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  console.error(e);
  process.exit(1);
});
