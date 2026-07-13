require("dotenv").config()

const express = require("express")
const line = require("@line/bot-sdk")
const path = require("path")
const fs = require("fs")

const {
  handleEvent,
  handleDashboardApi,
  handleSiteAccountCreate,
  handleSiteAccountLookup,
  handleRegister,
  handleLogin,
  handleLogout,
  handleAuthMe
} = require("./handlers")

const { initDb } = require("./db")

const STATIC_DIR = path.join(__dirname, "static")
if (!fs.existsSync(STATIC_DIR)) fs.mkdirSync(STATIC_DIR)

const app = express()

// 静的ファイル
app.use("/static", express.static(STATIC_DIR))

// ===== Webhook（最優先）=====
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
}

app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200)
  for (const event of req.body.events) {
    await handleEvent(event)
  }
})

// ===== Health Check =====
app.get("/health", (req, res) => {
  res.status(200).send("ok")
})

// ===== express.json()（Webhookの後ろ）=====
app.use(express.json())

// ===== Web Dashboard =====
app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, "dashboard.html"))
})

app.get("/panel", (_req, res) => {
  res.redirect("/")
})

app.get("/api/dashboard", handleDashboardApi)
app.post("/api/site-accounts", handleSiteAccountCreate)
app.get("/api/site-accounts/:code", handleSiteAccountLookup)
app.post("/api/auth/register", handleRegister)
app.post("/api/auth/login", handleLogin)
app.post("/api/auth/logout", handleLogout)
app.get("/api/auth/me", handleAuthMe)

// ===== サーバ起動 =====
const PORT = process.env.PORT || 3000

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bot running on port ${PORT}`)
    })
  })
  .catch((e) => {
    console.error("DB init error:", e)
    process.exit(1)
  })
