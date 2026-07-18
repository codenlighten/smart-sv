#!/usr/bin/env node
'use strict';

/**
 * smartsv — CLI wallet/client for a SmartSV node (talks to smartsvd over REST).
 *
 * Usage:
 *   smartsv [--url http://127.0.0.1:8432] <command> [args]
 *
 * Commands:
 *   newkey                         generate a key (wif/address)
 *   info                           node & chain status
 *   block <idOrHeight>             show a block
 *   tx <txid>                      show a transaction
 *   balance <address>              confirmed balance (satoshis + SSV)
 *   utxos <address>                spendable outputs
 *   mine <address>                 mine one block (dev helper)
 *   send <wif> <toAddr> <ssv> [--data "text"]   build+sign+broadcast a payment
 *   data <wif> "text"              write an OP_RETURN data transaction
 */

const { Wallet } = require('../src/wallet');
const params = require('../src/params');

const COIN = params.COIN;

function parse(argv) {
  const out = {
    url: process.env.SMARTSV_URL || `http://127.0.0.1:${params.rpcPort}`,
    apiKey: process.env.SMARTSV_API_KEY || '',
    _: [],
    flags: {},
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--api-key') out.apiKey = argv[++i];
    else if (a.startsWith('--')) out.flags[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

let API_KEY = '';
async function api(url, path, method = 'GET', body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (API_KEY && method !== 'GET') headers['Authorization'] = `Bearer ${API_KEY}`;
  const res = await fetch(url + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const fmt = (sat) => `${sat} sat (${(sat / COIN).toFixed(8)} ${params.ticker})`;

async function main() {
  const opt = parse(process.argv);
  const [cmd, ...rest] = opt._;
  const url = opt.url;
  API_KEY = opt.apiKey;

  try {
    switch (cmd) {
      case 'newkey': {
        console.log(JSON.stringify(Wallet.newKey(), null, 2));
        break;
      }
      case 'info': {
        console.log(JSON.stringify(await api(url, '/info'), null, 2));
        break;
      }
      case 'block': {
        console.log(JSON.stringify(await api(url, `/block/${rest[0]}`), null, 2));
        break;
      }
      case 'tx': {
        console.log(JSON.stringify(await api(url, `/tx/${rest[0]}`), null, 2));
        break;
      }
      case 'balance': {
        const r = await api(url, `/address/${rest[0]}/balance`);
        console.log(fmt(r.balance));
        break;
      }
      case 'utxos': {
        const r = await api(url, `/address/${rest[0]}/utxos`);
        console.log(JSON.stringify(r.utxos, null, 2));
        break;
      }
      case 'mine': {
        const r = await api(url, '/mine', 'POST', { address: rest[0] });
        console.log(`mined block ${r.height} ${r.id} — reward ${fmt(r.reward)}, ${r.txCount} tx`);
        break;
      }
      case 'send': {
        const [wif, toAddr, ssv] = rest;
        const sats = Math.round(Number(ssv) * COIN);
        const { address } = Wallet.fromWIF(wif);
        const { utxos } = await api(url, `/address/${address}/utxos`);
        const picked = Wallet.selectUTXOs(utxos, sats);
        const tx = Wallet.buildPayment(wif, picked, toAddr, sats, { data: opt.flags.data });
        const r = await api(url, '/tx', 'POST', { rawtx: tx.toString() });
        console.log(`broadcast ${r.txid} — fee ${fmt(r.fee)}`);
        break;
      }
      case 'data': {
        const [wif, text] = rest;
        const { address } = Wallet.fromWIF(wif);
        const { utxos } = await api(url, `/address/${address}/utxos`);
        const picked = Wallet.selectUTXOs(utxos, 0);
        const tx = Wallet.buildData(wif, picked, text);
        const r = await api(url, '/tx', 'POST', { rawtx: tx.toString() });
        console.log(`data tx ${r.txid} — fee ${fmt(r.fee)}`);
        break;
      }
      default:
        console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1]);
    }
  } catch (e) {
    console.error('error:', e.message);
    process.exit(1);
  }
}

main();
