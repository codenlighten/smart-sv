'use strict';

/**
 * SmartSV side-chain pruning test. Runs with `node test/prune.test.js`.
 *
 * A node that has lived through a few forks accumulates block bodies it will
 * never use again. Once a losing fork is buried deeper than `pruneDepth` it can
 * only take over via a reorg deeper than the node is willing to perform, so the
 * body is dead weight — at 32 MB a block, expensive dead weight.
 *
 * These checks cover the whole bargain, including the part we give up:
 *   1. bodies of deeply-buried side chains are dropped, from memory AND SQLite
 *   2. the active chain, recent forks, and the UTXO set are untouched
 *   3. the index entry survives, so the fork is still recognised (never
 *      re-downloaded) and pruning survives a restart
 *   4. the cost: a reorg onto a pruned fork is refused rather than mis-applied
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const sv = require('../src/sv');
const params = require('../src/params');
const { Node } = require('../src/node');
const { mineBlock } = require('../src/miner');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  console.log('  ✓', label);
  passed++;
}

let clock = params.genesisTimestamp;
const tick = () => (clock += 1);

function mk(tag, opts = {}) {
  const dir = opts.dir || path.join(os.tmpdir(), `smartsv-prune-${process.pid}-${tag}`);
  if (!opts.dir) fs.rmSync(dir, { recursive: true, force: true });
  const node = new Node({ dataDir: dir, now: tick });
  // Shallow depth keeps the test fast; the mechanism is identical at 100.
  node.chain.pruneDepth = opts.pruneDepth != null ? opts.pruneDepth : 10;
  node.chain.pruneInterval = opts.pruneInterval != null ? opts.pruneInterval : 5;
  node.start();
  return { node, dir };
}

/** Mine a block onto an explicit parent, so we can build a competing fork. */
function mineOnto(node, parentNode, address) {
  const saved = node.chain.active;
  // mineBlock builds on the active tip, so temporarily present `parentNode` as it.
  node.chain.active = saved.slice(0, parentNode.height + 1);
  node.chain.active[parentNode.height] = parentNode;
  try {
    const { block } = mineBlock(node.chain, node.mempool, address, { now: tick() });
    return block;
  } finally {
    node.chain.active = saved;
  }
}

function main() {
  console.log('build a chain with a losing fork near the bottom');
  const A = mk('A');
  const miner = new sv.PrivateKey().toAddress();
  const rival = new sv.PrivateKey().toAddress();

  for (let i = 0; i < 5; i++) A.node.mine(miner);
  const forkParent = A.node.chain.active[3]; // fork from height 3
  ok(A.node.chain.height() === 5, 'main chain at height 5');

  // Two competing blocks at height 4 and 5 that lose the race.
  const rivalA = mineOnto(A.node, forkParent, rival);
  ok(A.node.submitBlock(rivalA).status === 'sidechain', 'rival block 4 is a side chain');
  const rivalNode = A.node.chain.byHash.get(rivalA.id);
  const rivalB = mineOnto(A.node, rivalNode, rival);
  ok(A.node.submitBlock(rivalB).status === 'sidechain', 'rival block 5 extends the side chain');
  ok(A.node.chain.height() === 5, 'the active chain did not move');
  ok(A.node.chain.byHash.size === 8, 'the tree holds 6 main + 2 side-chain blocks');

  console.log('the fork is still shallow: nothing is pruned yet');
  A.node.chain.pruneSideChains();
  ok(A.node.chain.prunedCount === 0, 'a fork within pruneDepth of the tip is kept');
  ok(!!A.node.chain.getBlock(rivalA.id), 'its body is still available');

  console.log('bury the fork past pruneDepth');
  for (let i = 0; i < 12; i++) A.node.mine(miner);
  ok(A.node.chain.height() === 17, 'main chain at height 17');
  // The interval sweep runs on tip changes; make the assertion independent of it.
  A.node.chain.pruneSideChains();

  ok(A.node.chain.prunedCount === 2, 'both buried side-chain blocks were pruned');
  ok(A.node.chain.getBlock(rivalA.id) === undefined, 'the pruned body is gone from memory');
  ok(A.node.chain.isPruned(rivalA.id), 'the block is reported as pruned');
  ok(A.node.chain.byHash.has(rivalA.id), 'but the index entry remains — we still know the hash');
  ok(A.node.chain.byHash.get(rivalA.id).chainwork.gtn(0), 'its cumulative work is preserved');

  console.log('the active chain is untouched');
  ok(A.node.chain.byHash.size === 20, 'the tree still indexes every block it ever saw');
  for (let h = 0; h <= 17; h++) {
    assert.ok(A.node.chain.getBlockByHeight(h), `active block ${h} still has its body`);
  }
  ok(true, 'every active-chain block kept its body');
  ok(A.node.getBalance(miner) > 0, 'the UTXO set is intact');
  ok(A.node.getBalance(rival) === 0, 'the losing miner was never credited');

  console.log('pruning reaches SQLite, not just memory');
  ok(A.node.store.countPrunedBlocks() === 2, 'both blocks are in the pruned index');
  ok(A.node.store.getBlockRow(rivalA.id) === undefined, 'their bodies are deleted from blocks');
  ok(!!A.node.store.getBlockRow(A.node.chain.tip().hash), 'the active tip body is still stored');

  console.log('pruning survives a restart');
  const tipBefore = A.node.chain.tip().hash;
  const supplyBefore = A.node.info().supply;
  A.node.close();
  const A2 = mk('A2', { dir: A.dir });
  ok(A2.node.chain.tip().hash === tipBefore, 'the node reloaded the same tip');
  ok(A2.node.chain.height() === 17, 'at the same height');
  ok(A2.node.info().supply === supplyBefore, 'with the same supply');
  ok(A2.node.chain.byHash.has(rivalA.id), 'the pruned fork is still indexed after reload');
  ok(A2.node.chain.isPruned(rivalA.id), 'and still marked pruned');
  ok(A2.node.chain.getBlock(rivalA.id) === undefined, 'its body did not come back');
  ok(A2.node.chain.prunedCount === 2, 'the pruned count was restored');

  console.log('a reorg onto a pruned fork is refused, not mis-applied');
  let refused = null;
  A2.node.chain.on('deep-reorg-refused', (e) => (refused = e));
  // Extend the pruned fork until it out-works the active chain.
  let parent = A2.node.chain.byHash.get(rivalB.id);
  let last = null;
  for (let i = 0; i < 14; i++) {
    const block = mineOnto(A2.node, parent, rival);
    last = A2.node.submitBlock(block);
    parent = A2.node.chain.byHash.get(block.id);
  }
  ok(parent.height === 19, 'the rival fork now reaches height 19, above our tip');
  ok(parent.chainwork.gt(A2.node.chain.tip().chainwork), 'and carries more work');
  ok(last.status === 'sidechain', 'the heavier fork is still only a side chain');
  ok(!!last.prunedAncestor, 'the result names the pruned ancestor that blocked it');
  ok(refused !== null, 'the node emitted deep-reorg-refused');
  ok(A2.node.chain.tip().hash === tipBefore, 'the active tip did NOT move');
  ok(A2.node.chain.height() === 17, 'the node stayed on its own chain');
  ok(A2.node.getBalance(rival) === 0, 'no rival coinbase was credited');

  console.log('pruning can be turned off');
  const B = mk('B', { pruneDepth: 0 });
  for (let i = 0; i < 5; i++) B.node.mine(miner);
  const bFork = mineOnto(B.node, B.node.chain.active[1], rival);
  B.node.submitBlock(bFork);
  for (let i = 0; i < 20; i++) B.node.mine(miner);
  B.node.chain.pruneSideChains();
  ok(B.node.chain.prunedCount === 0, 'pruneDepth 0 keeps every body');
  ok(!!B.node.chain.getBlock(bFork.id), 'the old fork body is still there');

  A2.node.close();
  B.node.close();
  fs.rmSync(A.dir, { recursive: true, force: true });
  fs.rmSync(B.dir, { recursive: true, force: true });
  console.log(`\nAll ${passed} pruning checks passed ✅`);
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error('\nFAILED:', e.message);
  console.error(e);
  process.exit(1);
}
