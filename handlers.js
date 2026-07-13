const {
  getProfile,
  getLineContent,
  compressImage,
  encodeVideo,
  sendDiscord,
  sendDiscordFile,
  isHandled,
  logError
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
  getSiteUserById
} = require("./db")

const { askAi } = require("./utils")

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

async function handleText(event) {
  const userId = event.source.userId
  const text = event.message.text || ""

  await addMessage(userId)

  const userHandled = await handleUserCommands(event, text)
  if (userHandled) return

  const adminHandled = await handleAdminCommands(event, text)
  if (adminHandled) return

  const name = await getProfile(userId)

  await sendDiscord(`LINE\n送信者：${name}\n内容：${text}`)
}

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

async function handleVideo(event) {
  const name = await getProfile(event.source.userId)
  const buffer = await getLineContent(event.message.id)

  if (buffer.length <= 8 * 1024 * 1024) {
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
    cleanup(workDir)
  }
}



module.exports = {
  handleEvent,
  handleSiteAccountCreate,
  handleSiteAccountLookup,
  handleRegister,
  handleLogin,
  handleLogout,
  handleAuthMe
}
