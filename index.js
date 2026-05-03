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
// ===== Webhook =====
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

// ===== ランキングテキスト生成（名前対応版） =====
async function buildRankText(key, title) {
  const rows = await getRank(key)
  let text = `🏆 ${title}\n\n`

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const name = await getProfile(row.user_id)   // ← ここで名前取得！

    text += `${i + 1}位: ${name} - ${row.value} ${key === "coins" ? "コイン" : "回"}\n`
  }

  return text
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
      "/login  -ログインボーナス-",
      "/tenki  -天気-",
      "/omikuzi  -おみくじ-",
      "/rob @ユーザー  -そのユーザーのコインを盗む-",
      "/rank coints  -コインランキング-",
      "/coints <表/裏> <金額 or all>  -コイントスギャンブル-",
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

  // ===== /rank coints =====
  if (trimmed === "/rank coints" || trimmed === "/rank gamble") {
    const rows = await getRank("coins")
    let text = "🏆 ギャンブルで儲けたコインランキング\n\n"
  
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const name = await getProfile(row.user_id)
      text += `${i + 1}位: ${name} - ${row.value} コイン\n`
    }

    await replyText(event, text)
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
  `成功！
  ${stealAmount} コインを奪い取った！`)
    } else {
      const myCoins = await getCoins(fromId)
      const penalty = Math.min(amount, myCoins)
  
      await addCoins(fromId, -penalty)
  
      await replyText(event,
 `失敗！
  罰金として ${penalty} が課された…`)
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
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`)
})
