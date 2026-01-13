const path = require('path');
const Database = require('better-sqlite3');

const DATA_ROOT = process.env.SYNCORBIT_DATA || '/app/data';
const DB_PATH = path.join(DATA_ROOT, 'syncorbit.db');

const db = new Database(DB_PATH);

function ensureColumn(table, column) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(r => r.name);

  if (!cols.includes(column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT DEFAULT 'ok'`).run();
    console.log(`[DB] added column ${table}.${column}`);
  }
}

// RUN MIGRATIONS HERE
ensureColumn('movies', 'state');

function initDb() {
  db.exec(`
    PRAGMA journal_mode=WAL;

    CREATE TABLE IF NOT EXISTS movies (
      movie TEXT PRIMARY KEY,

      anchor_count INTEGER,
      avg_offset REAL,
      drift_span REAL,
      decision TEXT,

      best_reference TEXT,
      reference_path TEXT,

      has_whisper INTEGER DEFAULT 0,
      has_ffsubsync INTEGER DEFAULT 0,

      fi_mtime INTEGER,
      last_analyzed INTEGER,
      ignored INTEGER DEFAULT 0,

      state TEXT DEFAULT 'ok'
    );

    CREATE INDEX IF NOT EXISTS idx_movies_fi_mtime ON movies(fi_mtime);
    CREATE INDEX IF NOT EXISTS idx_movies_decision ON movies(decision);
  `);
}

module.exports = { db, initDb };
