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

// ===============================
// INIT
// ===============================
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

// ===============================
// USERS
// ===============================
async function addMessage(userId) {
  await dbRun(
    `
    INSERT INTO users (user_id, messages)
    VALUES ($1, 1)
    ON CONFLICT (user_id)
    DO UPDATE SET messages = users.messages + 1
    `,
    [userId]
  )
}

async function getCoins(userId) {
  const row = await dbGet(`SELECT coins FROM users WHERE user_id=$1`, [userId])
  return row ? Number(row.coins) : 0
}

async function addCoins(userId, amount) {
  await dbRun(
    `
    INSERT INTO users (user_id, coins)
    VALUES ($1, $2)
    ON CONFLICT (user_id)
    DO UPDATE SET coins = users.coins + $2
    `,
    [userId, amount]
  )
}

async function transferCoins(fromId, toId, amount) {
  const fromCoins = await getCoins(fromId)
  if (fromCoins < amount) return false

  await addCoins(fromId, -amount)
  await addCoins(toId, amount)
  return true
}

// ===============================
// RANK
// ===============================
async function getRank() {
  return dbAll(`
    SELECT user_id, coins, messages
    FROM users
    ORDER BY coins DESC
    LIMIT 100
  `)
}

async function getTopUsers() {
  return dbAll(`
    SELECT user_id, coins, messages
    FROM users
    ORDER BY messages DESC
    LIMIT 20
  `)
}

// ===============================
// DAILY USAGE
// ===============================
async function consumeDailyQuota(userId, kind, limit) {
  const today = new Date().toISOString().slice(0, 10)

  const row = await dbGet(
    `SELECT count FROM daily_usage WHERE user_id=$1 AND date=$2 AND kind=$3`,
    [userId, today, kind]
  )

  if (!row) {
    await dbRun(
      `INSERT INTO daily_usage (user_id, date, kind, count) VALUES ($1,$2,$3,1)`,
      [userId, today, kind]
    )
    return true
  }

  if (row.count >= limit) return false

  await dbRun(
    `UPDATE daily_usage SET count=count+1 WHERE user_id=$1 AND date=$2 AND kind=$3`,
    [userId, today, kind]
  )

  return true
}

// ===============================
// BOT MUTE
// ===============================
async function isBotMuted(userId) {
  const row = await dbGet(`SELECT muted FROM bot_mute WHERE user_id=$1`, [userId])
  return row ? row.muted : false
}

async function setBotMuted(userId, muted) {
  await dbRun(
    `
    INSERT INTO bot_mute (user_id, muted)
    VALUES ($1, $2)
    ON CONFLICT (user_id)
    DO UPDATE SET muted=$2
    `,
    [userId, muted]
  )
}

// ===============================
// SITE ACCOUNTS
// ===============================
async function createSiteAccount(siteUserId) {
  const accountId = crypto.randomUUID()
  const linkCode = crypto.randomBytes(4).toString("hex")
  const expires = new Date(Date.now() + 10 * 60 * 1000) // 10分

  await dbRun(
    `
    INSERT INTO site_accounts (account_id, link_code, link_code_expires_at)
    VALUES ($1,$2,$3)
    `,
    [accountId, linkCode, expires]
  )

  return { ok: true, accountId, linkCode }
}

async function lookupSiteAccount(code) {
  const row = await dbGet(
    `
    SELECT * FROM site_accounts
    WHERE link_code=$1
    `,
    [code]
  )

  if (!row) return { ok: false, reason: "not_found" }

  if (new Date(row.link_code_expires_at) < new Date())
    return { ok: false, reason: "expired" }

  return { ok: true, account: row }
}

async function countLinkedAccounts() {
  const row = await dbGet(
    `SELECT COUNT(*) AS c FROM site_accounts WHERE line_user_id IS NOT NULL`
  )
  return Number(row.c)
}

// ===============================
// SITE USERS
// ===============================
async function registerSiteUser(username, password) {
  const id = crypto.randomUUID()
  const hash = crypto.createHash("sha256").update(password).digest("hex")

  try {
    await dbRun(
      `
      INSERT INTO site_users (id, username, password_hash)
      VALUES ($1,$2,$3)
      `,
      [id, username, hash]
    )
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: "username_taken" }
  }
}

async function loginSiteUser(username, password) {
  const hash = crypto.createHash("sha256").update(password).digest("hex")

  const row = await dbGet(
    `
    SELECT * FROM site_users
    WHERE username=$1 AND password_hash=$2
    `,
    [username, hash]
  )

  if (!row) return { ok: false }

  const token = crypto.randomUUID()
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  await dbRun(
    `
    INSERT INTO site_sessions (token, site_user_id, expires_at)
    VALUES ($1,$2,$3)
    `,
    [token, row.id, expires]
  )

  return { ok: true, token }
}

async function getSessionFromRequest(req) {
  const token = req.headers.authorization
  if (!token) return null

  const row = await dbGet(
    `
    SELECT * FROM site_sessions
    WHERE token=$1 AND expires_at > NOW()
    `,
    [token]
  )

  return row || null
}

async function getSiteUserById(id) {
  return dbGet(`SELECT * FROM site_users WHERE id=$1`, [id])
}

// ===============================
// EXPORT
// ===============================
module.exports = {
  initDb,
  dbRun,
  dbGet,
  dbAll,

  addMessage,
  getCoins,
  addCoins,
  transferCoins,

  getRank,
  getTopUsers,

  consumeDailyQuota,

  isBotMuted,
  setBotMuted,

  createSiteAccount,
  lookupSiteAccount,
  countLinkedAccounts,

  registerSiteUser,
  loginSiteUser,
  getSessionFromRequest,
  getSiteUserById
}
