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
const OPENROUTER_TEXT_MODEL =
  process.env.OPENROUTER_TEXT_MODEL || "openrouter/free"
const OPENROUTER_HTTP_REFERER = process.env.OPENROUTER_HTTP_REFERER || ""
const OPENROUTER_X_TITLE = process.env.OPENROUTER_X_TITLE || ""
const DAILY_LIMIT_TEXT = Number(process.env.DAILY_LIMIT_TEXT || "20")
const DAILY_LIMIT_IMAGE = Number(process.env.DAILY_LIMIT_IMAGE || "5")
const DATABASE_URL = process.env.DATABASE_URL || ""
const PGSSL =
  process.env.PGSSL === "true" || /sslmode=require/i.test(DATABASE_URL)

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

// ★ 追加：ログインボーナスメッセージ
const LOGIN_MESSAGES = [
  "お手伝いをして{coin}タニコインをもらった！",
  "漁に出て{coin}タニコインを稼いだ！",
  "ヤクザ事務所の掃除をして{coin}タニコインを手に入れた！",
  "闇バイトをして{coin}タニコインを受け取った！",
  "メルカリで転売してで{coin}タニコインを設けた！",
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

// ===== プロフィール（アイコンURL付き） =====
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


// 静的ファイル用ディレクトリ
const STATIC_DIR = path.join(__dirname, "static")
if (!fs.existsSync(STATIC_DIR)) {
  fs.mkdirSync(STATIC_DIR)
}


// ===== Express =====
const app = express()

const app = express()

// /static/xxx.png で画像を配信
app.use("/static", express.static(STATIC_DIR))


app.post("/webhook", line.middleware(lineConfig), (req, res) => {
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
async function sendDiscordFile(buffer, filename, content) {
  const form = new FormData()
  form.append("payload_json", JSON.stringify({ content }))
  form.append("file", buffer, { filename })

  const res = await axios.post(process.env.DISCORD_WEBHOOK_URL, form, {
    headers: form.getHeaders()
  })

  // Discord が返す画像URLを取得
  const attachment = res.data?.attachments?.[0]
  return attachment?.url || null
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
// ===== streak（連続ログイン） =====

// ★ 追加：連続ログイン情報を取得
async function getLoginStreak(userId) {
  const row = await dbGet(
    "SELECT last_date, streak FROM login_streak WHERE user_id = $1",
    [userId]
  )
  return row || null
}

// ★ 追加：連続ログイン更新
async function updateLoginStreak(userId) {
  const today = getTodayJst()
  const row = await getLoginStreak(userId)

  // 初回ログイン
  if (!row) {
    await dbRun(
      "INSERT INTO login_streak (user_id, last_date, streak) VALUES ($1, $2, 1)",
      [userId, today]
    )
    return 1
  }

  // 同じ日 → streak 変わらない
  if (row.last_date === today) {
    return row.streak
  }

  // 昨日の日付を計算
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






// ===== User Commands =====
async function handleUserCommands(event, text) {
  const trimmed = text.trim()

  // ===== /tenki =====
  if (trimmed === "/tenki") {
    try {
      const url = "https://www.jma.go.jp/bosai/forecast/data/forecast/120000.json"
      const res = await axios.get(url)
      const area = res.data[0].timeSeries[0]
  
      
      const idx = area.areas.findIndex(a => a.area.code === "130010")
      if (idx === -1) {
        await replyText(event, "天気情報を取得できませんでした。")
        return true
      }

      const weather = area.areas[idx].weathers[0]
      const pops = area.areas[idx].pops[0]   // 降水確率
      const temps = res.data[0].timeSeries[2].areas[idx].temps[0] // 気温
  
      const msg =
  `🌤 天気
  天気：${weather}
  気温：${temps}℃
  降水確率：${pops}%`

      await replyText(event, msg)
      return true
    } catch (e) {
      await replyText(event, "天気情報の取得に失敗しました。")
      return true
    }
  }



  // ===== /omikuzi =====
  if (trimmed === "/omikuzi" || trimmed === "/omikuji" || trimmed === "/おみくじ") {
    const results = [
      "大吉",
      "中吉",
      "小吉",
      "吉",
      "末吉",
      "凶",
      "大凶"
    ]

    const result = results[Math.floor(Math.random() * results.length)]

    const msg =
  `おみくじ結果
   今日の運勢は…【${result}】`

    await replyText(event, msg)
    return true
  }


  // ===== /quote =====
  if (trimmed.startsWith("/image")) {
    try {
      const userId = event.source.userId

      // /quote の後ろのテキストを取り出す
      const m = trimmed.match(/^\/quote\s+([\s\S]+)/i)
      if (!m) {
        await replyText(event, "使い方：/image 画像にしたいテキスト")
        return true
      }
      const text = m[1].trim()
      if (!text) {
        await replyText(event, "画像にしたいテキストを入れてください。")
        return true
      }

      // プロフィール取得（名前＋アイコンURL）
      const profile = await getProfileFull(userId)
  
      // アイコン画像を取得（なければ空）
      let iconBase64 = ""
      if (profile.icon) {
        const iconRes = await axios.get(profile.icon, { responseType: "arraybuffer" })
        iconBase64 = Buffer.from(iconRes.data).toString("base64")
      }
  
      // SVG 生成（黒背景）
      const svg = `
        <svg width="900" height="450" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <clipPath id="avatarClip">
              <circle cx="100" cy="100" r="60" />
            </clipPath>
          </defs>
  
          <rect width="100%" height="100%" fill="#000000"/>
  
          <rect x="40" y="40" width="820" height="370" rx="24" ry="24" fill="#1a1a1a" />
  
          <g clip-path="url(#avatarClip)">
            <image href="data:image/png;base64,${iconBase64}" x="60" y="60" width="120" height="120" />
          </g>
  
          <text x="200" y="120" font-size="36" fill="#ffffff" font-weight="bold">
            ${profile.name}
          </text>
  
          <text x="80" y="220" font-size="30" fill="#e6e6e6">
            ${text}
          </text>
        </svg>
      `

      const buffer = await sharp(Buffer.from(svg)).png().toBuffer()

      // Discord に画像を送って URL を取得
      const imageUrl = await sendDiscordFile(buffer, "quote.png", "QUOTE IMAGE")
  
      if (!imageUrl) {
        await replyText(event, "画像URLの取得に失敗しました。")
        return true
      }
  
      // LINE に画像を返す
      await lineClient.replyMessage(event.replyToken, {
        type: "image",
        originalContentUrl: imageUrl,
        previewImageUrl: imageUrl
      })
  
      return true
    } catch (e) {
      logError("quote_error", e)
      await replyText(event, "画像生成に失敗しました。")
      return true
    }
  }

  




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
      "/login  -ログインボーナス-",
      "/tenki  -天気-",
      "/omikuzi  -おみくじ-",
      "/image <テキスト>  -テキストカードを作成-",
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



 



  // ===== /login（ログインボーナス） =====
  if (trimmed === "/login") {
    try {
      const userId = event.source.userId

      // 1日1回制限
      const quota = await consumeDailyQuota(userId, "login", 1)
      if (!quota.ok) {
        await replyText(event, "今日はすでにログインボーナスを受け取っています。")
        return true
      }

      // 1%で500コイン
      let coin
      let rare = false
      if (Math.random() < 0.01) {
        coin = 500
        rare = true
      } else {
        coin = Math.floor(Math.random() * 251) + 50 // 50〜300
      }

      // streak 更新
      const streak = await updateLoginStreak(userId)
      const streakBonus = Math.min(streak, 7) * 10 // 最大 +70

      // streak メッセージ
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

      // ランダムメッセージ
      const msgTemplate = LOGIN_MESSAGES[Math.floor(Math.random() * LOGIN_MESSAGES.length)]
      const baseMsg = msgTemplate.replace("{coin}", coin)

      // LINE返信メッセージ
      let reply = `!ログインボーナス！\n${baseMsg}\n`
      reply += `${streakMsg}\n`
      reply += `連続ログイン：${streak}日目 (+${streakBonus})\n`
      reply += `合計：${total} タニコイン`

      // レア演出
      if (rare) {
        reply = `🌟🌟 超レア!500コイン獲得! 🌟🌟\n` + reply
      }

      // LINEへ返信
      await replyText(event, reply)

      // Discordにも送信
      await sendDiscord(`LOGIN BONUS\nUser: ${userId}\n${reply}`)

      return true
    } catch (e) {
      logError("login_bonus_error", e, { userId: event?.source?.userId })
      await replyText(event, "ログインボーナスの取得に失敗しました。")
      return true
    }
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
      logError("ai_error", e, { userId: event?.source?.userId })
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

  // ===== /rank coin =====
  if (trimmed === "/rank coin") {
    const lines = await buildRankText("coins", "コイン所持数ランキング")
    await replyText(event, lines)
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
    return { ok: true, limit }
  }

  if (row.count >= limit) {
    return { ok: false, limit }
  }

  await dbRun(
    "UPDATE daily_usage SET count = count + 1 WHERE user_id = $1 AND date = $2 AND kind = $3",
    [userId, today, kind]
  )

  return { ok: true, limit }
}

function isQuotaError(e) {
  return e?.response?.status === 429
}


// ===== Bot ミュート =====
async function isBotMuted(userId) {
  const row = await dbGet(
    "SELECT muted, mode FROM bot_mute WHERE user_id = $1",
    [userId]
  )
  if (!row) return { muted: false, mode: "normal" }
  return row
}

async function setBotMuted(userId, muted, mode = "normal") {
  const row = await dbGet("SELECT user_id FROM bot_mute WHERE user_id = $1", [
    userId
  ])

  if (!row) {
    await dbRun(
      "INSERT INTO bot_mute (user_id, muted, mode) VALUES ($1, $2, $3)",
      [userId, muted, mode]
    )
  } else {
    await dbRun(
      "UPDATE bot_mute SET muted = $1, mode = $2 WHERE user_id = $3",
      [muted, mode, userId]
    )
  }
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId)
}

function canAdminOffbot(userId) {
  return ADMIN_OFFBOT_IDS.includes(userId)
}


// ===== メンション取得 =====
function getMentionedUserIds(event) {
  const mention = event.message?.emojis || event.message?.mention
  if (!mention || !mention.mentionees) return []
  return mention.mentionees.map(m => m.userId)
}


// ===== AI =====
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
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": OPENROUTER_HTTP_REFERER,
        "X-Title": OPENROUTER_X_TITLE
      },
      timeout: 30000
    }
  )

  const data = res.data || {}
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) return { ok: false, error: "AIの応答を取得できませんでした。" }
  return { ok: true, text }
}
// ===== DB 初期化 =====
async function initDb() {
  await dbRun(
    "CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0)"
  )

  await dbRun(
    "CREATE TABLE IF NOT EXISTS daily_usage (user_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, date, kind))"
  )

  // ★ 追加：連続ログインテーブル
  await dbRun(
    "CREATE TABLE IF NOT EXISTS login_streak (user_id TEXT PRIMARY KEY, last_date TEXT NOT NULL, streak INTEGER NOT NULL DEFAULT 1)"
  )

  // ★ 追加：Botミュートテーブル
  await dbRun(
    "CREATE TABLE IF NOT EXISTS bot_mute (user_id TEXT PRIMARY KEY, muted BOOLEAN NOT NULL DEFAULT false, mode TEXT NOT NULL DEFAULT 'normal')"
  )
}


// ===== 起動 =====
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


// ===== エラーハンドリング =====
process.on("unhandledRejection", (err) => {
  logError("unhandled_rejection", err)
})

process.on("uncaughtException", (err) => {
  logError("uncaught_exception", err)
  process.exit(1)
})
