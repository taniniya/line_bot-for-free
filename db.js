const { Pool } = require("pg")
const { getTodayJst } = require("./utils")

const DATABASE_URL = process.env.DATABASE_URL || ""
const PGHOST = process.env.PGHOST || ""
const PGPORT = Number(process.env.PGPORT || "5432")
const PGDATABASE = process.env.PGDATABASE || ""
const PGUSER = process.env.PGUSER || ""
const PGPASSWORD = process.env.PGPASSWORD || ""
const PGSSL =
  process.env.PGSSL === "true" || /sslmode=require/i.test(DATABASE_URL)

if (!DATABASE_URL && !PGHOST) {
  console.error("DATABASE_URL or PGHOST is required for PostgreSQL.")
  process.exit(1)
}

const pool = new Pool(
  DATABASE_URL
    ? { connectionString: DATABASE_URL, ssl: PGSSL ? { rejectUnauthorized: false } : false }
    : {
        host: PGHOST,
        port: PGPORT,
        database: PGDATABASE,
        user: PGUSER,
        password: PGPASSWORD,
        ssl: PGSSL ? { rejectUnauthorized: false } : false
      }
)

async function dbRun(sql, params = []) {
  return pool.query(sql, params)
}

async function dbAll(sql, params = []) {
  const res = await pool.query(sql, params)
  return res.rows
}

async function dbGet(sql, params = []) {
  const res = await pool.query(sql, params)
  return res.rows[0] || null
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
    CREATE TABLE IF NOT EXISTS login_streak (
      user_id TEXT PRIMARY KEY,
      last_date TEXT NOT NULL,
      streak INTEGER NOT NULL DEFAULT 0
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

// ユーザー
async function ensureUser(userId) {
  await dbRun(
    "INSERT INTO users (user_id, coins, messages) VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING",
    [userId]
  )
}

async function getCoins(userId) {
  await ensureUser(userId)
  const row = await dbGet("SELECT coins FROM users WHERE user_id = $1", [userId])
  return row?.coins ?? 0
}

async function addCoins(userId, amount) {
  await ensureUser(userId)
  await dbRun(
    "UPDATE users SET coins = coins + $1 WHERE user_id = $2",
    [amount, userId]
  )
}

async function transferCoins(fromId, toId, amount) {
  await ensureUser(fromId)
  await ensureUser(toId)

  const row = await dbGet("SELECT coins FROM users WHERE user_id = $1", [fromId])
  const balance = row?.coins ?? 0

  if (balance < amount) {
    return { ok: false, balance }
  }

  await dbRun("UPDATE users SET coins = coins - $1 WHERE user_id = $2", [
    amount,
    fromId
  ])
  await dbRun("UPDATE users SET coins = coins + $1 WHERE user_id = $2", [
    amount,
    toId
  ])

  return { ok: true }
}

async function addMessage(userId) {
  await ensureUser(userId)
  await dbRun("UPDATE users SET messages = messages + 1 WHERE user_id = $1", [
    userId
  ])
}

// streak
async function getLoginStreak(userId) {
  const row = await dbGet(
    "SELECT last_date, streak FROM login_streak WHERE user_id = $1",
    [userId]
  )
  return row || null
}

async function updateLoginStreak(userId) {
  const today = getTodayJst()
  const row = await getLoginStreak(userId)

  if (!row) {
    await dbRun(
      "INSERT INTO login_streak (user_id, last_date, streak) VALUES ($1, $2, 1)",
      [userId, today]
    )
    return 1
  }

  if (row.last_date === today) {
    return row.streak
  }

  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const y = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(yesterday)

  let newStreak = 1
  if (row.last_date === y) {
    newStreak = row.streak + 1
  }

  await dbRun(
    "UPDATE login_streak SET last_date = $1, streak = $2 WHERE user_id = $3",
    [today, newStreak, userId]
  )

  return newStreak
}

// ランキング
async function getRank(key, limit = 50) {
  const rows = await dbAll(
    `SELECT user_id, ${key} AS value FROM users ORDER BY ${key} DESC LIMIT $1`,
    [limit]
  )
  return rows
}

async function getTopUsers(limit = 10) {
  return dbAll(
    "SELECT user_id, coins, messages FROM users ORDER BY coins DESC, messages DESC LIMIT $1",
    [limit]
  )
}

async function getUserRank(userId, key) {
  const rows = await dbAll(
    `SELECT user_id, ${key} AS value FROM users ORDER BY ${key} DESC`,
    []
  )
  const index = rows.findIndex(r => r.user_id === userId)
  return index >= 0 ? index + 1 : null
}

async function countLinkedAccounts() {
  const row = await dbGet(
    "SELECT COUNT(*)::int AS count FROM site_accounts WHERE line_user_id IS NOT NULL",
    []
  )
  return row?.count ?? 0
}

// daily quota
async function consumeDailyQuota(userId, kind, limit) {
  const today = getTodayJst()

  const row = await dbGet(
    "SELECT count FROM daily_usage WHERE user_id = $1 AND date = $2 AND kind = $3",
    [userId, today, kind]
  )

  if (!row) {
    await dbRun(
      "INSERT INTO daily_usage (user_id, date, kind, count) VALUES ($1, $2, $3, 1)",
      [userId, today, kind]
    )
    return { ok: true, count: 1, limit }
  }

  if (row.count >= limit) {
    return { ok: false, count: row.count, limit }
  }

  await dbRun(
    "UPDATE daily_usage SET count = count + 1 WHERE user_id = $1 AND date = $2 AND kind = $3",
    [userId, today, kind]
  )

  return { ok: true, count: row.count + 1, limit }
}

// mute
async function isBotMuted(userId) {
  const row = await dbGet(
    "SELECT muted, mode FROM bot_mute WHERE user_id = $1",
    [userId]
  )
  if (!row) return { muted: false, mode: null }
  return { muted: row.muted, mode: row.mode }
}

async function setBotMuted(userId, muted, mode = null) {
  await dbRun(
    `INSERT INTO bot_mute (user_id, muted, mode)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET muted = EXCLUDED.muted, mode = EXCLUDED.mode`,
    [userId, muted, mode]
  )
}

// site accounts
async function createSiteAccount() {
  const crypto = require("crypto")
  const accountId = crypto.randomUUID()
  const code = crypto.randomBytes(3).toString("hex").toUpperCase()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

  await dbRun(
    `INSERT INTO site_accounts (account_id, link_code, link_code_expires_at)
     VALUES ($1, $2, $3)`,
    [accountId, code, expiresAt]
  )

  return { accountId, code, expiresAt: expiresAt.toISOString() }
}

async function getSiteAccountByCode(code) {
  const row = await dbGet(
    `SELECT account_id, link_code, link_code_expires_at, line_user_id, linked_at
     FROM site_accounts
     WHERE link_code = $1`,
    [code.toUpperCase()]
  )
  if (!row) return null
  return {
    accountId: row.account_id,
    code: row.link_code,
    expiresAt: row.link_code_expires_at,
    lineUserId: row.line_user_id,
    linkedAt: row.linked_at
  }
}

async function linkSiteAccount(lineUserId, code) {
  await ensureUser(lineUserId)
  const row = await dbGet(
    `SELECT account_id, link_code_expires_at, line_user_id
     FROM site_accounts
     WHERE link_code = $1`,
    [code.toUpperCase()]
  )

  if (!row) {
    return { ok: false, message: "そのコードは見つかりません。" }
  }

  if (row.line_user_id) {
    return { ok: false, message: "そのアカウントはすでに連携済みです。" }
  }

  if (new Date(row.link_code_expires_at).getTime() < Date.now()) {
    return { ok: false, message: "そのコードは期限切れです。サイトで再発行してください。" }
  }

  await dbRun(
    `UPDATE site_accounts
     SET line_user_id = $1, linked_at = NOW()
     WHERE account_id = $2`,
    [lineUserId, row.account_id]
  )

  return { ok: true, accountId: row.account_id }
}

// site users / sessions
async function registerSiteUser(username, password, hashPassword) {
  const crypto = require("crypto")
  const existing = await dbGet(
    "SELECT id FROM site_users WHERE username = $1",
    [username.toLowerCase()]
  )
  if (existing) {
    return { ok: false, message: "そのユーザー名はすでに使われています。" }
  }

  const userId = crypto.randomUUID()
  const token = crypto.randomBytes(32).toString("hex")
  const passwordHash = hashPassword(password)
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)

  await dbRun(
    `INSERT INTO site_users (id, username, password_hash)
     VALUES ($1, $2, $3)`,
    [userId, username.toLowerCase(), passwordHash]
  )
  await dbRun(
    `INSERT INTO site_sessions (token, site_user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [token, userId, expiresAt]
  )

  return {
    ok: true,
    token,
    user: { id: userId, username: username.toLowerCase(), linkedLineUserId: null }
  }
}

async function loginSiteUser(username, password, verifyPassword) {
  const user = await dbGet(
    "SELECT id, username, password_hash, linked_line_user_id FROM site_users WHERE username = $1",
    [username.toLowerCase()]
  )
  if (!user || !verifyPassword(password, user.password_hash)) {
    return { ok: false, message: "ユーザー名またはパスワードが違います。" }
  }

  const crypto = require("crypto")
  const token = crypto.randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)

  await dbRun(
    `INSERT INTO site_sessions (token, site_user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [token, user.id, expiresAt]
  )

  return {
    ok: true,
    token,
    user: { id: user.id, username: user.username, linkedLineUserId: user.linked_line_user_id }
  }
}

async function getSessionByToken(token) {
  const session = await dbGet(
    "SELECT token, site_user_id, expires_at FROM site_sessions WHERE token = $1",
    [token]
  )
  if (!session) return null
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await dbRun("DELETE FROM site_sessions WHERE token = $1", [token])
    return null
  }
  return session
}

async function getSiteUserById(userId) {
  const user = await dbGet(
    "SELECT id, username, created_at, linked_line_user_id, linked_account_id FROM site_users WHERE id = $1",
    [userId]
  )
  if (!user) return null
  return {
    id: user.id,
    username: user.username,
    createdAt: user.created_at,
    linkedLineUserId: user.linked_line_user_id,
    linkedAccountId: user.linked_account_id
  }
}

module.exports = {
  initDb,
  dbRun,
  dbAll,
  dbGet,
  ensureUser,
  getCoins,
  addCoins,
  transferCoins,
  addMessage,
  getLoginStreak,
  updateLoginStreak,
  getRank,
  getTopUsers,
  getUserRank,
  countLinkedAccounts,
  consumeDailyQuota,
  isBotMuted,
  setBotMuted,
  createSiteAccount,
  getSiteAccountByCode,
  linkSiteAccount,
  registerSiteUser,
  loginSiteUser,
  getSessionByToken,
  getSiteUserById
}
