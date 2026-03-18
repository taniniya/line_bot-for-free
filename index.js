require("dotenv").config()

const express = require("express")
const line = require("@line/bot-sdk")
const axios = require("axios")
const FormData = require("form-data")
const sharp = require("sharp")
const fs = require("fs")
const path = require("path")
const sqlite3 = require("sqlite3").verbose()
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("ffmpeg-static")

ffmpeg.setFfmpegPath(ffmpegPath)

const MAX_SIZE = 8 * 1024 * 1024
const handledEvents = new Set()
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"
const IMAGEN_MODEL = process.env.IMAGEN_MODEL || "gemini-2.5-flash-image"
const DAILY_LIMIT_TEXT = Number(process.env.DAILY_LIMIT_TEXT || "20")
const DAILY_LIMIT_IMAGE = Number(process.env.DAILY_LIMIT_IMAGE || "5")

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

// ===== LINE =====
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
}
const lineClient = new line.Client(lineConfig)

// ===== SQLite =====
const db = new sqlite3.Database(path.join(__dirname, "data.db"))
db.serialize(() => {
  db.run(
    "CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0)"
  )
  db.run(
    "CREATE TABLE IF NOT EXISTS daily_usage (user_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, date, kind))"
  )
})

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
        console.error("event error:", e)
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
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err)
      resolve(this)
    })
  })
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err)
      resolve(rows)
    })
  })
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err)
      resolve(row)
    })
  })
}

async function ensureUser(userId) {
  await dbRun(
    "INSERT OR IGNORE INTO users (user_id, coins, messages) VALUES (?, 0, 0)",
    [userId]
  )
}

async function addMessage(userId) {
  await ensureUser(userId)
  await dbRun("UPDATE users SET messages = messages + 1 WHERE user_id = ?", [userId])
}

async function addCoins(userId, amount) {
  await ensureUser(userId)
  await dbRun("UPDATE users SET coins = coins + ? WHERE user_id = ?", [amount, userId])
}

async function getCoins(userId) {
  await ensureUser(userId)
  const row = await dbGet("SELECT coins FROM users WHERE user_id = ?", [userId])
  return row ? Number(row.coins || 0) : 0
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
  await dbRun(
    "INSERT OR IGNORE INTO daily_usage (user_id, date, kind, count) VALUES (?, ?, ?, 0)",
    [userId, date, kind]
  )
  const row = await dbGet(
    "SELECT count FROM daily_usage WHERE user_id = ? AND date = ? AND kind = ?",
    [userId, date, kind]
  )
  const count = row ? Number(row.count || 0) : 0
  if (count >= limit) {
    return { ok: false, remaining: 0, limit, count }
  }
  await dbRun(
    "UPDATE daily_usage SET count = count + 1 WHERE user_id = ? AND date = ? AND kind = ?",
    [userId, date, kind]
  )
  return { ok: true, remaining: limit - (count + 1), limit, count: count + 1 }
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

  await dbRun("BEGIN IMMEDIATE")
  try {
    const row = await dbGet("SELECT coins FROM users WHERE user_id = ?", [fromId])
    const balance = row ? Number(row.coins || 0) : 0
    if (balance < amount) {
      await dbRun("ROLLBACK")
      return { ok: false, balance }
    }

    await dbRun("UPDATE users SET coins = coins - ? WHERE user_id = ?", [amount, fromId])
    await dbRun("UPDATE users SET coins = coins + ? WHERE user_id = ?", [amount, toId])
    await dbRun("COMMIT")
    return { ok: true, balance: balance - amount }
  } catch (e) {
    await dbRun("ROLLBACK")
    throw e
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
    `SELECT user_id, ${col} AS value FROM users ORDER BY ${col} DESC LIMIT ?`,
    [limit]
  )
}

// ===== Admin Commands =====
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId)
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

async function askAi(prompt) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return { ok: false, error: "GEMINI_API_KEY が未設定です。" }
  }

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ]
    },
    {
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  )

  const data = res.data || {}
  const candidates = Array.isArray(data.candidates) ? data.candidates : []
  const parts = candidates[0]?.content?.parts || []
  const text = parts.map(p => p.text).filter(Boolean).join("\n").trim()
  if (!text) return { ok: false, error: "AIの応答を取得できませんでした。" }
  return { ok: true, text }
}

async function generateImage(prompt) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return { ok: false, error: "GEMINI_API_KEY が未設定です。" }
  }

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:generateContent`,
    {
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ]
    },
    {
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  )

  const data = res.data || {}
  const parts = data.candidates?.[0]?.content?.parts || []
  const inline =
    parts.find(p => p.inlineData && p.inlineData.data) ||
    parts.find(p => p.inline_data && p.inline_data.data)

  const b64 =
    inline?.inlineData?.data ||
    inline?.inline_data?.data ||
    ""

  if (!b64) {
    return { ok: false, error: "画像の生成に失敗しました。" }
  }

  const buffer = Buffer.from(b64, "base64")
  return { ok: true, buffer }
}

// ===== User Commands =====
async function handleUserCommands(event, text) {
  const trimmed = text.trim()

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
      console.error("ai error:", e)
      if (e?.response) {
        console.error("ai error status:", e.response.status)
        console.error("ai error data:", JSON.stringify(e.response.data))
      }
      if (isQuotaError(e)) {
        await replyText(event, "APIの制限に到達しました。時間をおいて再度お試しください。")
      } else {
        await replyText(event, "AIの呼び出しに失敗しました。")
      }
      return true
    }
  }

  const imgMatch = trimmed.match(/^\/img\s+([\s\S]+)/i)
  if (imgMatch) {
    const prompt = imgMatch[1].trim()
    if (!prompt) {
      await replyText(event, "画像の内容を入れてください。例：/img 赤いスニーカー")
      return true
    }

    try {
      const quota = await consumeDailyQuota(event.source.userId, "image", DAILY_LIMIT_IMAGE)
      if (!quota.ok) {
        await replyText(event, `本日の画像生成上限に達しました。（上限：${quota.limit}）`)
        return true
      }
      const result = await generateImage(prompt)
      if (!result.ok) {
        await replyText(event, result.error)
        return true
      }
      await sendDiscord(`IMG\nPrompt: ${prompt}`)
      await sendDiscordFile(result.buffer, "imagen.png", `IMAGE\nPrompt: ${prompt}`)
      await replyText(event, "画像を生成しました。")
      return true
    } catch (e) {
      console.error("img error:", e)
      if (e?.response) {
        console.error("img error status:", e.response.status)
        console.error("img error data:", JSON.stringify(e.response.data))
      }
      if (isQuotaError(e)) {
        await replyText(event, "APIの制限に到達しました。時間をおいて再度お試しください。")
      } else {
        await replyText(event, "画像生成に失敗しました。")
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
app.listen(process.env.PORT, () => {
  console.log(`Bot running on port ${process.env.PORT}`)
})
