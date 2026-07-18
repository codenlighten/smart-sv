'use strict';

/**
 * SmartSV fork & reorg test. Runs with plain `node test/reorg.test.js`.
 *
 * Verifies:
 *   - a side chain is stored but not activated while it has less work
 *   - the chain reorganises to a heavier competing chain
 *   - the UTXO set follows the winning chain (orphaned coinbase disappears,
 *     the winning coinbases appear)
 *   - a transaction confirmed only on the losing chain returns to the mempool
 *   - a heavier but INVALID chain is rejected and the valid chain is restored
 *     (reorg rollback), leaving height and UTXO state untouched
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const sv = require('../src/sv');
const { Node } = require('../src/node');
const params = require('../src/params');
const pow = require('../src/pow');
const { buildCoinbase } = require('../src/consensus');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  console.log('  ✓', label);
  passed++;
}

// Shared monotonic clock so all block timestamps are deterministic & increasing.
let t = params.genesisTimestamp;
const clock = () => (t += 1);

function mkNode(tag) {
  const dir = path.join(os.tmpdir(), `smartsv-reorg-${process.pid}-${tag}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const node = new Node({ dataDir: dir, now: clock });
  node.start();
  return { node, dir };
}

/** Craft a fully-mined block with full control — used to build an INVALID chain. */
function craftBlock({ prevId, height, rewardAddr, coinbaseValue, idx }) {
  const coinbase = buildCoinbase(
    height,
    coinbaseValue,
    rewardAddr,
    Buffer.from([height & 0xff, idx & 0xff, 0, 0, 0, 0, 0, 0])
  );
  const block = new sv.Block({
    header: {
      version: 1,
      prevHash: Buffer.from(prevId, 'hex').reverse(),
      merkleRoot: Buffer.alloc(32, 0),
      time: clock(),
      bits: params.genesisBits,
      nonce: 0,
    },
    transactions: [coinbase],
  });
  block.header.merkleRoot = block.getMerkleRoot();
  pow.mine(block.header);
  return block;
}

function main() {
  const N = mkNode('N'); // node under test
  const F = mkNode('F'); // factory building the competing (heavier) chain

  const minerKey = new sv.PrivateKey(); // we own this so we can spend its coinbases
  const minerA = minerKey.toAddress();
  const minerB = new sv.PrivateKey().toAddress(); // chain B rewards
  const minerC = new sv.PrivateKey().toAddress(); // invalid chain rewards
  const bob = new sv.PrivateKey().toAddress();

  // --- common chain to height 101 ---
  console.log('common chain (height 101)');
  for (let i = 0; i < 101; i++) N.node.mine(minerA);
  for (let h = 1; h <= 101; h++) F.node.submitBlock(N.node.chain.getBlockByHeight(h));
  ok(N.node.chain.height() === 101 && F.node.chain.height() === 101, 'N and F share height 101');
  ok(N.node.chain.tip().hash === F.node.chain.tip().hash, 'N and F share the same tip');
  const fork = N.node.chain.tip().hash;
  const supplyAt101 = N.node.info().supply;

  // --- chain A on N (with a tx), chain B on F (heavier) ---
  console.log('fork: chain A (2 blocks, on N) vs chain B (3 blocks, on F)');
  const mature = N.node.getUTXOs(minerA).find((u) => u.confirmations >= params.coinbaseMaturity);
  const bobTx = new sv.Transaction()
    .from({ txId: mature.txid, outputIndex: mature.outputIndex, script: mature.script, satoshis: mature.satoshis })
    .to(bob, 25 * params.COIN)
    .change(minerA)
    .sign(minerKey);
  N.node.submitTransaction(bobTx);
  N.node.mine(minerA); // block 102a — includes bobTx
  N.node.mine(minerA); // block 103a
  ok(N.node.chain.height() === 103, 'N built chain A to height 103');
  ok(N.node.getBalance(bob) === 25 * params.COIN, 'bob is funded on chain A');
  const tipA = N.node.chain.tip().hash;

  // Chain B on F: three blocks (heavier than A's two above the fork).
  for (let i = 0; i < 4; i++) F.node.mine(minerB); // heights 102..105 → height 105
  ok(F.node.chain.height() === 105, 'F built chain B to height 105');
  const tipB = F.node.chain.tip().hash;
  const blocksB = [];
  for (let h = 102; h <= 105; h++) blocksB.push(F.node.chain.getBlockByHeight(h));

  // --- feed chain B to N and observe fork choice + reorg ---
  console.log('feed chain B to N');
  let reorgSeen = false;
  N.node.on('block', (e) => {
    if (e.reorg) reorgSeen = true;
  });

  // First B block: same height as A's 102 → equal-or-less work → side chain only.
  const r1 = N.node.submitBlock(blocksB[0]);
  ok(r1.status === 'sidechain', 'first competing block stored as side chain (no reorg)');
  ok(N.node.chain.tip().hash === tipA, 'N still on chain A after one side block');

  // Feed the rest; once B outweighs A, N must reorganise to B.
  for (let i = 1; i < blocksB.length; i++) N.node.submitBlock(blocksB[i]);
  ok(N.node.chain.height() === 105, 'N reorganised to height 105');
  ok(N.node.chain.tip().hash === tipB, 'N tip now equals chain B tip');
  ok(reorgSeen, 'a reorg event was emitted');

  // --- UTXO / balance consequences of the reorg ---
  console.log('UTXO follows the winning chain');
  ok(N.node.getBalance(bob) === 0, 'bob no longer funded (his tx was orphaned)');
  ok(N.node.getBalance(minerB) === 4 * params.initialSubsidy, 'chain B coinbases now in the UTXO set');
  ok(N.node.mempool.has(bobTx.hash), 'orphaned tx returned to the mempool');
  // Supply = 101 common + 4 chain-B subsidies (chain A subsidies are orphaned).
  ok(
    N.node.info().supply === supplyAt101 + 4 * params.initialSubsidy,
    'total supply reflects the winning chain only'
  );

  // --- invalid heavier chain must be rejected (reorg rollback) ---
  console.log('reject a heavier but INVALID chain');
  const heightBefore = N.node.chain.height();
  const tipBefore = N.node.chain.tip().hash;
  const supplyBefore = N.node.info().supply;

  // Chain C from the fork point: block 102c over-claims its coinbase (invalid),
  // then two valid blocks extend it so chain C would outweigh chain B (height 106).
  const c102 = craftBlock({
    prevId: fork,
    height: 102,
    rewardAddr: minerC,
    coinbaseValue: params.initialSubsidy + 1, // over-claim: invalid at connect time
    idx: 1,
  });
  const c103 = craftBlock({ prevId: c102.id, height: 103, rewardAddr: minerC, coinbaseValue: params.initialSubsidy, idx: 2 });
  const c104 = craftBlock({ prevId: c103.id, height: 104, rewardAddr: minerC, coinbaseValue: params.initialSubsidy, idx: 3 });
  const c105 = craftBlock({ prevId: c104.id, height: 105, rewardAddr: minerC, coinbaseValue: params.initialSubsidy, idx: 4 });
  const c106 = craftBlock({ prevId: c105.id, height: 106, rewardAddr: minerC, coinbaseValue: params.initialSubsidy, idx: 5 });

  ok(N.node.submitBlock(c102).status === 'sidechain', 'invalid block 102c stored as side chain (contextually valid)');
  N.node.submitBlock(c103);
  N.node.submitBlock(c104);
  N.node.submitBlock(c105);
  const rc = N.node.submitBlock(c106); // triggers activation → connect 102c fails → rollback
  ok(rc.status === 'invalid', 'activation of the invalid chain reported invalid');
  ok(rc.code === 'bad-cb-amount', 'rejected for the coinbase over-claim');
  ok(N.node.chain.height() === heightBefore, 'height unchanged after rejected reorg');
  ok(N.node.chain.tip().hash === tipBefore, 'tip restored to the valid chain');
  ok(N.node.info().supply === supplyBefore, 'UTXO/supply untouched by the rejected reorg');

  cleanup([N, F]);
  console.log(`\nAll ${passed} reorg checks passed ✅`);
}

function cleanup(nodes) {
  for (const n of nodes) fs.rmSync(n.dir, { recursive: true, force: true });
}

main();
