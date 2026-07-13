const axios = require("axios")
const sharp = require("sharp")
const fs = require("fs")
const path = require("path")
const os = require("os")
const FormData = require("form-data")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("ffmpeg-static")
const { Client } = require("@line/bot-sdk")

ffmpeg.setFfmpegPath(ffmpegPath)

const MAX_SIZE = 8 * 1024 * 1024
const handledEvents = new Set()

const OPENROUTER_TEXT_MODEL = process.env.OPENROUTER_TEXT_MODEL || "openrouter/free"
const OPENROUTER_HTTP_REFERER = process.env.OPENROUTER_HTTP_REFERER || ""
const OPENROUTER_X_TITLE = process.env.OPENROUTER_X_TITLE || ""

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
})

// 再送防止
function isHandled(event) {
  const id = event.message?.id
  if (!id) return false
  if (handledEvents.has(id)) return true
  handledEvents.add(id)
  setTimeout(() => handledEvents.delete(id), 5 * 60 * 1000)
  return false
}

// プロフィール
async function getProfile(userId) {
  try {
    const p = await lineClient.getProfile(userId)
    return p.displayName
  } catch {
    return userId
  }
}

async function getProfileFull(userId) {
  try {
    const p = await lineClient.getProfile(userId)
    return { name: p.displayName, icon: p.pictureUrl || null }
  } catch {
    return { name: userId, icon: null }
  }
}

// LINEコンテンツ
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

// 画像圧縮
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

// 動画エンコード
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

// Discord
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

// メンション取得
function getMentionedUserIds(event) {
  const mention = event.message?.mention
  if (!mention || !Array.isArray(mention.mentionees)) return []
  return mention.mentionees.map(m => m.userId).filter(Boolean)
}

// 日付（JST）
function getTodayJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date())
}

// AI（OpenRouter）
async function askAi(prompt) {
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: OPENROUTER_TEXT_MODEL,
        messages: [{ role: "user", content: prompt }]
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

// ログ
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

module.exports = {
  isHandled,
  getProfile,
  getProfileFull,
  getLineContent,
  compressImage,
  encodeVideo,
  cleanup,
  sendDiscord,
  sendDiscordFile,
  getMentionedUserIds,
  getTodayJst,
  askAi,
  isQuotaError,
  logError
}
