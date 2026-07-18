'use strict';

/**
 * SmartSV P2P integration test. Runs with plain `node test/p2p.test.js`.
 *
 * Spins up three in-process nodes on real TCP sockets and verifies:
 *   - handshake + peer discovery (C learns A via B's addr gossip)
 *   - initial block download (B and C sync A's chain from height 0)
 *   - block relay (A mines a new tip; it propagates to B and C)
 *   - transaction relay (A broadcasts a tx; it gossips into B's and C's mempool)
 *   - a relayed tx is mined and the resulting block propagates network-wide
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const sv = require('../src/sv');
const { Node } = require('../src/node');
const { PeerManager } = require('../src/p2p/manager');
const params = require('../src/params');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  console.log('  ✓', label);
  passed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function makeNode(tag) {
  const dir = path.join(os.tmpdir(), `smartsv-p2p-${process.pid}-${tag}`);
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

async function main() {
  const A = makeNode('A');
  const B = makeNode('B');
  const C = makeNode('C');
  const all = [A, B, C];

  // A builds a chain of 101 blocks BEFORE anyone connects.
  console.log('setup: A mines 101 blocks solo');
  const miner = new sv.PrivateKey();
  const minerAddr = miner.toAddress();
  for (let i = 0; i < 101; i++) A.node.mine(minerAddr);
  ok(A.node.chain.height() === 101, 'A solo-mined to height 101');
  const tipA = A.node.chain.tip().hash;

  console.log('start P2P + connect B→A, C→B');
  await Promise.all(all.map((n) => listen(n.p2p)));
  B.p2p.connect(`127.0.0.1:${A.p2p.actualPort}`);
  C.p2p.connect(`127.0.0.1:${B.p2p.actualPort}`);

  console.log('initial block download');
  await waitFor(() => B.node.chain.height() === 101, 'B syncs to 101');
  await waitFor(() => C.node.chain.height() === 101, 'C syncs to 101');
  ok(B.node.chain.tip().hash === tipA, 'B tip hash matches A');
  ok(C.node.chain.tip().hash === tipA, 'C tip hash matches A');
  ok(B.node.info().supply === A.node.info().supply, 'B supply matches A');

  console.log('peer discovery (addr gossip)');
  // C connected only to B, but should learn A's address via getaddr/addr.
  await waitFor(
    () => [...C.p2p.addrBook.keys()].some((a) => a.endsWith(`:${A.p2p.actualPort}`)),
    'C learns A via addr gossip'
  );
  ok(true, 'C discovered A through B');

  console.log('block relay');
  const relayed = A.node.mine(minerAddr); // A mines block 102
  ok(relayed.height === 102, 'A mined block 102');
  await waitFor(() => B.node.chain.height() === 102, 'block 102 relayed to B');
  await waitFor(() => C.node.chain.height() === 102, 'block 102 relayed to C');
  ok(
    C.node.chain.tip().hash === A.node.chain.tip().hash,
    'C tip equals A tip after relay'
  );

  console.log('transaction relay');
  const bob = new sv.PrivateKey();
  const mature = A.node
    .getUTXOs(minerAddr)
    .find((u) => u.confirmations >= params.coinbaseMaturity);
  const tx = new sv.Transaction()
    .from({ txId: mature.txid, outputIndex: mature.outputIndex, script: mature.script, satoshis: mature.satoshis })
    .to(bob.toAddress(), 7 * params.COIN)
    .addData('gossiped across the SmartSV network')
    .change(minerAddr)
    .sign(miner);
  const { txid } = A.node.submitTransaction(tx);
  await waitFor(() => B.node.mempool.has(txid), 'tx relayed into B mempool');
  await waitFor(() => C.node.mempool.has(txid), 'tx relayed into C mempool (multi-hop)');

  console.log('mine the relayed tx and propagate');
  A.node.mine(minerAddr); // block 103 includes the tx
  await waitFor(() => B.node.chain.height() === 103, 'block 103 relayed to B');
  await waitFor(() => C.node.chain.height() === 103, 'block 103 relayed to C');
  await waitFor(() => B.node.mempool.size() === 0, 'B mempool drained after block');
  ok(C.node.getBalance(bob.toAddress()) === 7 * params.COIN, 'C sees bob funded on-chain');

  // Cleanup
  for (const n of all) {
    n.p2p.stop();
    fs.rmSync(n.dir, { recursive: true, force: true });
  }
  console.log(`\nAll ${passed} P2P checks passed ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  console.error(e);
  process.exit(1);
});
