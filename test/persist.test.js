'use strict';

/**
 * SmartSV durable-chainstate test. Runs with `node test/persist.test.js`.
 *
 * Proves the node resumes from the SQLite ChainStore WITHOUT replaying or re-
 * validating the chain, and that the persisted state is correct across:
 *   - a normal chain + spend
 *   - a reorg (winning chain, orphaned tx)
 *   - an invalid-branch rejection (invalid marks survive a restart)
 *
 * "No replay" is asserted structurally: before reopening we replace
 * chain.acceptBlock with a tripwire that throws. Loading the chain must go
 * purely through the store (never acceptBlock), so any hidden replay fails.
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

let t = params.genesisTimestamp;
const clock = () => (t += 1);

function craftBlock({ prevId, height, rewardAddr, coinbaseValue, idx }) {
  const coinbase = buildCoinbase(height, coinbaseValue, rewardAddr, Buffer.from([height & 0xff, idx & 0xff, 0, 0, 0, 0, 0, 0]));
  const block = new sv.Block({
    header: { version: 1, prevHash: Buffer.from(prevId, 'hex').reverse(), merkleRoot: Buffer.alloc(32, 0), time: clock(), bits: params.genesisBits, nonce: 0 },
    transactions: [coinbase],
  });
  block.header.merkleRoot = block.getMerkleRoot();
  pow.mine(block.header);
  return block;
}

function main() {
  const dir = path.join(os.tmpdir(), `smartsv-persist-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });

  const minerKey = new sv.PrivateKey();
  const minerA = minerKey.toAddress();
  const minerB = new sv.PrivateKey().toAddress();
  const minerC = new sv.PrivateKey().toAddress();
  const bob = new sv.PrivateKey().toAddress();

  // --- session 1: build chain, spend, reorg, and reject an invalid branch ---
  console.log('session 1: build + reorg + invalid-branch reject');
  const n1 = new Node({ dataDir: dir, now: clock });
  n1.start();
  for (let i = 0; i < 101; i++) n1.mine(minerA);
  const fork = n1.chain.tip().hash;

  // spend a matured coinbase to bob, mine it on chain A (2 blocks)
  const mature = n1.getUTXOs(minerA).find((u) => u.confirmations >= params.coinbaseMaturity);
  const bobTx = new sv.Transaction()
    .from({ txId: mature.txid, outputIndex: mature.outputIndex, script: mature.script, satoshis: mature.satoshis })
    .to(bob, 12 * params.COIN)
    .change(minerA)
    .sign(minerKey);
  n1.submitTransaction(bobTx);
  n1.mine(minerA);
  n1.mine(minerA); // height 103, chain A

  // heavier chain B (crafted, 3 blocks) → triggers a reorg
  const b1 = craftBlock({ prevId: fork, height: 102, rewardAddr: minerB, coinbaseValue: params.initialSubsidy, idx: 1 });
  const b2 = craftBlock({ prevId: b1.id, height: 103, rewardAddr: minerB, coinbaseValue: params.initialSubsidy, idx: 2 });
  const b3 = craftBlock({ prevId: b2.id, height: 104, rewardAddr: minerB, coinbaseValue: params.initialSubsidy, idx: 3 });
  n1.submitBlock(b1);
  n1.submitBlock(b2);
  n1.submitBlock(b3); // reorg → height 104 on chain B

  // invalid heavier branch (over-claim) → rejected
  const c1 = craftBlock({ prevId: fork, height: 102, rewardAddr: minerC, coinbaseValue: params.initialSubsidy + 1, idx: 7 });
  const c2 = craftBlock({ prevId: c1.id, height: 103, rewardAddr: minerC, coinbaseValue: params.initialSubsidy, idx: 8 });
  const c3 = craftBlock({ prevId: c2.id, height: 104, rewardAddr: minerC, coinbaseValue: params.initialSubsidy, idx: 9 });
  const c4 = craftBlock({ prevId: c3.id, height: 105, rewardAddr: minerC, coinbaseValue: params.initialSubsidy, idx: 10 });
  n1.submitBlock(c1);
  n1.submitBlock(c2);
  n1.submitBlock(c3);
  const rc = n1.submitBlock(c4); // activation fails → invalid, rolled back
  ok(rc.status === 'invalid', 'invalid branch rejected in session 1');

  const snapshot = {
    height: n1.chain.height(),
    tip: n1.chain.tip().hash,
    supply: n1.info().supply,
    utxos: n1.chain.utxo.size,
    treeSize: n1.chain.byHash.size,
    minerB: n1.getBalance(minerB),
    bob: n1.getBalance(bob),
    mempool: n1.mempool.size(),
  };
  ok(snapshot.height === 104, 'session 1 settled on chain B at height 104');
  ok(snapshot.bob === 0, 'bob unfunded after reorg (his tx orphaned)');
  ok(snapshot.mempool >= 1, 'orphaned tx sits in mempool (not persisted)');
  n1.close(); // flush WAL & release the DB file

  // --- session 2: reopen; loading MUST NOT replay/validate anything ---
  console.log('session 2: reopen from disk with replay tripwire');
  const n2 = new Node({ dataDir: dir, now: clock });
  const origAccept = n2.chain.acceptBlock.bind(n2.chain);
  n2.chain.acceptBlock = () => {
    throw new Error('replay tripwire: acceptBlock called during load');
  };
  n2.start(); // pure load — the tripwire must not fire
  n2.chain.acceptBlock = origAccept;
  ok(true, 'reopened without replaying blocks through acceptBlock');

  ok(n2.chain.height() === snapshot.height, 'height restored from disk');
  ok(n2.chain.tip().hash === snapshot.tip, 'tip restored from disk');
  ok(n2.info().supply === snapshot.supply, 'supply restored from disk');
  ok(n2.chain.utxo.size === snapshot.utxos, 'UTXO set restored from disk');
  ok(n2.chain.byHash.size === snapshot.treeSize, 'full block tree (incl. side chains) restored');
  ok(n2.getBalance(minerB) === snapshot.minerB, 'winning miner balance restored');
  ok(n2.getBalance(bob) === 0, 'bob still unfunded after restart');

  // The invalid branch must still be rejected (invalid marks persisted).
  const c5 = craftBlock({ prevId: c4.id, height: 106, rewardAddr: minerC, coinbaseValue: params.initialSubsidy, idx: 11 });
  let rejected = false;
  try {
    const r = n2.submitBlock(c5);
    rejected = r.status === 'orphan' || r.status === 'invalid'; // parent c4 is invalid → treated as unknown/invalid
  } catch (e) {
    rejected = e.code === 'bad-prevblk';
  }
  ok(rejected, 'block building on the persisted invalid branch is refused');

  // Chain still extends normally after a restart.
  const b4 = craftBlock({ prevId: snapshot.tip, height: 105, rewardAddr: minerB, coinbaseValue: params.initialSubsidy, idx: 4 });
  const r = n2.submitBlock(b4);
  ok(r.status === 'connected' && n2.chain.height() === 105, 'chain extends normally post-restart');

  n2.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nAll ${passed} persistence checks passed ✅`);
}

main();
