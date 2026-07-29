# SmartSV

[![CI](https://github.com/codenlighten/smart-sv/actions/workflows/ci.yml/badge.svg)](https://github.com/codenlighten/smart-sv/actions/workflows/ci.yml)

A **standalone UTXO blockchain** — its own genesis, network, and consensus,
built for big blocks, unrestricted Bitcoin Script, and cheap on-chain data.

SmartSV pairs a from-scratch node (proof-of-work, UTXO set, mempool, P2P,
fork/reorg handling, durable storage) with a battle-tested **primitives library**
for the cryptography and transaction/script/block formats. That means anything
you can build with standard Bitcoin primitives — HD wallets, multisig, covenants,
OP_RETURN data, DIDs, verifiable credentials — works on SmartSV, on a chain you
run end-to-end.

```
 wallet / dApp  ──builds txs──▶  primitives library  ──▶  signed transactions
                                                                   │
                                                                   ▼
                                                        ┌─────────────────────┐
                                                        │      SmartSV node    │
                                                        │  mempool → validate  │
                                                        │  UTXO set → PoW block│
                                                        └─────────────────────┘
```

## What it implements

| Layer | Detail |
|-------|--------|
| **Proof of Work** | Real SHA256d PoW with compact-`bits` targets and difficulty retargeting (`src/pow.js`). Ships at a regtest-low target so blocks mine in milliseconds; raise `genesisBits` / enable `retargeting` in `src/params.js` for a slower chain. |
| **Transactions** | Standard Bitcoin-format transactions built and signed by the primitives library. Full **Script execution** via `Script.Interpreter` and **BIP143 signature** verification with `SIGHASH_FORKID`. |
| **UTXO set** | Authoritative unspent-output set with a layered overlay for atomic per-block application (`src/utxoset.js`). |
| **Validation** | Full transaction + block validation: script/sig checks, fees, no double-spends, coinbase maturity, subsidy/halving limits, merkle root, median-time-past, PoW (`src/validation.js`). |
| **OP_RETURN data** | First-class on-chain data carriers. Coinbase and regular txs can embed arbitrary data. |
| **Mempool** | Fee-rate-ordered pool that accepts chains of unconfirmed txs and reconciles on each new block (`src/mempool.js`). |
| **Chain state** | Full **block tree** with per-block cumulative chainwork, side-chain storage, an orphan pool, and median-time-past (`src/blockchain.js`). |
| **Durable storage** | A transactional **SQLite chainstate** (`src/store/chainstore.js`) is the source of truth for the block tree, UTXO set, undo data and tip. Startup **loads** the working set — no chain replay or re-validation — and every tip change (extension or multi-block reorg) commits atomically, so a crash mid-reorg can't corrupt state. |
| **Fork choice & reorg** | Heaviest-chainwork fork choice. When a side chain outweighs the active tip the chain **reorganises**: active blocks are disconnected (UTXO changes reversed via stored undo data) and the side chain is connected forward with full re-validation. An invalid heavier chain is **rolled back** and the valid chain restored. The mempool returns transactions orphaned by a reorg. |
| **P2P network** | Real Bitcoin-style TCP wire protocol: `networkMagic`-framed, sha256d-checksummed messages; version/verack handshake with self-connection detection; `inv`/`getdata` gossip relay of new blocks and txs; `getaddr`/`addr` peer discovery; ping/pong keep-alive (`src/p2p/`). |
| **Headers-first sync** | Initial block download runs `getheaders → headers → getdata → block`: the most-work chain is established from 80-byte headers, each PoW-checked and linked to a block we already hold, *before* a single body is fetched. Bodies then download in a capped in-flight window along that path, and the header index is pruned as they connect. A peer cannot make the node buffer bodies for a chain it hasn't done the work for (`src/p2p/headerchain.js`). |
| **Side-chain pruning** | A losing fork buried more than `pruneDepth` (default 100) below the tip can only win through a reorg deeper than the node will perform, so its block bodies are discarded from memory and SQLite. A body-less index entry stays behind, keeping the tree shape and cumulative work — the fork is still recognised and never re-downloaded. The trade is explicit: a reorg through a pruned fork is refused and logged, never mis-applied. `SMARTSV_PRUNE_DEPTH=0` keeps everything. |
| **Compact block relay** | New tips are announced as a sketch — header, nonce, one 6-byte short id per transaction, coinbase prefilled — so a peer that has been relaying transactions rebuilds the block from its own mempool and asks only for what it is missing (`getblocktxn`/`blocktxn`). Short ids are salted per announcement, and a rebuilt block is only accepted if its merkle root matches the header; anything else falls back to a full fetch (`src/p2p/compact.js`). |
| **Address book** | Every address learned from `version`/`addr` gossip is persisted to SQLite with its dial history. A background dialer keeps `targetOutbound` connections open, preferring peers that have connected before, backing off exponentially from failures, banning misbehaving addresses, and shunning the node's own. A restarted node reconnects from the book without any configured seed (`src/p2p/addrbook.js`). |
| **Node + API** | A `Node` class wiring it together, plus a REST + WebSocket server (`src/node.js`, `src/api/server.js`). The P2P layer drives the node purely through the same `submitTransaction` / `submitBlock` entry points. |
| **Daemon + CLI** | `smartsvd` full-node daemon and `smartsv` CLI wallet/client. Env-driven config, structured logging, graceful shutdown. |
| **Production API** | Bearer **API-key auth** on mutating routes, `/health` + `/ready` probes, Prometheus `/metrics`. |
| **Deployment** | Multi-stage **Dockerfile**, docker-compose, Caddy TLS proxy, and **DigitalOcean Terraform** (seed + N peers, VPC, firewall, reserved IP). See [DEPLOY.md](DEPLOY.md). |

## Quick start

```bash
npm install

# run the test suites:
#   e2e       — genesis → mining → spend → OP_RETURN → persistence → WS
#   reorg     — competing chains, heaviest-work reorg, invalid-chain rollback
#   p2p       — 3-node network: sync, block relay, multi-hop tx gossip
#   p2p-reorg — divergent chains converge onto the heavier one via gossip
npm test

# start a node that auto-mines to an address every 5s
node bin/smartsvd.js --datadir ./data --reset --port 8432 \
  --mine <address> --interval 5
```

### Run a multi-node network

```bash
# Node A — RPC 8432, P2P 8433, mining
node bin/smartsvd.js --datadir ./A --reset --port 8432 --p2p-port 8433 \
  --mine <address> --interval 5

# Node B — connects to A, syncs the chain, then stays in sync via gossip
node bin/smartsvd.js --datadir ./B --reset --port 8442 --p2p-port 8443 \
  --connect 127.0.0.1:8433
```

B performs a headers-first initial block download from A — pulling A's headers,
checking their proof of work, then fetching the bodies along that chain — and
afterwards receives every new block and
transaction by gossip. Add a Node C that only `--connect`s to B and it still
discovers A through `addr` gossip. Any node can broadcast a transaction (via the
CLI/REST) and it propagates network-wide.

`--connect` is only needed the *first* time: every peer B learns is written to
its address book, so restarting B without any `--connect` flag still reconnects
it to the network. `GET /peers` shows the live connections and what the book
knows about each address.

In another terminal, drive it with the CLI:

```bash
# generate a key
node bin/smartsv.js newkey
# { "wif": "...", "address": "1...", "publicKey": "..." }

# mine 101 blocks to your address (past coinbase maturity)
for i in $(seq 1 101); do node bin/smartsv.js mine <address>; done

node bin/smartsv.js info
node bin/smartsv.js balance <address>

# send 10 SSV, attaching on-chain data
node bin/smartsv.js send <wif> <toAddress> 10 --data "hello SmartSV"
node bin/smartsv.js mine <address>          # confirm it
node bin/smartsv.js balance <toAddress>

# pure data transaction (OP_RETURN)
node bin/smartsv.js data <wif> "arbitrary on-chain data"
```

## Programmatic use

```js
const { Node, Wallet, sv } = require('smart-sv'); // or require('./index')

const node = new Node({ dataDir: './data' });
node.start();

const key = new sv.PrivateKey();
node.mine(key.toAddress());                     // mine a block, collect the reward

const utxos = node.getUTXOs(key.toAddress());
const tx = Wallet.buildPayment(
  key.toWIF(), utxos, someAddress, 5e8, { data: 'on-chain note' }
);
node.submitTransaction(tx);
node.mine(key.toAddress());                     // confirm

node.on('block', ({ height }) => console.log('new block', height));
```

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/info` | chain/mempool summary |
| `GET`  | `/block/:idOrHeight` | block as JSON (`/raw` for hex) |
| `GET`  | `/tx/:txid` | transaction + confirmations |
| `GET`  | `/address/:addr/balance` | confirmed balance |
| `GET`  | `/address/:addr/utxos` | spendable outputs |
| `GET`  | `/mempool` | pending txids |
| `GET`  | `/peers` | connected peers + the persistent address book |
| `POST` | `/tx` `{ rawtx }` | broadcast a transaction |
| `POST` | `/block` `{ rawblock }` | submit a block (P2P-style) |
| `POST` | `/mine` `{ address, data? }` | mine one block (dev helper) |

**WebSocket:** connect to the same host/port to receive `{ type: 'block', … }`
and `{ type: 'tx', … }` push events.

## Consensus parameters

All tunable in [`src/params.js`](src/params.js):

- **Ticker:** `SSV`, 1 SSV = 100,000,000 satoshis
- **Block subsidy:** 50 SSV, halving every 210,000 blocks
- **Coinbase maturity:** 100 blocks
- **Max block size:** 32 MB (large blocks by design)
- **PoW:** `genesisBits = 0x207fffff` (instant), `retargeting: false` by default
- **Network magic / ports:** distinct from other chains; address version bytes
  chosen so standard addresses round-trip cleanly.

## Deployment

A production deploy — Dockerized nodes behind Caddy TLS, on a DigitalOcean
network provisioned by Terraform (a mining seed + `N` peers, VPC, firewall,
reserved IP) — is documented step-by-step in **[DEPLOY.md](DEPLOY.md)**. Try the
whole topology locally first:

```bash
cp .env.example .env      # set SMARTSV_API_KEY (make apikey) + MINE_ADDRESS (make keygen)
make up                   # seed + 2 peers + Caddy, in Docker
curl localhost/info       # watch the chain grow; peers sync via gossip
make down
```

## Project layout

```
src/
  params.js         consensus parameters
  config.js         env/file/flag configuration
  logger.js         leveled structured logger
  sv.js             primitives-library wrapper (single import point)
  network.js        registers the SmartSV network params
  pow.js            bits↔target, mining, difficulty retarget, chainwork
  genesis.js        deterministic genesis block
  consensus.js      subsidy/halving, coinbase construction
  utxoset.js        UTXO set + layered overlay view
  validation.js     contextual + connect-time tx & block validation
  mempool.js        fee-ordered transaction pool
  store/
    chainstore.js   transactional SQLite chainstate (source of truth)
  blockchain.js     block tree, fork choice, reorg (connect/disconnect + undo)
  miner.js          candidate assembly + PoW grind
  node.js           the full node (chain + mempool + miner)
  wallet.js         client-side key & tx construction
  api/server.js     REST + WebSocket server (auth, health, metrics)
  p2p/
    messages.js     wire protocol: framing + message codec
    peer.js         framed socket wrapper (deframing + events)
    manager.js      PeerManager: handshake, sync, gossip relay, locator
bin/
  smartsvd.js       full-node daemon (env-configured)
  smartsv.js        CLI wallet/client
test/
  e2e.test.js        end-to-end (20 checks)
  persist.test.js    durable chainstate / no-replay (14 checks)
  reorg.test.js      fork choice & reorg (20 checks)
  p2p.test.js        3-node network (8 checks)
  p2p-reorg.test.js  network reorg convergence (8 checks)
Dockerfile, docker-compose.yml, Makefile, DEPLOY.md
deploy/
  Caddyfile               TLS reverse-proxy config
  docker-compose.node.yml per-droplet stack (node + Caddy)
  terraform/              DigitalOcean IaC (seed + N peers)
```

## Roadmap

- Pruning of deeply-buried *undo* records (the same reorg-depth bargain as
  side-chain pruning, applied to the main chain's rollback data)
- DigitalOcean Container Registry image (skip per-droplet builds)

## License

MIT
