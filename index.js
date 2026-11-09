require('dotenv').config()
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const QRCode = require('qrcode')
const http = require('http')
const { handleMessage } = require('./bot')

// HTTP server serves the latest QR code at / and a health check at /health
let currentQrHtml = '<html><body style="font-family:sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>⏳ Waiting for QR code — refresh in a few seconds...</p></body></html>'
let isConnected = false

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(isConnected ? 'connected' : 'waiting-for-qr')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(isConnected
    ? '<html><body style="font-family:sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>✅ WhatsApp bot is connected and running!</h2></body></html>'
    : currentQrHtml)
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`🌐 QR server running on port ${PORT}`))

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./sessions')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Spaza Kulture Bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 New QR code generated — visit the service URL to scan')
      QRCode.toDataURL(qr, { width: 400 }, (err, url) => {
        if (err) { console.error('QR error:', err); return }
        currentQrHtml = `<!DOCTYPE html><html><head><title>SK WhatsApp Bot QR</title>
<meta http-equiv="refresh" content="30">
<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff}
h2{margin-bottom:8px}p{color:#aaa;margin-bottom:24px}img{border:4px solid #fff;border-radius:8px}</style></head>
<body><h2>📱 Spaza Kulture WhatsApp Bot</h2>
<p>Open WhatsApp → three dots → Linked Devices → Link a Device → scan this code</p>
<img src="${url}" /><p style="margin-top:16px;font-size:12px;color:#666">Page auto-refreshes every 30s. Refresh manually if QR expired.</p></body></html>`
      })
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : 0
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log(`Connection closed (code ${code}). Reconnect: ${shouldReconnect}`)
      if (shouldReconnect) startBot()
    } else if (connection === 'open') {
      isConnected = true
      console.log('✅ Spaza Kulture WhatsApp bot connected!')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue
      // Skip group messages — only handle direct chats
      if (msg.key.remoteJid.endsWith('@g.us')) continue
      try {
        await handleMessage(sock, msg)
      } catch (err) {
        console.error('Error handling message:', err.message)
      }
    }
  })
}

startBot().catch(console.error)
