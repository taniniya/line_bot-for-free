const axios = require("axios")
const FormData = require("form-data")
const sharp = require("sharp")
const fs = require("fs")
const path = require("path")
const os = require("os")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("ffmpeg-static")

ffmpeg.setFfmpegPath(ffmpegPath)

function logError(label, err, meta = {}) {
  console.error(JSON.stringify({
    label,
    message: err?.message,
    stack: err?.stack,
    status: err?.response?.status,
    data: err?.response?.data,
    ...meta
  }))
}

function isHandled(event) {
  const id = event.message?.id
  if (!id) return false
  if (handledEvents.has(id)) return true
  handledEvents.add(id)
  setTimeout(() => handledEvents.delete(id), 5 * 60 * 1000)
  return false
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

async function compressImage(buffer) {
  if (buffer.length <= 8 * 1024 * 1024) return { ok: true, buffer, step: 0 }

  let out = await sharp(buffer).jpeg({ quality: 75 }).toBuffer()
  if (out.length <= 8 * 1024 * 1024) return { ok: true, buffer: out, step: 1 }

  out = await sharp(out)
    .resize({ width: 1280, withoutEnlargement: true })
    .jpeg({ quality: 50 })
    .toBuffer()

  if (out.length <= 8 * 1024 * 1024) return { ok: true, buffer: out, step: 2 }

  return { ok: false }
}

async function encodeVideo(input, output, opt) {
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

async function sendDiscordFile(buffer, filename, content) {
  const form = new FormData()
  form.append("payload_json", JSON.stringify({ content }))
  form.append("file", buffer, { filename })

  const res = await axios.post(process.env.DISCORD_WEBHOOK_URL, form, {
    headers: form.getHeaders()
  })

  return res.data?.attachments?.[0]?.url || null
}

async function askAi(prompt) {
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: process.env.OPENROUTER_TEXT_MODEL,
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER,
          "X-Title": process.env.OPENROUTER_X_TITLE,
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
    return { ok: false, error: "AI呼び出し中にエラーが発生しました。" }
  }
}

module.exports = {
  logError,
  isHandled,
  getLineContent,
  compressImage,
  encodeVideo,
  sendDiscord,
  sendDiscordFile,
  askAi
}
