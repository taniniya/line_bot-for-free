require("dotenv").config()

const express = require("express")
const { Client, middleware } = require("@line/bot-sdk")
const cors = require("cors")
const bodyParser = require("body-parser")

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

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
}

const client = new Client(lineConfig)

const app = express()
app.use(cors())
app.use(bodyParser.json())

// 静的ファイル（ダッシュボード）
const path = require("path")
const fs = require("fs")
const STATIC_DIR = path.join(__dirname, "static")
if (!fs.existsSync(STATIC_DIR)) {
  fs.mkdirSync(STATIC_DIR)
}
app.use("/static", express.static(STATIC_DIR))
app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, "dashboard.html"))
})
app.get("/panel", (_req, res) => {
  res.redirect("/")
})

// Dashboard API
app.get("/api/dashboard", handleDashboardApi)

// Site Account API
app.post("/api/site-accounts", handleSiteAccountCreate)
app.get("/api/site-accounts/:code", handleSiteAccountLookup)

// Auth API
app.post("/api/auth/register", handleRegister)
app.post("/api/auth/login", handleLogin)
app.post("/api/auth/logout", handleLogout)
app.get("/api/auth/me", handleAuthMe)

// Health
app.get("/health", (_req, res) => {
  res.status(200).send("ok")
})

// Webhook
app.post(
  "/webhook",
  (req, res, next) => {
    const signature = req.headers["x-line-signature"]
    if (!signature) return res.status(200).send("ok")
    next()
  },
  middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200)
    const events = req.body.events || []
    for (const event of events) {
      try {
        await handleEvent(event)
      } catch (e) {
        console.error("event_error", e)
      }
    }
  }
)

const PORT = process.env.PORT || 3000
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bot running on port ${PORT}`)
    })
  })
  .catch((e) => {
    console.error("db_init_error", e)
    process.exit(1)
  })

module.exports = { client }
