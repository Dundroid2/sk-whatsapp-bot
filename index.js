require('dotenv').config()
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const QRCode = require('qrcode')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const { handleMessage } = require('./bot')

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
      console.log('\n📱 Generating QR code — opening in browser...')
      QRCode.toDataURL(qr, { width: 400 }, (err, url) => {
        if (err) { console.error('QR error:', err); return }
        const html = `<!DOCTYPE html><html><head><title>SK WhatsApp Bot QR</title>
<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff}
h2{margin-bottom:8px}p{color:#aaa;margin-bottom:24px}img{border:4px solid #fff;border-radius:8px}</style></head>
<body><h2>📱 Spaza Kulture WhatsApp Bot</h2>
<p>Open WhatsApp → three dots → Linked Devices → Link a Device → scan this code</p>
<img src="${url}" /><p style="margin-top:16px;font-size:12px;color:#666">QR expires in ~60 seconds — refresh page if expired</p></body></html>`
        const qrFile = path.join(__dirname, 'qr.html')
        fs.writeFileSync(qrFile, html)
        exec(`start "" "${qrFile}"`)
        console.log(`   Opened: ${qrFile}`)
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
