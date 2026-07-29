# Deploying SmartSV

This deploys a real SmartSV network — a mining **seed** node plus `N` **peer**
nodes — to DigitalOcean with Terraform. Each node runs in Docker behind a Caddy
reverse proxy that terminates TLS, with the RPC/WS API protected by a bearer key
and the P2P port open so anyone can join the network.

```
                     Internet
                        │  443 (HTTPS)          8433 (P2P, open)
                        ▼                              ▲
   ┌────────────────────────────────┐        ┌────────┴─────────┐
   │  seed  (reserved IP, mining)   │◀──VPC──▶│  peer-1 … peer-N │
   │  Caddy → node → SQLite volume  │  :8433  │  Caddy → node    │
   └────────────────────────────────┘        └──────────────────┘
```

Chainstate is persisted in a Docker named volume (SQLite), so a droplet reboot
or container restart resumes instantly — no chain replay.

---

## 0. Prerequisites

- A **DigitalOcean account** + API token (Control Panel → API → *Generate New Token*, read/write).
- An **SSH key uploaded to DO** (Settings → Security). Get its fingerprint:
  `doctl compute ssh-key list`.
- **Terraform ≥ 1.3** locally.
- **This repo pushed to a git URL** the droplets can clone (public GitHub repo is simplest).
- `openssl` and `node` locally (to generate the API key and a mining address).

---

## 1. Test locally first (recommended)

Prove the whole stack on your machine before spending on cloud:

```bash
cp .env.example .env
# set SMARTSV_API_KEY (make apikey) and MINE_ADDRESS (make keygen)
make up          # builds image, starts seed + 2 peers + Caddy
sleep 25
curl localhost/health
curl localhost/info                       # seed height climbing
docker logs smartsv-peer1 | tail          # peers syncing via gossip
make down
```

---

## 2. Configure Terraform

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

| Variable | How to get it |
|---|---|
| `do_token` | DO API token (or `export TF_VAR_do_token=…`) |
| `ssh_key_fingerprints` | `doctl compute ssh-key list` |
| `api_key` | `openssl rand -hex 32` |
| `mine_address` | `node bin/smartsv.js newkey` → use the `address` |
| `git_repo` / `git_ref` | this repo's clone URL and branch |
| `domain` | *(optional)* an FQDN for TLS; leave empty for plain HTTP |
| `peer_count` | how many peers (0–20) |
| `admin_ssh_cidr` | lock SSH to your IP, e.g. `203.0.113.7/32` |

Keep `terraform.tfvars` out of git (it's already `.gitignore`d).

---

## 3. Provision

```bash
make tf-init
make tf-plan       # review: 1 seed + N peers + VPC + firewall + reserved IP
make tf-apply
```

Terraform prints outputs including `seed_reserved_ip` and `rpc_url`.

**If you set a `domain`:** create a DNS `A` record pointing it at
`seed_reserved_ip`. Caddy obtains a Let's Encrypt certificate automatically on
first request. Wait ~2–3 minutes for cloud-init (Docker install + image build).

---

## 4. Verify the live network

```bash
export SMARTSV_URL=$(cd deploy/terraform && terraform output -raw rpc_url)
export SMARTSV_API_KEY=<the api_key you set>

curl $SMARTSV_URL/health          # {"status":"ok"}
node bin/smartsv.js info          # chain height, peers, supply
curl $SMARTSV_URL/peers           # live connections + the persistent address book
curl $SMARTSV_URL/metrics         # Prometheus metrics (incl. smartsv_peers)
```

Each peer droplet syncs the seed's chain over the VPC and stays current by
gossip. `SMARTSV_CONNECT` only bootstraps the *first* start: after that each node
remembers every peer it has met in its address book (persisted in the same SQLite
volume as chain state) and re-dials them itself, so a restarted or reprovisioned
droplet rejoins even if the seed is temporarily down. Watch
`smartsv_peers_outbound` and `smartsv_addrbook_size` to confirm.

Broadcast a transaction against the public API:

```bash
node bin/smartsv.js send <wif> <toAddress> 5 --data "hello from prod"
```

SSH in for logs: `ssh root@<seed_public_ip>` then
`journalctl -u smartsv -f` or `docker logs -f $(docker ps -q --filter name=node)`.

---

## 5. Operate

- **Update the code:** push to your git ref, then on each droplet
  `cd /opt/smartsv && git pull && systemctl restart smartsv` (or `terraform taint`
  the droplet to reprovision).
- **Scale peers:** change `peer_count` and `make tf-apply`.
- **Rotate the API key:** update `api_key`, `make tf-apply` (recreates node.env),
  restart the service.
- **Back up chainstate:** the SQLite DB lives in the `node-data` volume
  (`docker volume inspect`); `sqlite3 chainstate.db ".backup out.db"` for a hot copy.

---

## 6. Tear down

```bash
make tf-destroy
```

Removes all droplets, the VPC, firewall, and reserved IP.

---

## Security notes

- The RPC's mutating routes (`/tx`, `/block`, `/mine`) require the bearer API key;
  read routes and `/health`, `/ready`, `/metrics` are open.
- Restrict `admin_ssh_cidr` to your IP.
- For a private RPC instead of public, set `SMARTSV_RPC_HOST=127.0.0.1` and reach
  it via SSH tunnel; the P2P port can stay public.
- This testnet runs instant low-difficulty PoW (`retargeting: false`). For a
  public mining race, raise `genesisBits` and enable retargeting in
  `src/params.js` before genesis — see the roadmap in `README.md`.
