'use strict';

/**
 * SmartSV end-to-end test. Runs with plain `node test/e2e.test.js` (no test
 * framework). Exercises: genesis bootstrap, mining + subsidy, coinbase
 * maturity, full script/BIP143 validation, OP_RETURN data, mempool, block
 * validation rejections, disk persistence + replay, and the WebSocket feed.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const sv = require('../src/sv');
const { Node } = require('../src/node');
const { createServer } = require('../src/api/server');
const params = require('../src/params');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  console.log('  ✓', label);
  passed++;
}

function freshDir() {
  const dir = path.join(os.tmpdir(), 'smartsv-e2e-' + process.pid + '-' + passed);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

async function main() {
  const dir = freshDir();
  // deterministic monotonic clock
  let t = params.genesisTimestamp;
  const clock = () => (t += 1);

  console.log('genesis & mining');
  const node = new Node({ dataDir: dir, now: clock });
  node.start();
  ok(node.chain.height() === 0, 'starts at genesis (height 0)');
  ok(node.chain.tip().hash.length === 64, 'genesis has a valid id');

  const miner = new sv.PrivateKey();
  const minerAddr = miner.toAddress();

  const first = node.mine(minerAddr);
  ok(first.reward === params.initialSubsidy, `block 1 reward = ${params.initialSubsidy}`);
  ok(node.chain.height() === 1, 'height advances to 1');

  for (let i = 0; i < 100; i++) node.mine(minerAddr);
  ok(node.chain.height() === 101, 'mined to height 101');
  ok(node.getBalance(minerAddr) === 101 * params.initialSubsidy, 'miner balance = 101 subsidies');

  console.log('coinbase maturity');
  const immature = node.getUTXOs(minerAddr).find((u) => u.confirmations < params.coinbaseMaturity);
  let rejected = false;
  try {
    const tx = new sv.Transaction()
      .from({ txId: immature.txid, outputIndex: immature.outputIndex, script: immature.script, satoshis: immature.satoshis })
      .to(new sv.PrivateKey().toAddress(), 1e8)
      .change(minerAddr)
      .sign(miner);
    node.submitTransaction(tx);
  } catch (e) {
    rejected = e.code === 'bad-txns-premature-spend-of-coinbase';
  }
  ok(rejected, 'immature coinbase spend rejected');

  console.log('payment + OP_RETURN');
  const bob = new sv.PrivateKey();
  const mature = node.getUTXOs(minerAddr).find((u) => u.confirmations >= params.coinbaseMaturity);
  const message = 'SmartSV — data on our own chain';
  const payTx = new sv.Transaction()
    .from({ txId: mature.txid, outputIndex: mature.outputIndex, script: mature.script, satoshis: mature.satoshis })
    .to(bob.toAddress(), 25 * params.COIN)
    .addData(message)
    .change(minerAddr)
    .sign(miner);
  const sub = node.submitTransaction(payTx);
  ok(node.mempool.size() === 1, 'tx enters mempool');
  ok(sub.fee > 0, 'positive fee computed');

  const mined = node.mine(minerAddr);
  ok(mined.block.transactions.length === 2, 'block includes coinbase + payment');
  ok(node.mempool.size() === 0, 'mempool drained after mining');
  ok(node.getBalance(bob.toAddress()) === 25 * params.COIN, 'bob received 25 SSV');

  const onChain = node.getTransaction(sub.txid);
  const dataOut = onChain.tx.outputs.find((o) => o.script.isDataOut());
  ok(dataOut && dataOut.script.getData().toString() === message, 'OP_RETURN data readable on-chain');

  console.log('double-spend rejection');
  let dsRejected = false;
  try {
    node.submitTransaction(payTx); // already mined -> inputs gone
  } catch (e) {
    dsRejected = true;
  }
  ok(dsRejected, 'already-spent tx rejected from mempool');

  console.log('persistence & replay');
  const heightBefore = node.chain.height();
  const tipBefore = node.chain.tip().hash;
  const supplyBefore = node.info().supply;
  const node2 = new Node({ dataDir: dir, now: clock });
  node2.start();
  ok(node2.chain.height() === heightBefore, 'reloaded height matches');
  ok(node2.chain.tip().hash === tipBefore, 'reloaded tip hash matches');
  ok(node2.info().supply === supplyBefore, 'reloaded supply matches');
  ok(node2.getBalance(bob.toAddress()) === 25 * params.COIN, 'balances survive restart');

  console.log('REST + WebSocket');
  await new Promise((resolve, reject) => {
    const { server } = createServer(node2);
    server.listen(0, async () => {
      try {
        const port = server.address().port;
        const base = `http://127.0.0.1:${port}`;
        const info = await (await fetch(base + '/info')).json();
        ok(info.height === heightBefore, 'GET /info returns chain height');

        const WebSocket = require('ws');
        const ws = new WebSocket(base.replace('http', 'ws'));
        const gotBlock = new Promise((res) => {
          ws.on('message', (m) => {
            const msg = JSON.parse(m);
            if (msg.type === 'block') res(msg);
          });
        });
        await new Promise((r) => ws.on('open', r));
        // mine over REST to trigger a push
        await fetch(base + '/mine', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: minerAddr.toString() }),
        });
        const evt = await gotBlock;
        ok(evt.height === heightBefore + 1, 'WebSocket pushed the new block event');
        ws.close();
        server.close(resolve);
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nAll ${passed} checks passed ✅`);
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  console.error(e);
  process.exit(1);
});
