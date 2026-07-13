const { Pool } = require("pg")
const crypto = require("crypto")
const { logError } = require("./utils")

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

async function dbRun(sql, params = []) {
  return pool.query(sql, params)
}

async function dbGet(sql, params = []) {
  const res = await pool.query(sql, params)
  return res.rows[0] || null
}

async function dbAll(sql, params = []) {
  const res = await pool.query(sql, params)
  return res.rows
}

async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      coins BIGINT NOT NULL DEFAULT 0,
      messages BIGINT NOT NULL DEFAULT 0
    )
  `)

  await dbRun(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date, kind)
    )
  `)

  await dbRun(`
    CREATE TABLE IF NOT EXISTS bot_mute (
      user_id TEXT PRIMARY KEY,
      muted BOOLEAN NOT NULL DEFAULT FALSE,
      mode TEXT
    )
  `)

  await dbRun(`
    CREATE TABLE IF NOT EXISTS site_accounts (
      account_id TEXT PRIMARY KEY,
      link_code TEXT UNIQUE NOT NULL,
      link_code_expires_at TIMESTAMPTZ NOT NULL,
      line_user_id TEXT UNIQUE,
      linked_at TIMESTAMPTZ
    )
  `)

  await dbRun(`
    CREATE TABLE IF NOT EXISTS site_users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      linked_line_user_id TEXT UNIQUE,
      linked_account_id TEXT UNIQUE
    )
  `)

  await dbRun(`
    CREATE TABLE IF NOT EXISTS site_sessions (
      token TEXT PRIMARY KEY,
      site_user_id TEXT NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `)
}

//
// あなたの index.txt の DB 関数をすべて移植
//

module.exports = {
  initDb,
  dbRun,
  dbGet,
  dbAll,
  // ここに getCoins / addCoins / transferCoins / daily_usage など全部入る
}
