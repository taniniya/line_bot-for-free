const axios = require("axios")
const sharp = require("sharp")
const fs = require("fs")
const path = require("path")
const FormData = require("form-data")

// =====================================
// handledEvents（重複イベント防止）
// =====================================
const handledEvents = new Set()

function isHandled(event) {
  const key = `${event.source.userId}:${event.timestamp}`
  if (handledEvents.has(key)) return true
  handledEvents.add(key)
  return false
}

// =====================================
// LINE プロフィール取得
// =====================================
async function getProfile(userId) {
  try {
    const res = await axios.get(
      `https://api.line.me/v2/bot/profile/${userId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
        }
      }
    )
    return res.data.displayName || "Unknown"
  } catch (e) {
    return "Unknown"
  }
}

// =====================================
// LINE コンテンツ取得（画像・動画）
// =====================================
async function getLineContent(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
    }
  })
  return Buffer.from(res.data)
}

// =====================================
// 画像圧縮
// =====================================
async function compressImage(buffer) {
  try {
    let current = buffer
    for (let i = 0; i < 5; i++) {
      const out = await sharp(current).jpeg({ quality: 70 }).toBuffer()
      if (out.length <= 8 * 1024 * 1024) {
        return { ok: true, buffer: out, step: i + 1 }
      }
      current = out
    }
    return { ok: false }
  } catch (e) {
    logError("image_compress_error", e)
    return { ok: false }
  }
}

// =====================================
// 動画エンコード
// =====================================
async function encodeVideo(inputPath, outputPath, opts) {
  const ffmpeg = require("fluent-ffmpeg")
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .size(opts.size)
      .videoBitrate(opts.bitrate)
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run()
  })
}

// =====================================
// Discord 送信（テキスト）
// =====================================
async function sendDiscord(text) {
  try {
    await axios.post(process.env.DISCORD_WEBHOOK_URL, { content: text })
  } catch (e) {
    logError("discord_text_error", e)
  }
}

// =====================================
// Discord 送信（ファイル）
// =====================================
async function sendDiscordFile(buffer, filename, message) {
  try {
    const form = new FormData()
    form.append("file", buffer, filename)
    form.append("content", message)

    await axios.post(process.env.DISCORD_WEBHOOK_URL, form, {
      headers: form.getHeaders()
    })
  } catch (e) {
    logError("discord_file_error", e)
  }
}

// =====================================
// AI 返信（必要なら使う）
// =====================================
async function askAi(prompt) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    )
    return res.data.choices[0].message.content
  } catch (e) {
    logError("ai_error", e)
    return "AIエラー"
  }
}

// =====================================
// エラー記録
// =====================================
function logError(label, error) {
  console.error(JSON.stringify({
    label,
    message: error.message,
    stack: error.stack
  }))
}

// =====================================
// EXPORT
// =====================================
module.exports = {
  isHandled,
  getProfile,
  getLineContent,
  compressImage,
  encodeVideo,
  sendDiscord,
  sendDiscordFile,
  askAi,
  logError
}
