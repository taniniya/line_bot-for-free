const {
  getProfile,
  getLineContent,
  compressImage,
  encodeVideo,
  sendDiscord,
  sendDiscordFile,
  isHandled,
  logError,
  askAi
} = require("./utils")

const {
  addMessage,
  getCoins,
  addCoins,
  transferCoins,
  getUserRank,
  consumeDailyQuota,
  isBotMuted,
  setBotMuted,
  isAdmin,
  canAdminOffbot,
  getMentionedUserIds,
  updateLoginStreak,
  getRank,
  getTopUsers,
  countLinkedAccounts,
  linkSiteAccount,
  delinkSiteAccount,
  registerSiteUser,
  loginSiteUser,
  getSessionFromRequest,
  getSiteUserById,
  createSiteAccount,
  lookupSiteAccount
} = require("./db")

// =========================
// LINE イベント処理
// =========================
async function handleEvent(event) {
  try {
    if (event.type === "message") {
      if (isHandled(event)) return

      switch (event.message.type) {
        case "text":
          await handleText(event)
          break
        case "image":
          await handleImage(event)
          break
        case "video":
          await handleVideo(event)
          break
      }
    }

    if (event.type === "memberJoined") {
      await sendDiscord(`JOIN\n${event.joined.members[0].userId}`)
    }

    if (event.type === "memberLeft") {
      await sendDiscord(`LEAVE\n${event.left.members[0].userId}`)
    }
  } catch (e) {
    logError("event_error", e)
  }
}

// =========================
// テキスト処理
// =========================
async function handleText(event) {
  const userId = event.source.userId
  const text = event.message.text || ""

  await addMessage(userId)

  const name = await getProfile(userId)
  await sendDiscord(`LINE\n送信者：${name}\n内容：${text}`)
}

// =========================
// 画像処理
// =========================
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

// =========================
// 動画処理
// =========================
async function handleVideo(event) {
  const name = await getProfile(event.source.userId)
  const buffer = await getLineContent(event.message.id)

  if (buffer.length <= 8 * 1024 * 1024) {
    await sendDiscordFile(buffer, "video.mp4", `VIDEO\n送信者：${name}`)
    return
  }

  const fs = require("fs")
  const os = require("os")
  const path = require("path")

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

      if (outBuf.length <= 8 * 1024 * 1024) {
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
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

// =========================
// Dashboard API
// =========================
async function handleDashboardApi(req, res) {
  try {
    const topUsers = await getTopUsers()
    const ranks = await getRank()
    const linkedCount = await countLinkedAccounts()

    res.json({
      ok: true,
      topUsers,
      ranks,
      linkedCount
    })
  } catch (e) {
    logError("dashboard_api_error", e)
    res.json({ ok: false })
  }
}

// =========================
// Site Account Create
// =========================
async function handleSiteAccountCreate(req, res) {
  try {
    const { siteUserId } = req.body
    const result = await createSiteAccount(siteUserId)
    res.json(result)
  } catch (e) {
    logError("site_account_create_error", e)
    res.json({ ok: false })
  }
}

// =========================
// Site Account Lookup
// =========================
async function handleSiteAccountLookup(req, res) {
  try {
    const code = req.params.code
    const result = await lookupSiteAccount(code)
    res.json(result)
  } catch (e) {
    logError("site_account_lookup_error", e)
    res.json({ ok: false })
  }
}

// =========================
// Register
// =========================
async function handleRegister(req, res) {
  try {
    const { username, password } = req.body
    const result = await registerSiteUser(username, password)
    res.json(result)
  } catch (e) {
    logError("register_error", e)
    res.json({ ok: false })
  }
}

// =========================
// Login
// =========================
async function handleLogin(req, res) {
  try {
    const { username, password } = req.body
    const result = await loginSiteUser(username, password)
    res.json(result)
  } catch (e) {
    logError("login_error", e)
    res.json({ ok: false })
  }
}

// =========================
// Logout
// =========================
async function handleLogout(req, res) {
  try {
    res.json({ ok: true })
  } catch (e) {
    logError("logout_error", e)
    res.json({ ok: false })
  }
}

// =========================
// Auth Me
// =========================
async function handleAuthMe(req, res) {
  try {
    const session = await getSessionFromRequest(req)
    if (!session) {
      res.json({ ok: false })
      return
    }

    const user = await getSiteUserById(session.site_user_id)
    res.json({ ok: true, user })
  } catch (e) {
    logError("auth_me_error", e)
    res.json({ ok: false })
  }
}

// =========================
// Export
// =========================
module.exports = {
  handleEvent,
  handleDashboardApi,
  handleSiteAccountCreate,
  handleSiteAccountLookup,
  handleRegister,
  handleLogin,
  handleLogout,
  handleAuthMe
}
