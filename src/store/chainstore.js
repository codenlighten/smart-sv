'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * ChainStore — the durable source of truth for chain state, backed by SQLite.
 *
 * It persists everything needed to resume a node WITHOUT replaying/revalidating
 * the chain: full block bytes + index metadata (the block tree), the UTXO set,
 * per-block undo data, and the active tip. Because better-sqlite3 is synchronous
 * and transactional, it maps cleanly onto the synchronous consensus engine — a
 * whole block connect/disconnect (including a multi-block reorg) commits as one
 * atomic transaction, so a crash mid-reorg never leaves corrupt state.
 *
 * Tables:
 *   blocks(hash PK, height, prev, bits, time, chainwork BLOB, main, invalid, body BLOB)
 *   utxos(txid, vout, satoshis, script, height, coinbase, PK(txid,vout)) INDEX(script)
 *   undo(hash PK, data BLOB)      -- JSON undo record for a connected block
 *   meta(key PK, value)           -- e.g. tip hash, schema version
 *   peers(addr PK, host, port, ...) -- the P2P address book (see p2p/addrbook.js)
 *
 * `peers` is deliberately NOT chain state: it survives `reset()` so a wiped node
 * still knows who to reconnect to.
 */
class ChainStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'chainstate.db');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL'); // durable + concurrent readers
    this.db.pragma('synchronous = NORMAL'); // fsync at checkpoints; safe with WAL
    this.db.pragma('foreign_keys = OFF');
    this._migrate();
    this._prepare();
    if (!this.getMeta('schema')) this.setMeta('schema', '1');
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        hash      TEXT PRIMARY KEY,
        height    INTEGER NOT NULL,
        prev      TEXT,
        bits      INTEGER NOT NULL,
        time      INTEGER NOT NULL,
        chainwork BLOB NOT NULL,
        main      INTEGER NOT NULL DEFAULT 0,
        invalid   INTEGER NOT NULL DEFAULT 0,
        body      BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height);
      CREATE INDEX IF NOT EXISTS idx_blocks_main   ON blocks(main);

      CREATE TABLE IF NOT EXISTS utxos (
        txid     TEXT NOT NULL,
        vout     INTEGER NOT NULL,
        satoshis INTEGER NOT NULL,
        script   TEXT NOT NULL,
        height   INTEGER NOT NULL,
        coinbase INTEGER NOT NULL,
        PRIMARY KEY (txid, vout)
      );
      CREATE INDEX IF NOT EXISTS idx_utxos_script ON utxos(script);

      CREATE TABLE IF NOT EXISTS undo (
        hash TEXT PRIMARY KEY,
        data BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      -- Index entries for side-chain blocks whose bodies have been pruned.
      -- Same columns as the blocks table minus the body: enough to keep the
      -- tree shape and cumulative work, so we still recognise the block and
      -- never re-download it, but without paying to store it.
      CREATE TABLE IF NOT EXISTS pruned_blocks (
        hash      TEXT PRIMARY KEY,
        height    INTEGER NOT NULL,
        prev      TEXT,
        bits      INTEGER NOT NULL,
        time      INTEGER NOT NULL,
        chainwork BLOB NOT NULL,
        invalid   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_pruned_height ON pruned_blocks(height);

      CREATE TABLE IF NOT EXISTS peers (
        addr        TEXT PRIMARY KEY,
        host        TEXT NOT NULL,
        port        INTEGER NOT NULL,
        firstSeen   INTEGER NOT NULL DEFAULT 0,
        lastSeen    INTEGER NOT NULL DEFAULT 0,
        lastTry     INTEGER NOT NULL DEFAULT 0,
        lastSuccess INTEGER NOT NULL DEFAULT 0,
        failures    INTEGER NOT NULL DEFAULT 0,
        successes   INTEGER NOT NULL DEFAULT 0,
        bannedUntil INTEGER NOT NULL DEFAULT 0,
        source      TEXT
      );
    `);
  }

  _prepare() {
    this.q = {
      putBlock: this.db.prepare(
        `INSERT OR REPLACE INTO blocks(hash,height,prev,bits,time,chainwork,main,invalid,body)
         VALUES(@hash,@height,@prev,@bits,@time,@chainwork,@main,@invalid,@body)`
      ),
      setBlockMain: this.db.prepare(`UPDATE blocks SET main=@main WHERE hash=@hash`),
      setBlockInvalid: this.db.prepare(`UPDATE blocks SET invalid=1 WHERE hash=@hash`),
      allBlocks: this.db.prepare(`SELECT * FROM blocks ORDER BY height ASC`),
      getBlock: this.db.prepare(`SELECT * FROM blocks WHERE hash=?`),
      countBlocks: this.db.prepare(`SELECT COUNT(*) c FROM blocks`),
      delBlock: this.db.prepare(`DELETE FROM blocks WHERE hash=?`),

      putPruned: this.db.prepare(
        `INSERT OR REPLACE INTO pruned_blocks(hash,height,prev,bits,time,chainwork,invalid)
         VALUES(@hash,@height,@prev,@bits,@time,@chainwork,@invalid)`
      ),
      allPruned: this.db.prepare(`SELECT * FROM pruned_blocks ORDER BY height ASC`),
      countPruned: this.db.prepare(`SELECT COUNT(*) c FROM pruned_blocks`),

      addUtxo: this.db.prepare(
        `INSERT OR REPLACE INTO utxos(txid,vout,satoshis,script,height,coinbase)
         VALUES(@txid,@vout,@satoshis,@script,@height,@coinbase)`
      ),
      delUtxo: this.db.prepare(`DELETE FROM utxos WHERE txid=@txid AND vout=@vout`),
      allUtxos: this.db.prepare(`SELECT * FROM utxos`),

      putUndo: this.db.prepare(`INSERT OR REPLACE INTO undo(hash,data) VALUES(?,?)`),
      getUndo: this.db.prepare(`SELECT data FROM undo WHERE hash=?`),
      delUndo: this.db.prepare(`DELETE FROM undo WHERE hash=?`),

      getMeta: this.db.prepare(`SELECT value FROM meta WHERE key=?`),
      setMeta: this.db.prepare(`INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)`),

      putPeer: this.db.prepare(
        `INSERT OR REPLACE INTO peers
           (addr,host,port,firstSeen,lastSeen,lastTry,lastSuccess,failures,successes,bannedUntil,source)
         VALUES
           (@addr,@host,@port,@firstSeen,@lastSeen,@lastTry,@lastSuccess,@failures,@successes,@bannedUntil,@source)`
      ),
      delPeer: this.db.prepare(`DELETE FROM peers WHERE addr=?`),
      allPeers: this.db.prepare(`SELECT * FROM peers`),
    };
  }

  // --- meta ----------------------------------------------------------------

  getMeta(key) {
    const row = this.q.getMeta.get(key);
    return row ? row.value : null;
  }
  setMeta(key, value) {
    this.q.setMeta.run(key, String(value));
  }
  getTip() {
    return this.getMeta('tip');
  }
  setTip(hash) {
    this.setMeta('tip', hash);
  }

  isEmpty() {
    return this.q.countBlocks.get().c === 0;
  }

  // --- blocks --------------------------------------------------------------

  putBlock(row) {
    this.q.putBlock.run({
      hash: row.hash,
      height: row.height,
      prev: row.prev || null,
      bits: row.bits,
      time: row.time,
      chainwork: row.chainwork, // Buffer
      main: row.main ? 1 : 0,
      invalid: row.invalid ? 1 : 0,
      body: row.body, // Buffer
    });
  }
  setBlockMain(hash, main) {
    this.q.setBlockMain.run({ hash, main: main ? 1 : 0 });
  }
  markInvalid(hash) {
    this.q.setBlockInvalid.run({ hash });
  }
  allBlocks() {
    return this.q.allBlocks.all();
  }
  getBlockRow(hash) {
    return this.q.getBlock.get(hash);
  }

  // --- pruned side-chain index ---------------------------------------------

  /** Replace a stored block with a body-less index entry. */
  pruneBlock(row) {
    this.q.putPruned.run({
      hash: row.hash,
      height: row.height,
      prev: row.prev || null,
      bits: row.bits,
      time: row.time,
      chainwork: row.chainwork, // Buffer
      invalid: row.invalid ? 1 : 0,
    });
    this.q.delBlock.run(row.hash);
  }
  allPrunedBlocks() {
    return this.q.allPruned.all();
  }
  countPrunedBlocks() {
    return this.q.countPruned.get().c;
  }

  // --- utxo ----------------------------------------------------------------

  addUtxo(txid, vout, entry) {
    this.q.addUtxo.run({
      txid,
      vout,
      satoshis: entry.satoshis,
      script: entry.script,
      height: entry.height,
      coinbase: entry.coinbase ? 1 : 0,
    });
  }
  delUtxo(txid, vout) {
    this.q.delUtxo.run({ txid, vout });
  }
  allUtxos() {
    return this.q.allUtxos.all();
  }

  // --- undo ----------------------------------------------------------------

  putUndo(hash, undoObj) {
    this.q.putUndo.run(hash, Buffer.from(JSON.stringify(undoObj), 'utf8'));
  }
  getUndo(hash) {
    const row = this.q.getUndo.get(hash);
    return row ? JSON.parse(row.data.toString('utf8')) : null;
  }
  delUndo(hash) {
    this.q.delUndo.run(hash);
  }

  // --- peers (address book) -------------------------------------------------

  putPeer(entry) {
    this.q.putPeer.run({
      addr: entry.addr,
      host: entry.host,
      port: entry.port,
      firstSeen: int(entry.firstSeen),
      lastSeen: int(entry.lastSeen),
      lastTry: int(entry.lastTry),
      lastSuccess: int(entry.lastSuccess),
      failures: int(entry.failures),
      successes: int(entry.successes),
      bannedUntil: int(entry.bannedUntil),
      source: entry.source || null,
    });
  }
  delPeer(addr) {
    this.q.delPeer.run(addr);
  }
  allPeers() {
    return this.q.allPeers.all();
  }

  // --- transactions --------------------------------------------------------

  /** Run `fn` inside a single atomic SQLite transaction. */
  transaction(fn) {
    return this.db.transaction(fn)();
  }

  reset() {
    this.db.exec(
      'DELETE FROM blocks; DELETE FROM pruned_blocks; DELETE FROM utxos; DELETE FROM undo; DELETE FROM meta;'
    );
    this.setMeta('schema', '1');
  }

  close() {
    this.db.close();
  }
}

/** Coerce to a safe integer for SQLite INTEGER columns (better-sqlite3 rejects floats/NaN). */
function int(v) {
  return Number.isFinite(v) ? Math.trunc(v) : 0;
}

module.exports = { ChainStore };
