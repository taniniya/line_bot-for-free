require("dotenv").config()

const express = require("express")
const line = require("@line/bot-sdk")
const axios = require("axios")
const FormData = require("form-data")
const sharp = require("sharp")
const fs = require("fs")
const path = require("path")
const os = require("os")
const crypto = require("crypto")
const { Pool } = require("pg")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("ffmpeg-static")

ffmpeg.setFfmpegPath(ffmpegPath)

const MAX_SIZE = 8 * 1024 * 1024
const handledEvents = new Set()
const SLOT_BET_REGEX = /^\/slot(?:\s+([\s\S]+))?$/i
const LINK_CODE_REGEX = /^\/link\s+([A-Za-z0-9]{6,12})$/i
const DELINK_REGEX = /^\/delink\b/i

const OPENROUTER_TEXT_MODEL =
  process.env.OPENROUTER_TEXT_MODEL || "openrouter/free"
const OPENROUTER_HTTP_REFERER = process.env.OPENROUTER_HTTP_REFERER || ""
const OPENROUTER_X_TITLE = process.env.OPENROUTER_X_TITLE || ""
const DAILY_LIMIT_TEXT = Number(process.env.DAILY_LIMIT_TEXT || "20")
const DAILY_LIMIT_IMAGE = Number(process.env.DAILY_LIMIT_IMAGE || "5")
const DATABASE_URL = process.env.DATABASE_URL || ""
const PGHOST = process.env.PGHOST || ""
const PGPORT = Number(process.env.PGPORT || "5432")
const PGDATABASE = process.env.PGDATABASE || ""
const PGUSER = process.env.PGUSER || ""
const PGPASSWORD = process.env.PGPASSWORD || ""
const PGSSL =
  process.env.PGSSL === "true" || /sslmode=require/i.test(DATABASE_URL)
const AUTH_COOKIE_NAME = "tanishi_auth"

// ===== Admin =====
const ADMIN_IDS = [
  "U3312c4d10c5721a06015134973db2eb4",
  "U7fda4ace4bdd23dc36b75fadfd7b0fd3",
  "U5129d0ffa6c01a6c1423143888e52568",
  "U0c3256073082dc61b471786a93d14465",
  "U5b5435164afb1310460ec3663e4c6fdf"
]

const ADMIN_OFFBOT_IDS = [
  "U7fda4ace4bdd23dc36b75fadfd7b0fd3",
  "U3312c4d10c5721a06015134973db2eb4"
]

// ===== Login Bonus Messages =====
const LOGIN_MESSAGES = [
  "お手伝いをして{coin}タニコインをもらった！",
  "漁に出て{coin}タニコインを稼いだ！",
  "ヤクザ事務所の掃除をして{coin}タニコインを手に入れた！",
  "闇バイトをして{coin}タニコインを受け取った！",
  "メルカリで転売して{coin}タニコインを設けた！",
  "街の人を脅して{coin}タニコイン奪った！",
  "一億年ボタンを押して{coin}タニコインをゲット！",
  "年上に媚を売って{coin}タニコインをいただいた！",
  "パチンコで{coin}タニコインを得た！",
  "オンラインカジノで{coin}タニコインを稼いだ！"
]

// ===== LINE =====
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
}
const lineClient = new line.Client(lineConfig)

// ===== PostgreSQL =====
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required for PostgreSQL.")
  process.exit(1)
}

const pool = new Pool({
  ...(DATABASE_URL
    ? { connectionString: DATABASE_URL }
    : {
        host: PGHOST,
        port: PGPORT,
        database: PGDATABASE,
        user: PGUSER,
        password: PGPASSWORD
      }),
  ssl: PGSSL ? { rejectUnauthorized: false } : false
})

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

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${derived}`
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || "").split(":")
  if (!salt || !hash) return false
  const derived = crypto.scryptSync(password, salt, 64).toString("hex")
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"))
}

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 30
  })
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME)
}

function getCookie(req, name) {
  const header = req.headers.cookie || ""
  const cookies = header.split(";").map((part) => part.trim())
  for (const entry of cookies) {
    const index = entry.indexOf("=")
    if (index < 0) continue
    const key = entry.slice(0, index)
    const value = entry.slice(index + 1)
    if (key === name) return decodeURIComponent(value)
  }
  return null
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj)
  } catch {
    return "[unserializable]"
  }
}

function logError(label, err, meta = {}) {
  const base = {
    label,
    message: err?.message,
    stack: err?.stack,
    status: err?.response?.status,
    data: err?.response?.data
  }
  console.error(safeStringify({ ...base, ...meta }))
}

// ===== Profile (with icon) =====
async function getProfileFull(userId) {
  try {
    const p = await lineClient.getProfile(userId)
    return {
      name: p.displayName,
      icon: p.pictureUrl || null
    }
  } catch {
    return {
      name: userId,
      icon: null
    }
  }
}

// ===== Static Directory =====
const STATIC_DIR = path.join(__dirname, "static")
if (!fs.existsSync(STATIC_DIR)) {
  fs.mkdirSync(STATIC_DIR)
}

// ===== Express =====
const app = express()
app.use("/static", express.static(STATIC_DIR))
app.use(express.json())
app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, "dashboard.html"))
})
app.get("/panel", (_req, res) => {
  res.redirect("/")
})
app.get("/api/dashboard", async (_req, res) => {
  try {
    const data = await buildDashboardData()
    res.json(data)
  } catch (e) {
    logError("dashboard_error", e)
    res.status(500).json({ error: "failed_to_build_dashboard" })
  }
})
app.post("/api/site-accounts", async (_req, res) => {
  try {
    const session = await getSessionFromRequest(_req)
    const account = await createSiteAccount(session?.site_user_id || null)
    res.json(account)
  } catch (e) {
    logError("site_account_create_error", e)
    res.status(500).json({ error: "failed_to_create_account" })
  }
})
app.get("/api/site-accounts/:code", async (req, res) => {
  try {
    const account = await getSiteAccountByCode(req.params.code)
    if (!account) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.json(account)
  } catch (e) {
    logError("site_account_lookup_error", e)
    res.status(500).json({ error: "failed_to_lookup_account" })
  }
})
app.post("/api/auth/register", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim()
    const password = String(req.body?.password || "")
    if (!username || !password) {
      res.status(400).json({ error: "username_and_password_required" })
      return
    }

    const result = await registerSiteUser(username, password)
    if (!result.ok) {
      res.status(400).json({ error: result.message })
      return
    }

    setAuthCookie(res, result.token)
    res.json({ ok: true, user: result.user })
  } catch (e) {
    logError("auth_register_error", e)
    res.status(500).json({ error: "failed_to_register" })
  }
})
app.post("/api/auth/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim()
    const password = String(req.body?.password || "")
    if (!username || !password) {
      res.status(400).json({ error: "username_and_password_required" })
      return
    }

    const result = await loginSiteUser(username, password)
    if (!result.ok) {
      res.status(401).json({ error: result.message })
      return
    }

    setAuthCookie(res, result.token)
    res.json({ ok: true, user: result.user })
  } catch (e) {
    logError("auth_login_error", e)
    res.status(500).json({ error: "failed_to_login" })
  }
})
app.post("/api/auth/logout", async (_req, res) => {
  clearAuthCookie(res)
  res.json({ ok: true })
})
app.get("/api/auth/me", async (req, res) => {
  try {
    const session = await getSessionFromRequest(req)
    if (!session) {
      res.json({ authenticated: false })
      return
    }
    const user = await getSiteUserById(session.site_user_id)
    if (!user) {
      clearAuthCookie(res)
      res.json({ authenticated: false })
      return
    }
    res.json({ authenticated: true, user })
  } catch (e) {
    logError("auth_me_error", e)
    res.status(500).json({ error: "failed_to_load_session" })
  }
})
// ===== Webhook =====
app.post("/webhook", (req, res, next) => {
  const signature = req.headers["x-line-signature"]
  if (!signature) {
    res.sendStatus(200)
    return
  }

  line.middleware(lineConfig)(req, res, next)
}, (req, res) => {
  res.sendStatus(200)

  ;(async () => {
    for (const event of req.body.events) {
      try {
        if (event.type === "message") {
          if (isHandled(event)) continue

          if (event.message.type === "text") await handleText(event)
          if (event.message.type === "image") await handleImage(event)
          if (event.message.type === "video") await handleVideo(event)
        }

        if (event.type === "memberJoined") {
          await sendDiscord(`JOIN\n${event.joined.members[0].userId}`)
        }

        if (event.type === "memberLeft") {
          await sendDiscord(`LEAVE\n${event.left.members[0].userId}`)
        }
      } catch (e) {
        logError("event_error", e, {
          type: event?.type,
          userId: event?.source?.userId,
          messageType: event?.message?.type
        })
      }
    }
  })()
})


// ===== 再送防止 =====
function isHandled(event) {
  const id = event.message?.id
  if (!id) return false

  if (handledEvents.has(id)) return true
  handledEvents.add(id)

  setTimeout(() => handledEvents.delete(id), 5 * 60 * 1000)
  return false
}

// ===== 共通 =====
async function getProfile(userId) {
  try {
    const p = await lineClient.getProfile(userId)
    return p.displayName
  } catch {
    return userId
  }
}

async function getLineContent(messageId) {
  const res = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
      }
    }
  )
  return Buffer.from(res.data)
}

// ===== テキスト =====
async function handleText(event) {
  const userId = event.source.userId
  const text = event.message.text || ""

  await addMessage(userId)
  const userHandled = await handleUserCommands(event, text)
  if (userHandled) return
  const adminHandled = await handleAdminCommands(event, text)
  if (adminHandled) return

  const name = await getProfile(event.source.userId)

  await sendDiscord(
`LINE
送信者：${name}
内容：${event.message.text}`
  )
}

// ===== 画像 =====
async function handleImage(event) {
  const name = await getProfile(event.source.userId)
  const buffer = await getLineContent(event.message.id)

  const result = await compressImage(buffer)
  if (!result.ok) {
    await sendDiscord(`画像サイズオーバー\n送信者：${name}`)
    return
  }

  await sendDiscordFile(
    result.buffer,
    "image.jpg",
    `IMAGE\n送信者：${name}（圧縮${result.step}回）`
  )
}

// ===== 動画 =====
async function handleVideo(event) {
  const name = await getProfile(event.source.userId)
  const buffer = await getLineContent(event.message.id)

  if (buffer.length <= MAX_SIZE) {
    await sendDiscordFile(buffer, "video.mp4", `VIDEO\n送信者：${name}`)
    return
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "line-video-"))
  const tmpIn = path.join(workDir, "input.mp4")
  const steps = [
    { size: "854x480", bitrate: "900k" },
    { size: "640x360", bitrate: "600k" },
    { size: "480x270", bitrate: "420k" }
  ]

  try {
    fs.writeFileSync(tmpIn, buffer)

    for (let i = 0; i < steps.length; i++) {
      const tmpOut = path.join(workDir, `output-${i}.mp4`)
      await encodeVideo(tmpIn, tmpOut, steps[i])
      const outBuf = fs.readFileSync(tmpOut)

      if (outBuf.length <= MAX_SIZE) {
        await sendDiscordFile(
          outBuf,
          "video.mp4",
          `VIDEO\n送信者：${name}（圧縮${i + 1}回）`
        )
        return
      }
    }

    await sendDiscord(`動画サイズオーバー\n送信者：${name}`)
  } finally {
    cleanup(workDir)
  }
}

// ===== 圧縮 =====
async function compressImage(buffer) {
  if (buffer.length <= MAX_SIZE) return { ok: true, buffer, step: 0 }

  let out = await sharp(buffer).jpeg({ quality: 75 }).toBuffer()
  if (out.length <= MAX_SIZE) return { ok: true, buffer: out, step: 1 }

  out = await sharp(out)
    .resize({ width: 1280, withoutEnlargement: true })
    .jpeg({ quality: 50 })
    .toBuffer()

  if (out.length <= MAX_SIZE) return { ok: true, buffer: out, step: 2 }

  return { ok: false }
}

function encodeVideo(input, output, opt) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .size(opt.size)
      .videoBitrate(opt.bitrate)
      .outputOptions([
        "-preset veryfast",
        "-movflags +faststart",
        "-pix_fmt yuv420p",
        "-c:v libx264",
        "-c:a aac",
        "-b:a 128k",
        "-ac 2"
      ])
      .save(output)
      .on("end", resolve)
      .on("error", reject)
  })
}

// ===== Discord =====
async function sendDiscordFile(buffer, filename, content) {
  const form = new FormData()
  form.append("payload_json", JSON.stringify({ content }))
  form.append("file", buffer, { filename })

  const res = await axios.post(process.env.DISCORD_WEBHOOK_URL, form, {
    headers: form.getHeaders()
  })

  const attachment = res.data?.attachments?.[0]
  return attachment?.url || null
}

async function sendDiscord(content) {
  try {
    await axios.post(
      process.env.DISCORD_WEBHOOK_URL,
      { content },
      { headers: { "Content-Type": "application/json" } }
    )
  } catch (e) {
    logError("discord_error", e)
  }
}

function cleanup(...targets) {
  for (const target of targets) {
    if (!target || !fs.existsSync(target)) continue
    const stat = fs.statSync(target)
    if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true })
    } else {
      fs.unlinkSync(target)
    }
  }
}
// ===== Data =====
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

async function ensureUser(userId) {
  await dbRun(
    "INSERT INTO users (user_id, coins, messages) VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING",
    [userId]
  )
}



// ===== streak（連続ログイン） =====
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

// ===== LINE返信（テキスト） =====
async function replyText(event, text) {
  try {
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text
    })
  } catch (e) {
    console.error("replyText error:", e)
  }
}

async function buildRankText(key, title) {
  const rows = await getRank(key)
  if (!Array.isArray(rows)) return "ランキング取得エラー"

  let text = `🏆 ${title}\n\n`

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const name = await getProfile(row.user_id)
    text += `${i + 1}位: ${name} - ${row.value} ${key === "coins" ? "コイン" : "回"}\n`
  }

  return text
}

async function buildDashboardData() {
  const [coinRank, messageRank, topUsers] = await Promise.all([
    getRank("coins", 10),
    getRank("messages", 10),
    getTopUsers(10)
  ])

  const decorate = async (rows, unit) =>
    Promise.all(
      rows.map(async (row, index) => ({
        rank: index + 1,
        userId: row.user_id,
        name: await getProfile(row.user_id),
        value: row.value,
        unit
      }))
    )

  return {
    updatedAt: new Date().toISOString(),
    coinRank: await decorate(coinRank, "coins"),
    messageRank: await decorate(messageRank, "messages"),
    topUsers: await Promise.all(
      topUsers.map(async (row, index) => ({
        rank: index + 1,
        userId: row.user_id,
        name: await getProfile(row.user_id),
        coins: row.coins,
        messages: row.messages
      }))
    ),
    linkedAccounts: await countLinkedAccounts()
  }
}

function pickSlotResult() {
  const roll = Math.random()
  if (roll < 1 / 3) return { multiplier: 2, label: "2倍" }
  if (roll < 1 / 3 + 1 / 5) return { multiplier: 5, label: "5倍" }
  if (roll < 1 / 3 + 1 / 5 + 1 / 10) return { multiplier: 10, label: "10倍" }
  return { multiplier: 0, label: "ハズレ" }
}

async function handleSlot(event, text) {
  const match = text.trim().match(SLOT_BET_REGEX)
  if (!match) return false

  const userId = event.source.userId
  const currentCoins = await getCoins(userId)
  const betRaw = (match[1] || "").trim()

  if (!betRaw) {
    await replyText(event, "使い方: /slot 100 か /slot all")
    return true
  }

  const bet = betRaw.toLowerCase() === "all" ? currentCoins : Number(betRaw)
  if (!Number.isFinite(bet) || bet <= 0) {
    await replyText(event, "ベットは1以上の数値か all を指定してね。")
    return true
  }

  if (currentCoins <= 0) {
    await replyText(event, "コインがありません。")
    return true
  }

  if (bet > currentCoins) {
    await replyText(event, `コインが足りません。（所持：${currentCoins}）`)
    return true
  }

  await addCoins(userId, -bet)
  const result = pickSlotResult()
  const payout = Math.floor(bet * result.multiplier)
  if (payout > 0) {
    await addCoins(userId, payout)
  }

  const after = await getCoins(userId)
  const net = payout - bet
  const lines = [
    "🎰 スロット",
    `ベット：${bet}`,
    `結果：${result.label}`,
    result.multiplier > 0 ? `当たり！ ${net >= 0 ? "+" : ""}${net} コイン` : `ハズレ… -${bet} コイン`,
    `現在の所持コイン：${after}`
  ]

  await replyText(event, lines.join("\n"))
  return true
}


// ===== User Commands =====
async function handleUserCommands(event, text) {
  const trimmed = text.trim()

  // ===== /tenki =====
  if (trimmed === "/tenki") {
    try {
      // 富津市の座標
      const lat = 35.306
      const lon = 139.856

      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=Asia%2FTokyo`

      const res = await axios.get(url)
      const cur = res.data.current

      const weatherCode = cur.weather_code
      const temp = cur.temperature_2m
      const wind = cur.wind_speed_10m

      // 天気コード → 日本語
      const weatherMap = {
        0: "快晴",
        1: "晴れ",
        2: "薄曇り",
        3: "曇り",
        45: "霧",
        48: "霧氷",
        51: "霧雨（弱）",
        53: "霧雨（中）",
        55: "霧雨（強）",
        61: "雨（弱）",
        63: "雨（中）",
        65: "雨（強）",
        71: "雪（弱）",
        73: "雪（中）",
        75: "雪（強）",
        95: "雷雨",
        99: "ひょうを伴う雷雨"
    }

      const weather = weatherMap[weatherCode] || "不明"

      const msg =
   `🌤 現在の天気（Open-Meteo）
  天気：${weather}
  気温：${temp}℃
  風速：${wind} m/s`

      await replyText(event, msg)
      return true

    } catch (e) {
      logError("tenki_error", e)
      await replyText(event, "天気情報の取得に失敗しました。")
      return true
    }
  }


  // ===== /omikuzi =====
  if (trimmed === "/omikuzi" || trimmed === "/omikuji" || trimmed === "/おみくじ") {
    const results = ["bigたにし","NORMALたにし","ちびたにし","もずく","いいことありそう","さいあく","タニシの天敵"]
    const result = results[Math.floor(Math.random() * results.length)]

    const msg =
  `おみくじ結果
  今日の運勢は…【${result}】`

    await replyText(event, msg)
    return true
  }

  // ===== /help =====
  if (trimmed === "/help") {
    const help = [
      "コマンド一覧",
      "",
      "全員OK",
      "/ai <内容>  -AIと会話-",
      "/mycoin  -自分のコイン数-",
      "/myrank  -自分の順位-",
      "/login <コード>  -ホームページ連携-",
      "/link <コード>  -ホームページ連携-",
      "/delink  -連携解除とアカウント削除-",
      "/login  -ログインボーナス-",
      "/tenki  -天気-",
      "/omikuzi  -おみくじ-",
      "/rob @ユーザー  -そのユーザーのコインを盗む-",
      "/rank coints  -コインランキング-",
      "/coints <表/裏> <金額 or all>  -コイントスギャンブル-",
      "/slot <金額 or all>  -コインスロット-",
      "/pay <金額> @メンション  -コイン送金-",
      "",
      "管理者のみ",
      "/give coin <数> @メンション  -コイン付与-",
      "/rank  -発言回数ランキング-",
      "/rank coin  -コイン所持数ランキング-",
      "/uid @メンション  -ID取得(Discord送信)-",
      "/admins  -管理者一覧-",
      "/resetrank  -発言回数リセット-",
      "/offbot @メンション  -AI無効化-",
      "/onbot @メンション  -AI有効化-",
      "",
      "adminのみ",
      "/adminoffbot @メンション  -強制無効化-",
      "/adminonbot @メンション  -強制無効化解除-"
    ].join("\n")

    await replyText(event, help)
    return true
  }


  // ===== /login =====
  if (trimmed === "/login") {
    try {
      const userId = event.source.userId

      const quota = await consumeDailyQuota(userId, "login", 1)
      if (!quota.ok) {
        await replyText(event, "今日はすでにログインボーナスを受け取っています。")
        return true
      }

      let coin
      let rare = false
      if (Math.random() < 0.01) {
        coin = 200
        rare = true
      } else {
        coin = Math.floor(Math.random() * 10) + 1
      }

      const streak = await updateLoginStreak(userId)
      const streakBonus = Math.min(streak, 7) * 10

      let streakMsg = ""
      if (streak === 1) streakMsg = "今日から連続ログイン開始 毎日/loginでログインボーナスをもらおう!"
      else if (streak === 2) streakMsg = " 2日連続ログイン!いい調子！"
      else if (streak === 3) streakMsg = " 3日連続ログイン!たにしホーム信者の卵！"
      else if (streak === 4) streakMsg = " 4日連続ログイン!その調子！"
      else if (streak === 5) streakMsg = " 5日連続ログイン!すごい！"
      else if (streak === 6) streakMsg = " 6日連続ログイン!あと少しで最大！"
      else if (streak >= 7) streakMsg = " 7日連続ログイン達成!たにしホーム信者だぁ！"

      const total = coin + streakBonus
      await addCoins(userId, total)

      const msgTemplate = LOGIN_MESSAGES[Math.floor(Math.random() * LOGIN_MESSAGES.length)]
      const baseMsg = msgTemplate.replace("{coin}", coin)

      let reply = `!ログインボーナス！\n${baseMsg}\n`
      reply += `${streakMsg}\n`
      reply += `連続ログイン：${streak}日目 (+${streakBonus})\n`
      reply += `合計：${total} タニコイン`

      if (rare) {
        reply = `🌟🌟 超レア!500コイン獲得! 🌟🌟\n` + reply
      }

      await replyText(event, reply)
      await sendDiscord(`LOGIN BONUS\nUser: ${userId}\n${reply}`)

      return true
    } catch (e) {
      logError("login_bonus_error", e)
      await replyText(event, "ログインボーナスの取得に失敗しました。")
      return true
    }
  }

  const loginLinkMatch = trimmed.match(/^\/login\s+([A-Za-z0-9]{6,12})$/i)
  if (loginLinkMatch) {
    const code = loginLinkMatch[1].toUpperCase()
    const result = await linkSiteAccount(event.source.userId, code)

    if (!result.ok) {
      await replyText(event, result.message)
      return true
    }

    await replyText(event, `連携できました。\nアカウントID: ${result.accountId}`)
    return true
  }

  // ===== /link =====
  const linkMatch = trimmed.match(LINK_CODE_REGEX)
  if (linkMatch) {
    const code = linkMatch[1].toUpperCase()
    const result = await linkSiteAccount(event.source.userId, code)

    if (!result.ok) {
      await replyText(event, result.message)
      return true
    }

    await replyText(event, `連携しました。\nアカウントID: ${result.accountId}`)
    return true
  }

  // ===== /delink =====
  if (DELINK_REGEX.test(trimmed)) {
    const result = await delinkSiteAccount(event.source.userId)
    if (!result.ok) {
      await replyText(event, result.message)
      return true
    }

    await replyText(event, "連携を解除してアカウントを削除しました。")
    return true
  }

  


  // ===== /rob =====
  const stealMatch = trimmed.match(/^\/rob\b/i)
  if (stealMatch) {
    const mentioned = getMentionedUserIds(event)
    if (mentioned.length === 0) {
      await replyText(event, "誰から盗むのか @メンション してね。")
      return true
    }
  
    const fromId = event.source.userId
    const toId = mentioned[0]
  
    // ★ クールタイム（1時間）
    const quota = await consumeDailyQuota(fromId, "rob", 1, 60)
    if (!quota.ok) {
      await replyText(event, `クールダウン中`)
      return true
    }
  
    if (fromId === toId) {
      await replyText(event, "自分自身からは盗めません。")
      return true
    }
  
    const targetCoins = await getCoins(toId)
    if (targetCoins <= 0) {
      await replyText(event, "相手のコインが0なので盗めません。")
      return true
    }
  
    // 1〜10コイン（ログボと同じ経済）
    const amount = Math.floor(Math.random() * 10) + 1
  
    // 成功判定（25%）
    const success = Math.random() < 0.25
  
    if (success) {
      const stealAmount = Math.min(amount, targetCoins)
      await addCoins(toId, -stealAmount)
      await addCoins(fromId, stealAmount)
  
      await replyText(event,
  `強盗成功！
  ${stealAmount} コインを奪い取った！`)
    } else {
      const myCoins = await getCoins(fromId)
      const penalty = Math.min(amount, myCoins)
  
      await addCoins(fromId, -penalty)
  
      await replyText(event,
  `強盗失敗！
  罰金として ${penalty} コインが課された…`)
    }

    return true
  }



  // ===== /ai =====
  const aiMatch = trimmed.match(/^\/ai\s+([\s\S]+)/i)
  if (aiMatch) {
    const prompt = aiMatch[1].trim()
    if (!prompt) {
      await replyText(event, "話したい内容を入れてください。例：/ai こんにちは")
      return true
    }

    try {
      const quota = await consumeDailyQuota(event.source.userId, "text", DAILY_LIMIT_TEXT)
      if (!quota.ok) {
        await replyText(event, `本日の利用上限に達しました。（上限：${quota.limit}）`)
        return true
      }

      const result = await askAi(prompt)
      if (!result.ok) {
        await replyText(event, result.error)
        return true
      }

      await sendDiscord(`AI\nPrompt: ${prompt}\nResponse:\n${result.text}`)
      await replyText(event, result.text)
      return true
    } catch (e) {
      logError("ai_error", e)
      if (isQuotaError(e)) {
        await replyText(event, "APIの制限に到達しました。時間をおいて再度お試しください。")
      } else {
        await replyText(event, "AIの呼び出しに失敗しました。")
      }
      return true
    }
  }

  // ===== /mycoin =====
  if (trimmed === "/mycoin") {
    const coins = await getCoins(event.source.userId)
    await replyText(event, `所持コイン：${coins}`)
    return true
  }

  // ===== /myrank =====
  if (trimmed === "/myrank") {
    const userId = event.source.userId
    const rankMsg = await getUserRank(userId, "messages")
    const rankCoin = await getUserRank(userId, "coins")

    const msg = [
      "あなたの順位",
      `発言回数：${rankMsg ?? "-"}位`,
      `コイン：${rankCoin ?? "-"}位`
    ].join("\n")

    await replyText(event, msg)
    return true
  }


  // ===== /coints =====
  const cointsMatch = trimmed.match(/^\/coints\s+(\S+)\s+(\S+)/i)
  if (cointsMatch) {
    const choiceRaw = cointsMatch[1]
    const betRaw = cointsMatch[2]

    // 表裏判定
    let choice
    if (choiceRaw === "表" || choiceRaw.toLowerCase() === "omote") {
      choice = "表"
    } else if (choiceRaw === "裏" || choiceRaw.toLowerCase() === "ura") {
      choice = "裏"
    } else {
      await replyText(event, "表 か 裏 を指定してね。例：/coints 表 100")
      return true
    }

    const userId = event.source.userId
    const currentCoins = await getCoins(userId)

    // ベット額決定
    let bet
    if (betRaw.toLowerCase() === "all") {
      bet = currentCoins
    } else {
      bet = Number(betRaw)
    }

    if (!Number.isFinite(bet) || bet <= 0) {
      await replyText(event, "かけるコインは1以上で指定してね。例：/coints 表 100")
      return true
    }

    if (currentCoins <= 0) {
      await replyText(event, "コインがありません。まず /login や 管理者からもらったりして でコインを用意してね。")
      return true
    }

    if (bet > currentCoins) {
      await replyText(event, `コインが足りません。（所持：${currentCoins}）`)
      return true
    }

    // コイントス（0:表, 1:裏）
    const flip = Math.random() < 0.5 ? "表" : "裏"
    const win = (flip === choice)

    let diff = win ? bet : -bet
    await addCoins(userId, diff)
    const after = await getCoins(userId)

    const msgLines = []
    msgLines.push("🪙 コイントス！")
    msgLines.push(`あなたの選択：${choice}`)
    msgLines.push(`結果：${flip}`)
    msgLines.push(win ? `🎉 勝ち！ +${bet} コイン` : `💸 負け… -${bet} コイン`)
    msgLines.push(`現在の所持コイン：${after}`)

    await replyText(event, msgLines.join("\n"))
    return true
  }

  // ===== /slot =====
  if (SLOT_BET_REGEX.test(trimmed)) {
    return handleSlot(event, text)
  }


  // ===== /pay =====
  const payMatch = trimmed.match(/^\/pay\b/i)
  if (payMatch) {
    const mentioned = getMentionedUserIds(event)
    if (mentioned.length === 0) {
      await replyText(event, "メンションされたユーザーが見つかりません。")
      return true
    }

    const amountMatch = trimmed.match(/(-?\d+)/)
    if (!amountMatch) {
      await replyText(event, "渡すコインの数を指定してください。")
      return true
    }

    const amount = Number(amountMatch[1])
    if (!Number.isFinite(amount) || amount <= 0) {
      await replyText(event, "コインの数は1以上で指定してください。")
      return true
    }

    const fromId = event.source.userId
    const toId = mentioned[0]
    if (fromId === toId) {
      await replyText(event, "自分自身には送れません。")
      return true
    }

    const result = await transferCoins(fromId, toId, amount)
    if (!result.ok) {
      await replyText(event, `コインが足りません。（所持：${result.balance}）`)
      return true
    }

    await replyText(event, `🪙${amount}を送信しました。`)
    return true
  }

  return false
}

// ===== Admin Commands =====
async function handleAdminCommands(event, text) {
  const userId = event.source.userId
  if (!isAdmin(userId)) return false

  const trimmed = text.trim()

  // ===== /give coin =====
  const giveMatch = trimmed.match(/^\/give\s+coin\s+(-?\d+)\b/i)
  if (giveMatch) {
    const amount = Number(giveMatch[1])
    const mentioned = getMentionedUserIds(event)
    if (mentioned.length === 0) {
      await replyText(event, "メンションされたユーザーが見つかりません。")
      return true
    }

    const targetId = mentioned[0]
    await addCoins(targetId, amount)

    await replyText(event, `🪙を${amount}付与しました。`)
    return true
  }

  // ===== /uid =====
  const uidMatch = trimmed.match(/^\/uid\b/i)
  if (uidMatch) {
    const mentioned = getMentionedUserIds(event)
    if (mentioned.length === 0) {
      await replyText(event, "メンションされたユーザーが見つかりません。")
      return true
    }

    const lines = await Promise.all(
      mentioned.map(async (id) => {
        const name = await getProfile(id)
        return `${name}\n${id}`
      })
    )

    await sendDiscord(`UID\n${lines.join("\n\n")}`)
    await replyText(event, "Discordに送信しました。")
    return true
  }

  // ===== /rank =====
  if (trimmed === "/rank") {
    const lines = await buildRankText("messages", "発言回数ランキング")
    await replyText(event, lines)
    return true
  }

  // ===== /rank coin =====
  if (trimmed === "/rank coin") {
    const lines = await buildRankText("coins", "コイン所持数ランキング")
    await replyText(event, lines)
    return true
  }

  // ===== /offbot =====
  const offMatch = trimmed.match(/^\/offbot\b/i)
  if (offMatch) {
    const mentioned = getMentionedUserIds(event)
    if (mentioned.length === 0) {
      await replyText(event, "メンションされたユーザーが見つかりません。")
      return true
    }

    if (isAdmin(mentioned[0])) {
      await replyText(event, "管理者は対象外です。")
      return true
    }

    const targetState = await isBotMuted(mentioned[0])
    if (targetState.muted && targetState.mode === "admin") {
      await replyText(event, "このユーザーはadminoffbot中です。adminonbotで解除してください。")
      return true
    }

    await setBotMuted(mentioned[0], true, "normal")
    await replyText(event, "AIを無効化しました。")
    return true
  }

  // ===== /onbot =====
  const onMatch = trimmed.match(/^\/onbot\b/i)
  if (onMatch) {
    const mentioned = getMentionedUserIds(event)
    if (mentioned.length === 0) {
      await replyText(event, "メンションされたユーザーが見つかりません。")
      return true
    }

    const targetState = await isBotMuted(mentioned[0])
    if (targetState.muted && targetState.mode === "admin") {
      await replyText(event, "このユーザーはadminoffbot中です。adminonbotで解除してください。")
      return true
    }

    await setBotMuted(mentioned[0], false)
    await replyText(event, "AIを有効化しました。")
    return true
  }

  // ===== /adminoffbot =====
  const adminOffMatch = trimmed.match(/^\/adminoffbot\b/i)
  if (adminOffMatch) {
    if (!canAdminOffbot(userId)) {
      await replyText(event, "権限がありません。")
      return true
    }

    const mentioned = getMentionedUserIds(event)
    if (mentioned.length === 0) {
      await replyText(event, "メンションされたユーザーが見つかりません。")
      return true
    }

    await setBotMuted(mentioned[0], true, "admin")
    await replyText(event, "adminoffbot を設定しました。")
    return true
  }

  // ===== /adminonbot =====
  const adminOnMatch = trimmed.match(/^\/adminonbot\b/i)
  if (adminOnMatch) {
    if (!canAdminOffbot(userId)) {
      await replyText(event, "権限がありません。")
      return true
    }

    const mentioned = getMentionedUserIds(event)
    if (mentioned.length === 0) {
      await replyText(event, "メンションされたユーザーが見つかりません。")
      return true
    }

    const targetState = await isBotMuted(mentioned[0])
    if (!targetState.muted || targetState.mode !== "admin") {
      await replyText(event, "adminoffbot が設定されていません。")
      return true
    }

    await setBotMuted(mentioned[0], false)
    await replyText(event, "adminoffbot を解除しました。")
    return true
  }

  // ===== /resetrank =====
  if (trimmed === "/resetrank") {
    await dbRun("UPDATE users SET messages = 0")
    await replyText(event, "発言回数ランキングをリセットしました。")
    return true
  }

  // ===== /admins =====
  if (trimmed === "/admins") {
    const ids = Array.from(new Set(ADMIN_IDS)).filter(Boolean)
    if (ids.length === 0) {
      await replyText(event, "管理者が登録されていません。")
      return true
    }

    const names = await Promise.all(ids.map(id => getProfile(id)))
    const lines = ids.map((id, i) => `${i + 1}. ${names[i]} ${id}`)

    await replyText(event, `管理者一覧\n${lines.join("\n")}`)
    return true
  }

  return false
}
// ===== ランキング取得 =====
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

async function countLinkedAccounts() {
  const row = await dbGet(
    "SELECT COUNT(*)::int AS count FROM site_accounts WHERE line_user_id IS NOT NULL",
    []
  )
  return row?.count ?? 0
}

async function createSiteAccount(siteUserId = null) {
  const accountId = crypto.randomUUID()
  const code = crypto.randomBytes(3).toString("hex").toUpperCase()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

  await dbRun(
    `INSERT INTO site_accounts (account_id, link_code, link_code_expires_at)
     VALUES ($1, $2, $3)`,
    [accountId, code, expiresAt]
  )

  if (siteUserId) {
    await dbRun(
      `UPDATE site_users
       SET linked_account_id = $1
       WHERE id = $2`,
      [accountId, siteUserId]
    )
  }

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

async function registerSiteUser(username, password) {
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

async function loginSiteUser(username, password) {
  const user = await dbGet(
    "SELECT id, username, password_hash, linked_line_user_id FROM site_users WHERE username = $1",
    [username.toLowerCase()]
  )
  if (!user || !verifyPassword(password, user.password_hash)) {
    return { ok: false, message: "ユーザー名またはパスワードが違います。" }
  }

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

async function getSessionFromRequest(req) {
  const token = getCookie(req, AUTH_COOKIE_NAME)
  if (!token) return null
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

async function linkSiteAccount(lineUserId, code, siteUserId = null) {
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

  if (siteUserId) {
    await dbRun(
      `UPDATE site_users
       SET linked_line_user_id = $1, linked_account_id = $2
       WHERE id = $3`,
      [lineUserId, row.account_id, siteUserId]
    )
  }

  return { ok: true, accountId: row.account_id }
}

async function delinkSiteAccount(lineUserId) {
  const account = await dbGet(
    `SELECT account_id FROM site_accounts WHERE line_user_id = $1`,
    [lineUserId]
  )

  if (!account) {
    return { ok: false, message: "連携されていません。" }
  }

  const siteUser = await dbGet(
    `SELECT id FROM site_users WHERE linked_line_user_id = $1`,
    [lineUserId]
  )

  await dbRun(`DELETE FROM site_sessions WHERE site_user_id = $1`, [
    siteUser?.id || null
  ])
  await dbRun(`DELETE FROM site_users WHERE linked_line_user_id = $1`, [
    lineUserId
  ])
  await dbRun(`DELETE FROM site_accounts WHERE line_user_id = $1`, [lineUserId])

  return { ok: true }
}

async function getUserRank(userId, key) {
  const rows = await dbAll(
    `SELECT user_id, ${key} AS value FROM users ORDER BY ${key} DESC`,
    []
  )
  const index = rows.findIndex(r => r.user_id === userId)
  return index >= 0 ? index + 1 : null
}

// ===== コイン処理 =====
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

// ===== 発言回数 =====
async function addMessage(userId) {
  await ensureUser(userId)
  await dbRun("UPDATE users SET messages = messages + 1 WHERE user_id = $1", [
    userId
  ])
}

// ===== 日付（JST） =====
function getTodayJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date())
}

// ===== 利用制限 =====
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

// ===== ミュート管理 =====
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

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId)
}

function canAdminOffbot(userId) {
  return ADMIN_OFFBOT_IDS.includes(userId)
}

// ===== メンション取得 =====
function getMentionedUserIds(event) {
  const mention = event.message?.mention
  if (!mention || !Array.isArray(mention.mentionees)) return []
  return mention.mentionees
    .map(m => m.userId)
    .filter(Boolean)
}

// ===== OpenRouter AI =====
async function askAi(prompt) {
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: OPENROUTER_TEXT_MODEL,
        messages: [
          { role: "user", content: prompt }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": OPENROUTER_HTTP_REFERER,
          "X-Title": OPENROUTER_X_TITLE,
          "Content-Type": "application/json"
        },
        timeout: 60000
      }
    )

    const text =
      res.data?.choices?.[0]?.message?.content?.trim() ||
      "返答を生成できませんでした。"

    return { ok: true, text }
  } catch (e) {
    logError("openrouter_error", e)
    return {
      ok: false,
      error: "AI呼び出し中にエラーが発生しました。"
    }
  }
}

function isQuotaError(e) {
  return e?.response?.status === 429
}

// ===== サーバ起動 =====
const PORT = process.env.PORT || 3000
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bot running on port ${PORT}`)
    })
  })
  .catch((e) => {
    logError("db_init_error", e)
    process.exit(1)
  })
