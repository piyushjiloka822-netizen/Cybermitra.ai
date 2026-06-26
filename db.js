// ─────────────────────────────────────────────────────────
// db.js — Persistent storage for CyberMitra AI
//
// Uses Node's BUILT-IN `node:sqlite` module (stable since Node 22.5+).
// No native compilation, no extra npm dependency, no separate DB
// server to run — it's just a file on disk: cybermitra.db
//
// Replaces the old scams.json flat-file "cache" with a real table
// that's indexed, safe under concurrent writes, and queryable.
// ─────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('❌ This project now requires Node.js 22.5 or newer (for the built-in node:sqlite module).');
  console.error(`   You're running ${process.version}. Please upgrade Node.js and try again.`);
  console.error('   nvm users: nvm install 22 && nvm use 22');
  process.exit(1);
}

const DB_PATH = path.join(__dirname, 'cybermitra.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS analyses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key     TEXT UNIQUE NOT NULL,
    source        TEXT NOT NULL,            -- 'Telegram Bot' | 'Telegram/Manual' | 'Instagram' | 'Twitter/X' | 'Deepfake Check' ...
    field_type    TEXT NOT NULL,            -- 'general' | 'username' | 'dm' | 'post' | 'deepfake'
    input_text    TEXT,                     -- truncated original text/url, kept for reference/search
    risk_level    TEXT NOT NULL,            -- 'High' | 'Medium' | 'Low'
    fraud_type    TEXT,
    action_hindi  TEXT,
    visual_analysis TEXT,                   -- JSON string, deepfake checks only
    hit_count     INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_analyses_risk    ON analyses(risk_level);
  CREATE INDEX IF NOT EXISTS idx_analyses_source  ON analyses(source);
  CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(first_seen_at);

  CREATE TABLE IF NOT EXISTS telegram_users (
    chat_id         TEXT PRIMARY KEY,
    username        TEXT,
    first_name      TEXT,
    message_count   INTEGER NOT NULL DEFAULT 0,
    high_risk_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Prepared statements ─────────────────────────────────────
const stmtGetByKey = db.prepare('SELECT * FROM analyses WHERE cache_key = ?');
const stmtTouch    = db.prepare(`
  UPDATE analyses SET hit_count = hit_count + 1, last_seen_at = datetime('now')
  WHERE cache_key = ?
`);
const stmtUpsertAnalysis = db.prepare(`
  INSERT INTO analyses (cache_key, source, field_type, input_text, risk_level, fraud_type, action_hindi, visual_analysis)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(cache_key) DO UPDATE SET
    hit_count = hit_count + 1,
    last_seen_at = datetime('now')
`);
const stmtHistory = db.prepare(`
  SELECT * FROM analyses ORDER BY first_seen_at DESC LIMIT ?
`);
const stmtStatsByRisk = db.prepare(`
  SELECT risk_level, COUNT(*) as unique_count, SUM(hit_count) as total_count
  FROM analyses GROUP BY risk_level
`);
const stmtStatsBySource = db.prepare(`
  SELECT source, COUNT(*) as unique_count, SUM(hit_count) as total_count
  FROM analyses GROUP BY source ORDER BY total_count DESC
`);
const stmtTopFraudTypes = db.prepare(`
  SELECT fraud_type, SUM(hit_count) as total_count
  FROM analyses WHERE fraud_type IS NOT NULL AND fraud_type NOT IN ('None','Analysis Unavailable','Unknown')
  GROUP BY fraud_type ORDER BY total_count DESC LIMIT 5
`);
const stmtUpsertTelegramUser = db.prepare(`
  INSERT INTO telegram_users (chat_id, username, first_name, message_count, high_risk_count)
  VALUES (?, ?, ?, 1, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    message_count = message_count + 1,
    high_risk_count = high_risk_count + excluded.high_risk_count,
    last_seen_at = datetime('now')
`);
const stmtCount = db.prepare('SELECT COUNT(*) as c FROM analyses');

// ── Public API ───────────────────────────────────────────────

/** Look up a cached analysis by key. Bumps hit_count as a side effect. Returns row or null. */
function getCachedAnalysis(cacheKey) {
  const row = stmtGetByKey.get(cacheKey);
  if (!row) return null;
  stmtTouch.run(cacheKey);
  return { ...row, hit_count: row.hit_count + 1 };
}

/** Save a fresh analysis result. Safe to call concurrently — falls back to a hit-count bump on conflict. */
function saveAnalysis({ cacheKey, source, fieldType, text, analysis, visualAnalysis }) {
  stmtUpsertAnalysis.run(
    cacheKey,
    source,
    fieldType,
    (text || '').substring(0, 500),
    analysis.risk_level,
    analysis.fraud_type || null,
    analysis.action_hindi || null,
    visualAnalysis ? JSON.stringify(visualAnalysis) : null
  );
}

/** Most recent N analyses (newest first) — used to hydrate the dashboard feed on page load. */
function getHistory(limit = 50) {
  return stmtHistory.all(limit);
}

/** Aggregate counts for an admin/stats view. */
function getStats() {
  const byRisk = {};
  for (const row of stmtStatsByRisk.all()) byRisk[row.risk_level] = row.total_count;

  const bySource = stmtStatsBySource.all().map(r => ({ source: r.source, count: r.total_count }));
  const topFraudTypes = stmtTopFraudTypes.all().map(r => ({ fraud_type: r.fraud_type, count: r.total_count }));
  const total = Object.values(byRisk).reduce((a, b) => a + b, 0);

  return { total, by_risk: byRisk, by_source: bySource, top_fraud_types: topFraudTypes };
}

/** Upsert a Telegram user's activity counters. */
function recordTelegramUser({ chatId, username, firstName, riskLevel }) {
  if (!chatId) return;
  stmtUpsertTelegramUser.run(chatId, username || null, firstName || null, riskLevel === 'High' ? 1 : 0);
}

/**
 * One-time import of the legacy scams.json flat-file cache, so existing
 * history isn't lost when upgrading to the database. Only runs if the
 * analyses table is currently empty.
 */
function migrateLegacyCache(jsonPath) {
  if (stmtCount.get().c > 0) return 0; // already have data — skip
  if (!fs.existsSync(jsonPath)) return 0;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    console.log('⚠️  Could not parse legacy scams.json, skipping migration.');
    return 0;
  }

  let migrated = 0;
  for (const [key, value] of Object.entries(raw)) {
    // Legacy key format: "<text>::<source>::<fieldType>"
    const parts = key.split('::');
    if (parts.length < 3) continue;
    const fieldType = parts.pop();
    const source = parts.pop();
    const text = parts.join('::');

    try {
      stmtUpsertAnalysis.run(
        key,
        source,
        fieldType,
        text.substring(0, 500),
        value.risk_level || 'Medium',
        value.fraud_type || null,
        value.action_hindi || null,
        null
      );
      migrated++;
    } catch (e) {
      // duplicate or malformed row — skip it
    }
  }
  return migrated;
}

function close() {
  db.close();
}


// ── Scam reports table (community submissions) ────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS scam_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    platform    TEXT,
    type        TEXT,
    content     TEXT NOT NULL,
    loss        TEXT,
    city        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reports_type ON scam_reports(type);
  CREATE INDEX IF NOT EXISTS idx_reports_created ON scam_reports(created_at);
`);

const stmtSaveReport = db.prepare(`
  INSERT INTO scam_reports (platform, type, content, loss, city)
  VALUES (?, ?, ?, ?, ?)
`);

const stmtLeaderboard = db.prepare(`
  SELECT fraud_type, SUM(hit_count) as total_count, risk_level,
         COUNT(*) as unique_variants
  FROM analyses
  WHERE fraud_type IS NOT NULL
    AND fraud_type NOT IN ('None','Analysis Unavailable','Unknown')
  GROUP BY fraud_type
  ORDER BY total_count DESC
  LIMIT ?
`);

// ── Save a community scam report ─────────────────────────
function saveScamReport({ platform, type, content, loss, city }) {
  stmtSaveReport.run(platform || null, type || null, content, loss || null, city || null);
}

// ── Get leaderboard of top fraud types ───────────────────
function getLeaderboard(limit = 15) {
  return stmtLeaderboard.all(limit).map(r => ({
    fraud_type: r.fraud_type,
    total_count: r.total_count,
    risk_level: r.risk_level,
    unique_variants: r.unique_variants
  }));
}

// ── Search / filter history ───────────────────────────────
function searchHistory({ q, risk, source, limit = 50 } = {}) {
  let sql = 'SELECT * FROM analyses WHERE 1=1';
  const params = [];
  if (q)      { sql += ' AND (fraud_type LIKE ? OR action_hindi LIKE ? OR input_text LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  if (risk)   { sql += ' AND risk_level = ?';   params.push(risk); }
  if (source) { sql += ' AND source = ?';       params.push(source); }
  sql += ' ORDER BY first_seen_at DESC LIMIT ?';
  params.push(Math.min(limit, 200));
  return db.prepare(sql).all(...params);
}

module.exports = {
  getCachedAnalysis,
  saveAnalysis,
  getHistory,
  getStats,
  recordTelegramUser,
  migrateLegacyCache,
  saveScamReport,
  getLeaderboard,
  searchHistory,
  close
};