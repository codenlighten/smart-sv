'use strict';

/**
 * SmartSV P2P reorg-convergence test. Runs with `node test/p2p-reorg.test.js`.
 *
 * Two nodes mine DIVERGENT chains from the shared genesis (different miners →
 * different blocks). When they connect, the node on the lighter chain must find
 * the common ancestor via the block locator and reorganise onto the heavier
 * chain purely through gossip.
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

let t = params.genesisTimestamp;
const clock = () => (t += 1);

function mk(tag) {
  const dir = path.join(os.tmpdir(), `smartsv-p2preorg-${process.pid}-${tag}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const node = new Node({ dataDir: dir, now: clock });
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
  const X = mk('X');
  const Y = mk('Y');

  console.log('divergent chains: X mines 5, Y mines 8 (different miners)');
  const kx = new sv.PrivateKey().toAddress();
  const ky = new sv.PrivateKey().toAddress();
  for (let i = 0; i < 5; i++) X.node.mine(kx);
  for (let i = 0; i < 8; i++) Y.node.mine(ky);
  ok(X.node.chain.height() === 5 && Y.node.chain.height() === 8, 'X=5, Y=8');
  ok(X.node.chain.tip().hash !== Y.node.chain.tip().hash, 'chains diverge from genesis');
  const tipY = Y.node.chain.tip().hash;

  let xReorg = false;
  X.node.on('block', (e) => {
    if (e.reorg) xReorg = true;
  });

  console.log('connect X → Y and let gossip converge them');
  await Promise.all([listen(X.p2p), listen(Y.p2p)]);
  X.p2p.connect(`127.0.0.1:${Y.p2p.actualPort}`);

  await waitFor(() => X.node.chain.height() === 8, 'X reorganised up to height 8');
  ok(X.node.chain.tip().hash === tipY, 'X converged onto Y’s heavier chain');
  ok(xReorg, 'X emitted a reorg while converging');
  ok(Y.node.chain.height() === 8 && Y.node.chain.tip().hash === tipY, 'Y (heavier) stayed put');
  ok(X.node.getBalance(ky) === 8 * params.initialSubsidy, 'X now credits Y’s miner');
  ok(X.node.getBalance(kx) === 0, 'X’s own orphaned coinbases are gone');

  console.log('a new block on Y now propagates to the converged X');
  Y.node.mine(ky); // height 9
  await waitFor(() => X.node.chain.height() === 9, 'post-convergence block relays X←Y');
  ok(X.node.chain.tip().hash === Y.node.chain.tip().hash, 'X and Y share the tip');

  for (const n of [X, Y]) {
    n.p2p.stop();
    fs.rmSync(n.dir, { recursive: true, force: true });
  }
  console.log(`\nAll ${passed} P2P-reorg checks passed ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  console.error(e);
  process.exit(1);
});
