'use strict';

/**
 * SmartSV compact block relay test. Runs with `node test/compact.test.js`.
 *
 * The point of compact relay is that a peer which already has the transactions
 * in its mempool should not receive them a second time inside the block. These
 * checks pin that down end to end:
 *
 *   1. sketching     — buildCompact/reconstruct/assemble round-trip, and the
 *                      per-announcement nonce really does change the short ids
 *   2. the happy path — a block whose transactions are all in the receiver's
 *                      mempool is rebuilt with ZERO transactions requested
 *   3. the gap path   — a transaction the receiver never saw is fetched with a
 *                      getblocktxn/blocktxn round trip
 *   4. safety        — a sketch that rebuilds into the wrong block falls back
 *                      to a full request instead of being accepted, and a
 *                      sketch with bad proof of work gets the peer banned
 *   5. negotiation   — peers that don't speak compact still get plain inv
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const assert = require('assert');
const sv = require('../src/sv');
const pow = require('../src/pow');
const params = require('../src/params');
const compact = require('../src/p2p/compact');
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
  const dir = path.join(os.tmpdir(), `smartsv-compact-${process.pid}-${tag}`);
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

function traceMessages(p2p) {
  const seen = [];
  const original = p2p._onMessage.bind(p2p);
  p2p._onMessage = (peer, msg) => {
    seen.push(msg.command);
    return original(peer, msg);
  };
  return seen;
}

function cleanup(...nodes) {
  for (const n of nodes) {
    n.p2p.stop();
    n.node.close();
    fs.rmSync(n.dir, { recursive: true, force: true });
  }
}

/** A hand-rolled peer, so the test can send sketches a real node would not. */
function rawPeer(port, opts = {}) {
  const p = {
    received: [],
    closed: false,
    buffer: Buffer.alloc(0),
    listenPort: opts.listenPort || 57771,
  };
  p.send = (command, payload) => {
    if (!p.socket.destroyed) p.socket.write(encode(command, payload));
  };
  p.got = (command) => p.received.some((m) => m.command === command);
  p.last = (command) => [...p.received].reverse().find((m) => m.command === command);

  p.socket = net.connect({ host: '127.0.0.1', port }, () => {
    p.send('version', {
      version: 1,
      height: opts.height != null ? opts.height : 0,
      nonce: sv.crypto.Random.getRandomBuffer(8).toString('hex'),
      userAgent: '/rawpeer:1.0/',
      port: p.listenPort,
      compact: opts.compact !== false,
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
    }
  });
  p.socket.on('close', () => (p.closed = true));
  p.socket.on('error', () => {});
  return p;
}

/** Fund an address and return a spendable, signed payment transaction. */
function makePayment(node, key, toAddr, sats, dataNote) {
  const mature = node
    .getUTXOs(key.toAddress())
    .find((u) => u.confirmations >= params.coinbaseMaturity);
  assert.ok(mature, 'need a mature coinbase to spend');
  return new sv.Transaction()
    .from({
      txId: mature.txid,
      outputIndex: mature.outputIndex,
      script: mature.script,
      satoshis: mature.satoshis,
    })
    .to(toAddr, sats)
    .addData(dataNote)
    .change(key.toAddress())
    .sign(key);
}

// --- 1. the sketch itself -------------------------------------------------

function unitTests() {
  console.log('compact sketches');
  const A = mk('unit');
  const key = new sv.PrivateKey();
  for (let i = 0; i < 101; i++) A.node.mine(key.toAddress());
  const bob = new sv.PrivateKey().toAddress();
  const tx = makePayment(A.node, key, bob, 3 * params.COIN, 'compact relay');
  A.node.submitTransaction(tx);
  const mined = A.node.mine(key.toAddress());
  const block = mined.block;
  ok(block.transactions.length === 2, 'the mined block has a coinbase and one payment');

  const sketch = compact.buildCompact(block, 'nonce-one');
  ok(sketch.prefilled.length === 1 && sketch.prefilled[0].index === 0, 'the coinbase is prefilled');
  ok(sketch.shortids.length === 1, 'the payment is reduced to one short id');
  ok(sketch.shortids[0].length === compact.SHORT_ID_BYTES * 2, 'short ids are 6 bytes');

  const other = compact.buildCompact(block, 'nonce-two');
  ok(
    other.shortids[0] !== sketch.shortids[0],
    'a different nonce yields different short ids (no pre-computed collisions)'
  );

  const full = compact.reconstruct(sketch, [tx]);
  ok(full.missing.length === 0, 'a peer holding the payment is missing nothing');
  const rebuilt = compact.assemble(full.header, full.slots);
  ok(rebuilt && rebuilt.id === block.id, 'the block rebuilds byte-identically');

  const empty = compact.reconstruct(sketch, []);
  ok(empty.missing.length === 1 && empty.missing[0] === 1, 'an empty mempool reports the gap');
  ok(compact.assemble(empty.header, empty.slots) === null, 'an incomplete block will not assemble');

  const wrong = compact.reconstruct(sketch, []);
  wrong.slots[1] = makePayment(A.node, key, bob, 4 * params.COIN, 'not the same tx');
  ok(
    compact.assemble(wrong.header, wrong.slots) === null,
    'the merkle root rejects a wrong transaction set'
  );

  cleanup(A);
}

// --- 2 & 3. relay over a real connection ----------------------------------

async function relayTest() {
  console.log('\nrelay when the receiver already has the transactions');
  const A = mk('A');
  const B = mk('B');
  await Promise.all([listen(A.p2p), listen(B.p2p)]);

  const key = new sv.PrivateKey();
  for (let i = 0; i < 101; i++) A.node.mine(key.toAddress());

  const traceA = traceMessages(A.p2p);
  B.p2p.connect(`127.0.0.1:${A.p2p.actualPort}`);
  await waitFor(() => B.node.chain.height() === 101, 'B syncs to 101');

  // Relay a transaction so it lands in B's mempool the normal way.
  const bob = new sv.PrivateKey().toAddress();
  const tx = makePayment(A.node, key, bob, 5 * params.COIN, 'already in your mempool');
  const { txid } = A.node.submitTransaction(tx);
  await waitFor(() => B.node.mempool.has(txid), 'the payment reaches B via tx relay');

  const before = B.p2p.stats.compactBlocks;
  traceA.length = 0;
  A.node.mine(key.toAddress()); // block 102 contains the relayed payment

  await waitFor(() => B.node.chain.height() === 102, 'B accepts block 102');
  ok(B.node.chain.tip().hash === A.node.chain.tip().hash, 'B rebuilt exactly A’s block');
  ok(B.p2p.stats.compactBlocks === before + 1, 'B counted a compact block');
  ok(!traceA.includes('getblocktxn'), 'B asked for ZERO transactions — the whole point');
  ok(!traceA.includes('getdata'), 'B never needed the block in full');
  ok(B.p2p.stats.compactFallbacks === 0, 'no fallback was needed');
  ok(B.p2p.stats.compactTxsSaved >= 1, 'the payment was not re-sent inside the block');
  ok(B.node.getBalance(bob) === 5 * params.COIN, 'B credits the payment on-chain');

  console.log('\nrelay when the receiver is missing a transaction');
  // A transaction B has never seen: submitted to A while B is disconnected.
  B.p2p.stop();
  await sleep(300);
  const secret = makePayment(A.node, key, bob, 6 * params.COIN, 'B has never seen this');
  A.node.submitTransaction(secret);
  ok(!B.node.mempool.has(secret.hash), 'B does not have the transaction');

  await listen(B.p2p);
  const traceA2 = traceMessages(A.p2p);
  B.p2p.connect(`127.0.0.1:${A.p2p.actualPort}`);
  await waitFor(() => B.p2p.outboundCount() === 1, 'B reconnects to A');
  await sleep(200);

  A.node.mine(key.toAddress()); // block 103 contains the unseen payment
  await waitFor(() => B.node.chain.height() === 103, 'B accepts block 103');
  ok(traceA2.includes('getblocktxn'), 'B requested only the transaction it lacked');
  ok(!traceA2.includes('getdata'), 'B still never asked for the whole block');
  ok(B.node.getBalance(bob) === 11 * params.COIN, 'B credits both payments');
  ok(B.p2p.stats.compactFallbacks === 0, 'reconstruction succeeded without a fallback');

  cleanup(A, B);
}

// --- 4. safety ------------------------------------------------------------

async function badSketchTest() {
  console.log('\na sketch that rebuilds into the wrong block');
  const V = mk('V');
  const H = mk('H'); // a helper that produces a genuinely mined block
  await listen(V.p2p);

  const key = new sv.PrivateKey();
  const mined = H.node.mine(key.toAddress()); // real PoW, height 1
  const decoy = mk('D');
  const decoyBlock = decoy.node.mine(new sv.PrivateKey().toAddress()).block;

  const rp = rawPeer(V.p2p.actualPort, { height: 1, listenPort: 57772 });
  await waitFor(() => rp.got('verack'), 'raw peer handshook');

  // Real header, but the coinbase of a DIFFERENT block: nothing is reported
  // missing, so the only thing standing between us and a bad block is the
  // merkle check.
  rp.send('cmpctblock', {
    header: mined.block.header.toBuffer().toString('hex'),
    nonce: 'x',
    shortids: [],
    prefilled: [{ index: 0, tx: decoyBlock.transactions[0].toBuffer().toString('hex') }],
  });

  await waitFor(() => rp.got('getdata'), 'node fell back to requesting the full block');
  const items = rp.last('getdata').payload.items;
  ok(items[0].hash === mined.block.id, 'the fallback names the right block');
  ok(!rp.closed, 'a failed reconstruction is not itself a bannable offence');
  ok(V.node.chain.height() === 0, 'the mismatched block was NOT accepted');
  ok(V.p2p.stats.compactFallbacks === 1, 'the fallback was counted');

  console.log('\na sketch whose header fails proof of work');
  const rp2 = rawPeer(V.p2p.actualPort, { height: 1, listenPort: 57773 });
  await waitFor(() => rp2.got('verack'), 'second raw peer handshook');
  const bad = new sv.BlockHeader({
    version: 1,
    prevHash: Buffer.from(V.node.chain.index[0].hash, 'hex').reverse(),
    merkleRoot: sv.crypto.Random.getRandomBuffer(32),
    time: params.genesisTimestamp + 10,
    bits: params.genesisBits,
    nonce: 0,
  });
  while (pow.checkProofOfWork(bad)) bad.nonce++;
  rp2.send('cmpctblock', {
    header: bad.toBuffer().toString('hex'),
    nonce: 'y',
    shortids: [],
    prefilled: [{ index: 0, tx: decoyBlock.transactions[0].toBuffer().toString('hex') }],
  });

  await waitFor(() => rp2.closed, 'the peer was dropped');
  ok(V.p2p.addrBook.isBanned('127.0.0.1:57773'), 'its address was banned');
  ok(V.node.chain.height() === 0, 'the chain did not advance');

  rp.socket.destroy();
  rp2.socket.destroy();
  cleanup(V, H, decoy);
}

// --- 5. negotiation -------------------------------------------------------

async function negotiationTest() {
  console.log('\npeers that do not speak compact');
  const S = mk('S');
  await listen(S.p2p);

  const legacy = rawPeer(S.p2p.actualPort, { height: 0, compact: false, listenPort: 57774 });
  await waitFor(() => legacy.got('verack'), 'legacy peer handshook');

  S.node.mine(new sv.PrivateKey().toAddress());
  await waitFor(() => legacy.got('inv'), 'the legacy peer got a plain inv');
  ok(!legacy.got('cmpctblock'), 'no sketch was sent to a peer that cannot read one');
  ok(
    legacy.last('inv').payload.items[0].hash === S.node.chain.tip().hash,
    'the inv announces the new tip'
  );

  const modern = rawPeer(S.p2p.actualPort, { height: 0, compact: true, listenPort: 57775 });
  await waitFor(() => modern.got('verack'), 'compact-capable peer handshook');
  S.node.mine(new sv.PrivateKey().toAddress());
  await waitFor(() => modern.got('cmpctblock'), 'the capable peer got a sketch');
  ok(!modern.got('inv'), 'and no redundant inv');

  legacy.socket.destroy();
  modern.socket.destroy();
  cleanup(S);
}

async function main() {
  unitTests();
  await relayTest();
  await badSketchTest();
  await negotiationTest();
  console.log(`\nAll ${passed} compact-block checks passed ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  console.error(e);
  process.exit(1);
});
