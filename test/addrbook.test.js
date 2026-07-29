'use strict';

/**
 * SmartSV address book + outbound peer management test.
 * Runs with plain `node test/addrbook.test.js`.
 *
 * Part 1 (unit) exercises AddrBook against a fake clock: address hygiene,
 * exponential retry backoff, ranking, bans, self-detection and eviction.
 *
 * Part 2 (integration) is the one that matters operationally: a node learns a
 * peer, is shut down, and on restart — with NO seed peers configured — dials
 * that peer again out of the persisted book and resumes syncing.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const sv = require('../src/sv');
const { Node } = require('../src/node');
const { PeerManager } = require('../src/p2p/manager');
const { AddrBook, RETRY_BASE_SEC, FORGET_FAILURES } = require('../src/p2p/addrbook');
const { ChainStore } = require('../src/store/chainstore');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  console.log('  ✓', label);
  passed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function tmpDir(tag) {
  const dir = path.join(os.tmpdir(), `smartsv-addr-${process.pid}-${tag}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

// --- part 1: AddrBook semantics ------------------------------------------

function unitTests() {
  console.log('address book: hygiene');
  let t = 1000;
  const book = new AddrBook(null, { now: () => t, maxEntries: 3 });

  ok(book.add('1.2.3.4:8433') !== null, 'accepts a well-formed address');
  ok(book.add('bogus') === null, 'rejects an address with no port');
  ok(book.add('1.2.3.4:0') === null, 'rejects port 0');
  ok(book.add('0.0.0.0:8433') === null, 'rejects the wildcard host');
  ok(book.add('undefined:8433') === null, 'rejects an undefined host');
  ok(book.add('::ffff:5.6.7.8:8433').addr === '5.6.7.8:8433', 'unwraps IPv4-mapped IPv6');
  ok(book.size() === 2, 'only the valid addresses were stored');

  console.log('address book: retry backoff');
  const b2 = new AddrBook(null, { now: () => t });
  b2.add('10.0.0.1:8433');
  ok(b2.select(5).length === 1, 'a fresh address is dialable immediately');
  b2.markFailure('10.0.0.1:8433');
  ok(b2.select(5).length === 0, 'a failed address backs off');
  t += RETRY_BASE_SEC - 1;
  ok(b2.select(5).length === 0, 'still backing off just before the delay elapses');
  t += 1;
  ok(b2.select(5).length === 1, 'dialable again once the delay elapses');
  b2.markFailure('10.0.0.1:8433');
  t += RETRY_BASE_SEC;
  ok(b2.select(5).length === 0, 'the second failure doubles the delay');
  t += RETRY_BASE_SEC;
  ok(b2.select(5).length === 1, 'dialable after the doubled delay');
  b2.markSuccess('10.0.0.1:8433');
  ok(b2.get('10.0.0.1:8433').failures === 0, 'a success clears the failure count');

  console.log('address book: ranking');
  const b3 = new AddrBook(null, { now: () => t });
  b3.add('10.0.0.1:1'); // never tried
  b3.add('10.0.0.2:2'); // known good
  b3.add('10.0.0.3:3'); // has failed
  b3.markSuccess('10.0.0.2:2');
  b3.markFailure('10.0.0.3:3');
  t += 3600;
  const order = b3.select(3);
  ok(order[0] === '10.0.0.2:2', 'a previously-connected peer is dialled first');
  ok(order[1] === '10.0.0.1:1', 'a never-tried peer outranks a failed one');
  ok(order[2] === '10.0.0.3:3', 'the failed peer comes last');

  console.log('address book: bans, self-detection, forgetting');
  b3.ban('10.0.0.1:1', 600);
  ok(!b3.select(5).includes('10.0.0.1:1'), 'a banned address is not selected');
  ok(b3.isBanned('10.0.0.1:1'), 'the ban is visible');
  t += 601;
  ok(b3.select(5).includes('10.0.0.1:1'), 'the ban expires');

  b3.markSelf('10.0.0.2:2');
  ok(b3.isBanned('10.0.0.2:2'), 'our own address is shunned');
  ok(b3.get('10.0.0.2:2').source === 'self', 'the self address is tagged');

  const b4 = new AddrBook(null, { now: () => t });
  b4.add('10.9.9.9:8433');
  for (let i = 0; i < FORGET_FAILURES; i++) b4.markFailure('10.9.9.9:8433');
  ok(!b4.has('10.9.9.9:8433'), 'an address that never connects is eventually forgotten');
  b4.add('10.9.9.8:8433', { source: 'seed' });
  for (let i = 0; i < FORGET_FAILURES; i++) b4.markFailure('10.9.9.8:8433');
  ok(b4.has('10.9.9.8:8433'), 'a configured seed is never forgotten');

  console.log('address book: capacity eviction');
  const b5 = new AddrBook(null, { now: () => t, maxEntries: 2 });
  b5.add('10.1.1.1:1');
  b5.markSuccess('10.1.1.1:1'); // known good — must survive
  b5.add('10.1.1.2:2');
  b5.add('10.1.1.3:3');
  b5.markFailure('10.1.1.3:3'); // worst — must be evicted
  ok(b5.size() === 2, 'the book is trimmed to capacity');
  ok(b5.has('10.1.1.1:1'), 'the known-good peer survives eviction');
  ok(!b5.has('10.1.1.3:3'), 'the failing peer is evicted first');

  console.log('address book: SQLite persistence');
  const dir = tmpDir('store');
  const store = new ChainStore(dir);
  const b6 = new AddrBook(store, { now: () => t });
  b6.add('192.168.5.5:8433', { source: 'seed' });
  b6.markSuccess('192.168.5.5:8433');
  b6.add('192.168.5.6:8433');
  b6.ban('192.168.5.6:8433', 900);

  const reopened = new AddrBook(store, { now: () => t });
  ok(reopened.size() === 2, 'entries survive a reopen');
  ok(reopened.get('192.168.5.5:8433').successes === 1, 'success counters persist');
  ok(reopened.get('192.168.5.5:8433').source === 'seed', 'the source persists');
  ok(reopened.isBanned('192.168.5.6:8433'), 'bans persist');

  store.reset(); // wiping chain state must not wipe the peers we know
  ok(new AddrBook(store, { now: () => t }).size() === 2, 'peers survive a chainstate reset');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- part 2: reconnect from the persisted book ---------------------------

function makeNode(tag, opts = {}) {
  const dir = opts.dir || tmpDir(tag);
  const node = new Node({ dataDir: dir });
  node.start();
  const p2p = new PeerManager(node, {
    port: opts.port || 0,
    dialInterval: 300, // keep the test quick
    log: () => {},
  });
  return { node, p2p, dir };
}

function listen(p2p) {
  return new Promise((resolve) => {
    p2p.once('listening', resolve);
    p2p.start();
  });
}

async function integrationTest() {
  console.log('\nautomatic outbound peer management');
  const miner = new sv.PrivateKey().toAddress();

  // A is a long-lived peer on a FIXED port, so B can find it again after a restart.
  const A = makeNode('A');
  await listen(A.p2p);
  const aPort = A.p2p.actualPort;
  for (let i = 0; i < 5; i++) A.node.mine(miner);
  ok(A.node.chain.height() === 5, 'A mined to height 5');

  // B learns about A the normal way: it is dialled as a configured seed.
  const B = makeNode('B');
  await listen(B.p2p);
  B.p2p.connect(`127.0.0.1:${aPort}`, { source: 'seed' });
  await waitFor(() => B.node.chain.height() === 5, 'B syncs from A');
  ok(B.p2p.outboundCount() === 1, 'B holds one outbound connection');

  const known = B.p2p.addrBook.get(`127.0.0.1:${aPort}`);
  ok(known && known.successes === 1, 'B recorded a successful connection to A');
  ok(known.source === 'seed', "B tagged A's address as a seed");

  // Restart B against the SAME datadir, with no seeds configured at all.
  console.log('restart B with no configured seeds');
  B.p2p.stop();
  B.node.close();
  await sleep(200);

  const B2 = makeNode('B2', { dir: B.dir });
  await listen(B2.p2p);
  ok(B2.node.chain.height() === 5, 'B restarted at its persisted height');
  ok(B2.p2p.addrBook.has(`127.0.0.1:${aPort}`), 'B remembered A across the restart');

  // No connect() call here — the dial loop must find A in the book by itself.
  await waitFor(
    () => B2.p2p.addrBook.get(`127.0.0.1:${aPort}`).successes === 2,
    'B auto-dials A from the address book and completes the handshake'
  );
  ok(B2.p2p.outboundCount() === 1, 'B reconnected with no configured seed peers');
  ok(
    B2.p2p.addrBook.get(`127.0.0.1:${aPort}`).source === 'seed',
    'the reconnect was recorded against the same entry'
  );

  // And the resurrected link actually works.
  A.node.mine(miner);
  await waitFor(() => B2.node.chain.height() === 6, 'block relays over the re-established link');
  ok(B2.node.chain.tip().hash === A.node.chain.tip().hash, 'B is back in sync with A');

  console.log('the dialer skips bad addresses');
  const C = makeNode('C');
  await listen(C.p2p);
  // A dead address (nothing listening) and A's live one.
  const dead = '127.0.0.1:1'; // port 1: connection refused
  C.p2p.addrBook.add(dead, { source: 'gossip' });
  C.p2p.addrBook.add(`127.0.0.1:${aPort}`, { source: 'gossip' });
  await waitFor(() => C.p2p.outboundCount() === 1, 'C connects to the live peer');
  await waitFor(() => C.p2p.addrBook.get(dead).failures > 0, 'the dead address is marked failed');
  ok(C.p2p.addrBook.backoffRemaining(C.p2p.addrBook.get(dead)) > 0, 'the dead address backs off');
  ok(C.p2p.outboundCount() === 1, 'C did not exceed one live outbound peer');

  console.log('a node refuses to dial itself');
  const selfAddr = `127.0.0.1:${C.p2p.actualPort}`;
  C.p2p.connect(selfAddr, { source: 'gossip' });
  await waitFor(() => C.p2p.addrBook.get(selfAddr).source === 'self', 'self-connection detected');
  ok(C.p2p.addrBook.isBanned(selfAddr), "the node's own address is banned from the dialer");
  ok(!C.p2p.addrBook.select(10).includes(selfAddr), 'the dialer will not pick it again');

  for (const n of [A, B2, C]) {
    n.p2p.stop();
    n.node.close();
    fs.rmSync(n.dir, { recursive: true, force: true });
  }
}

async function main() {
  unitTests();
  await integrationTest();
  console.log(`\nAll ${passed} address-book checks passed ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  console.error(e);
  process.exit(1);
});
