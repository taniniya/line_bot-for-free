require("dotenv").config()

const express = require("express")
const line = require("@line/bot-sdk")
const axios = require("axios")
const FormData = require("form-data")
const sharp = require("sharp")
const fs = require("fs")
const path = require("path")
const { Pool } = require("pg")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("ffmpeg-static")

ffmpeg.setFfmpegPath(ffmpegPath)

const MAX_SIZE = 8 * 1024 * 1024
const handledEvents = new Set()
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"
const OPENROUTER_TEXT_MODEL =
  process.env.OPENROUTER_TEXT_MODEL || "nvidia/llama-nemotron-embed-vl-1b-v2:free"
const OPENROUTER_HTTP_REFERER = process.env.OPENROUTER_HTTP_REFERER || ""
const OPENROUTER_X_TITLE = process.env.OPENROUTER_X_TITLE || ""
const DAILY_LIMIT_TEXT = Number(process.env.DAILY_LIMIT_TEXT || "20")
const DAILY_LIMIT_IMAGE = Number(process.env.DAILY_LIMIT_IMAGE || "5")
const DATABASE_URL = process.env.DATABASE_URL || ""
const PGSSL =
  process.env.PGSSL === "true" || /sslmode=require/i.test(DATABASE_URL)

// ===== Admin =====
// Add multiple admin user IDs here.
const ADMIN_IDS = [
  "U3312c4d10c5721a06015134973db2eb4",
  "U3312c4d10c5721a06015134973db2eb4",
  "U7fda4ace4bdd23dc36b75fadfd7b0fd3",
  "U5129d0ffa6c01a6c1423143888e52568",
  "U0c3256073082dc61b471786a93d14465",
  "U5b5435164afb1310460ec3663e4c6fdf"
  
]
// Users who can use /adminoffbot and /adminonbot.
const ADMIN_OFFBOT_IDS = [
  "自分のID"
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
  connectionString: DATABASE_URL,
  ssl: PGSSL ? { rejectUnauthorized: false } : false
})

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

// ===== Express =====
const app = express()

app.post("/webhook", line.middleware(lineConfig), (req, res) => {
  // 超重要：先に200返す
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

  const tmpIn = path.join(__dirname, "in.mp4")
  const tmpOut = path.join(__dirname, "out.mp4")
  fs.writeFileSync(tmpIn, buffer)

  const steps = [
    { size: "854x480", bitrate: "800k" },
    { size: "640x360", bitrate: "500k" }
  ]

  for (let i = 0; i < steps.length; i++) {
    await encodeVideo(tmpIn, tmpOut, steps[i])
    const outBuf = fs.readFileSync(tmpOut)

    if (outBuf.length <= MAX_SIZE) {
      await sendDiscordFile(
        outBuf,
        "video.mp4",
        `VIDEO\n送信者：${name}（圧縮${i + 1}回）`
      )
      cleanup(tmpIn, tmpOut)
      return
    }
  }

  cleanup(tmpIn, tmpOut)
  await sendDiscord(`動画サイズオーバー\n送信者：${name}`)
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
      .outputOptions("-preset veryfast")
      .save(output)
      .on("end", resolve)
      .on("error", reject)
  })
}

// ===== Discord =====
async function sendDiscord(content) {
  await axios.post(process.env.DISCORD_WEBHOOK_URL, { content })
}

async function sendDiscordFile(buffer, filename, content) {
  const form = new FormData()
  form.append("payload_json", JSON.stringify({ content }))
  form.append("file", buffer, { filename })

  await axios.post(process.env.DISCORD_WEBHOOK_URL, form, {
    headers: form.getHeaders()
  })
}

function cleanup(...files) {
  files.forEach(f => fs.existsSync(f) && fs.unlinkSync(f))
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

async function ensureBotMuteTable() {
  await dbRun(
    "CREATE TABLE IF NOT EXISTS bot_mutes (user_id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'normal')"
  )
  try {
    await dbRun("ALTER TABLE bot_mutes ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'")
  } catch {
    // ignore if column already exists
  }
}

async function addMessage(userId) {
  await ensureUser(userId)
  await dbRun("UPDATE users SET messages = messages + 1 WHERE user_id = $1", [userId])
}

async function addCoins(userId, amount) {
  await ensureUser(userId)
  await dbRun("UPDATE users SET coins = coins + $1 WHERE user_id = $2", [amount, userId])
}

async function getCoins(userId) {
  await ensureUser(userId)
  const row = await dbGet("SELECT coins FROM users WHERE user_id = $1", [userId])
  return row ? Number(row.coins || 0) : 0
}

async function isBotMuted(userId) {
  await ensureBotMuteTable()
  const row = await dbGet("SELECT mode FROM bot_mutes WHERE user_id = $1", [userId])
  if (!row) return { muted: false, mode: null }
  return { muted: true, mode: row.mode || "normal" }
}

async function setBotMuted(userId, muted, mode = "normal") {
  await ensureBotMuteTable()
  if (muted) {
    await dbRun(
      "INSERT INTO bot_mutes (user_id, mode) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET mode = $2",
      [userId, mode]
    )
  } else {
    await dbRun("DELETE FROM bot_mutes WHERE user_id = $1", [userId])
  }
}

function getTodayJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date())
}

function isUnlimitedUser(userId) {
  return ADMIN_IDS.includes(userId)
}

async function consumeDailyQuota(userId, kind, limit) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { ok: true, remaining: null }
  }
  if (isUnlimitedUser(userId)) {
    return { ok: true, remaining: null, unlimited: true }
  }

  const date = getTodayJst()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(
      "INSERT INTO daily_usage (user_id, date, kind, count) VALUES ($1, $2, $3, 0) ON CONFLICT (user_id, date, kind) DO NOTHING",
      [userId, date, kind]
    )
    const rowRes = await client.query(
      "SELECT count FROM daily_usage WHERE user_id = $1 AND date = $2 AND kind = $3 FOR UPDATE",
      [userId, date, kind]
    )
    const count = rowRes.rows[0] ? Number(rowRes.rows[0].count || 0) : 0
    if (count >= limit) {
      await client.query("ROLLBACK")
      return { ok: false, remaining: 0, limit, count }
    }
    const upd = await client.query(
      "UPDATE daily_usage SET count = count + 1 WHERE user_id = $1 AND date = $2 AND kind = $3 RETURNING count",
      [userId, date, kind]
    )
    await client.query("COMMIT")
    const newCount = Number(upd.rows[0]?.count || count + 1)
    return { ok: true, remaining: limit - newCount, limit, count: newCount }
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

function isQuotaError(err) {
  const status = err?.response?.status
  const msg =
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    ""
  return status === 429 || /quota|RESOURCE_EXHAUSTED|rate limit/i.test(msg)
}

async function transferCoins(fromId, toId, amount) {
  await ensureUser(fromId)
  await ensureUser(toId)

  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const rowRes = await client.query(
      "SELECT coins FROM users WHERE user_id = $1 FOR UPDATE",
      [fromId]
    )
    const balance = rowRes.rows[0] ? Number(rowRes.rows[0].coins || 0) : 0
    if (balance < amount) {
      await client.query("ROLLBACK")
      return { ok: false, balance }
    }
    await client.query(
      "UPDATE users SET coins = coins - $1 WHERE user_id = $2",
      [amount, fromId]
    )
    await client.query(
      "UPDATE users SET coins = coins + $1 WHERE user_id = $2",
      [amount, toId]
    )
    await client.query("COMMIT")
    return { ok: true, balance: balance - amount }
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

async function getRank(key, limit = null) {
  const col = key === "coins" ? "coins" : "messages"
  if (limit === null) {
    return await dbAll(
      `SELECT user_id, ${col} AS value FROM users ORDER BY ${col} DESC`
    )
  }
  return await dbAll(
    `SELECT user_id, ${col} AS value FROM users ORDER BY ${col} DESC LIMIT $1`,
    [limit]
  )
}

async function getUserRank(userId, key) {
  const col = key === "coins" ? "coins" : "messages"
  const row = await dbGet(
    `SELECT rank FROM (
      SELECT user_id, RANK() OVER (ORDER BY ${col} DESC) AS rank
      FROM users
    ) t WHERE user_id = $1`,
    [userId]
  )
  return row ? Number(row.rank) : null
}

// ===== Admin Commands =====
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId)
}

function canAdminOffbot(userId) {
  return ADMIN_OFFBOT_IDS.includes(userId)
}

function getMentionedUserIds(event) {
  const list = event.message?.mention?.mentionees
  if (!Array.isArray(list)) return []
  return list.map(m => m.userId).filter(Boolean)
}

async function replyText(event, text) {
  if (!event.replyToken) return
  await lineClient.replyMessage(event.replyToken, {
    type: "text",
    text
  })
}

function getOpenRouterHeaders(apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  }
  if (OPENROUTER_HTTP_REFERER) headers["HTTP-Referer"] = OPENROUTER_HTTP_REFERER
  if (OPENROUTER_X_TITLE) headers["X-Title"] = OPENROUTER_X_TITLE
  return headers
}

async function askAi(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return { ok: false, error: "OPENROUTER_API_KEY が未設定です。" }
  }

  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: OPENROUTER_TEXT_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant. Always reply in Japanese."
        },
        { role: "user", content: prompt }
      ]
    },
    {
      headers: getOpenRouterHeaders(apiKey),
      timeout: 30000
    }
  )

  const data = res.data || {}
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) return { ok: false, error: "AIの応答を取得できませんでした。" }
  return { ok: true, text }
}


// ===== User Commands =====
async function handleUserCommands(event, text) {
  const trimmed = text.trim()

  const muteState = await isBotMuted(event.source.userId)
  if (muteState.muted) {
    await replyText(event, "現在このアカウントの機能は無効化されています。")
    return true
  }

  if (trimmed === "/help") {
    const help = [
      "コマンド一覧",
      "",
      "全員OK",
      "/ai <内容>  -AIと会話-",
      "/mycoin  -自分のコイン数-",
      "/myrank  -自分の順位-",
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
      logError("ai_error", e, { userId: event?.source?.userId })
      if (isQuotaError(e)) {
        await replyText(event, "APIの制限に到達しました。時間をおいて再度お試しください。")
      } else {
        await replyText(event, "AIの呼び出しに失敗しました。")
      }
      return true
    }
  }

  if (trimmed === "/mycoin") {
    const userId = event.source.userId
    const coins = await getCoins(userId)
    await replyText(event, `所持コイン：${coins}`)
    return true
  }

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

async function handleAdminCommands(event, text) {
  const userId = event.source.userId
  if (!isAdmin(userId)) return false

  const trimmed = text.trim()

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

  if (trimmed === "/rank") {
    const lines = await buildRankText("messages", "発言回数ランキング")
    await replyText(event, lines)
    return true
  }

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

  if (trimmed === "/resetrank") {
    await dbRun("UPDATE users SET messages = 0")
    await replyText(event, "発言回数ランキングをリセットしました。")
    return true
  }

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

  if (trimmed === "/rank coin") {
    const lines = await buildRankText("coins", "コイン所持数ランキング")
    await replyText(event, lines)
    return true
  }

  return false
}

async function buildRankText(key, title) {
  const rows = await getRank(key, null)
  if (rows.length === 0) return `${title}\nデータがありません。`

  const names = await Promise.all(rows.map(r => getProfile(r.user_id)))
  const lines = rows.map((r, i) => `${i + 1}位 ${names[i]} ${r.value}`)
  return `${title}\n${lines.join("\n")}`
}
// ===== 起動 =====
async function initDb() {
  await dbRun(
    "CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0)"
  )
  await dbRun(
    "CREATE TABLE IF NOT EXISTS daily_usage (user_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, date, kind))"
  )
}

initDb()
  .then(() => {
    app.listen(process.env.PORT, () => {
      console.log(`Bot running on port ${process.env.PORT}`)
    })
  })
  .catch((e) => {
    logError("db_init_error", e)
    process.exit(1)
  })

process.on("unhandledRejection", (err) => {
  logError("unhandled_rejection", err)
})

process.on("uncaughtException", (err) => {
  logError("uncaught_exception", err)
  process.exit(1)
})
