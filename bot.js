const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// In-memory conversation state keyed by WhatsApp JID
const conversations = new Map()

function getState(jid) {
  return conversations.get(jid) || { step: 'idle', data: {} }
}

function setState(jid, state) {
  conversations.set(jid, state)
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.buttonsResponseMessage?.selectedDisplayText ||
    msg.message?.listResponseMessage?.title ||
    ''
  ).trim()
}

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid
  const text = extractText(msg)
  if (!text) return

  const state = getState(jid)
  const result = await processMessage(state, text)

  setState(jid, result.newState)

  const replies = Array.isArray(result.reply) ? result.reply : [result.reply]
  for (const r of replies) {
    await sock.sendMessage(jid, { text: r })
    if (replies.length > 1) await delay(600)
  }
}

async function processMessage(state, text) {
  const lower = text.toLowerCase().trim()

  switch (state.step) {

    // ─── IDLE — detect intent ───────────────────────────────────────────────
    case 'idle': {
      if (/register|rsvp|attend|summit|event|join|book/i.test(lower)) {
        return {
          reply: [
            `👋 Welcome to *Spaza Kulture!*`,
            `🎉 *Spaza Kulture Summit & Expo*\n📅 08 December 2026\n📍 City of Tshwane\n⏰ 08:00–17:00\n\nLet's get you registered — it only takes 2 minutes.\n\nWhat is your *first name*?`
          ],
          newState: { step: 'rsvp_firstname', data: {} }
        }
      }
      return aiResponse(state, text)
    }

    // ─── RSVP FLOW ──────────────────────────────────────────────────────────
    case 'rsvp_firstname': {
      const name = cleanName(text)
      if (!name) return { reply: `Please tell me your first name:`, newState: state }
      return {
        reply: `Nice to meet you, *${name}*! What is your *last name*?`,
        newState: { ...state, step: 'rsvp_lastname', data: { ...state.data, firstName: name } }
      }
    }

    case 'rsvp_lastname': {
      const name = cleanName(text)
      if (!name) return { reply: `Your last name please:`, newState: state }
      return {
        reply: `Thanks! What is your *email address*?`,
        newState: { ...state, step: 'rsvp_email', data: { ...state.data, lastName: name } }
      }
    }

    case 'rsvp_email': {
      const email = text.toLowerCase().replace(/\s/g, '')
      if (!email.includes('@') || !email.includes('.')) {
        return { reply: `That doesn't look right. Please send a valid email address:`, newState: state }
      }
      return {
        reply: `Got it. What is your *business name*?`,
        newState: { ...state, step: 'rsvp_business', data: { ...state.data, email } }
      }
    }

    case 'rsvp_business': {
      return {
        reply: `What *sector* are you in?\n\n1️⃣ Spaza Shop / Township Entrepreneur\n2️⃣ Banking / Financial Services / FinTech\n3️⃣ Wholesale / Retail / Supply Chain\n4️⃣ Government / Municipality / Dev Finance\n5️⃣ NGO / Media / Advisory\n6️⃣ Other\n\n_Reply with a number or type your sector._`,
        newState: { ...state, step: 'rsvp_sector', data: { ...state.data, businessName: text.trim() } }
      }
    }

    case 'rsvp_sector': {
      const sectorMap = {
        '1': 'Spaza Shop / Township Entrepreneur',
        '2': 'Banking / Financial Services',
        '3': 'Wholesale / Retail / Supply Chain',
        '4': 'Government / Municipality',
        '5': 'NGO / Media / Advisory',
        '6': 'Other'
      }
      const sector = sectorMap[text.trim()] || text.trim()
      return {
        reply: `Which *organisation or department* are you from?\n_(e.g. City of Tshwane — EHP Dept, FNB Township Banking, SEDFA)_\n\nOr reply *skip* to continue.`,
        newState: { ...state, step: 'rsvp_organisation', data: { ...state.data, industry: sector } }
      }
    }

    case 'rsvp_organisation': {
      const org = /^skip$/i.test(lower) ? null : text.trim()
      return {
        reply: `Do you have a *business bank account*?\n\nReply *Yes* or *No*`,
        newState: { ...state, step: 'rsvp_bank', data: { ...state.data, organisation: org } }
      }
    }

    case 'rsvp_bank': {
      const val = /yes|y|yep|ja/i.test(lower) ? 'yes' : 'no'
      return {
        reply: `Do you currently *accept card payments*?\n\nReply *Yes* or *No*`,
        newState: { ...state, step: 'rsvp_card', data: { ...state.data, bankAccount: val } }
      }
    }

    case 'rsvp_card': {
      const val = /yes|y|yep|ja/i.test(lower) ? 'yes' : 'no'
      const d = { ...state.data, cardPayments: val }
      const orgLine = d.organisation ? `\n🏢 ${d.organisation}` : ''
      return {
        reply: `📋 *Please confirm your details:*\n\n👤 ${d.firstName} ${d.lastName}\n📧 ${d.email}\n🏪 ${d.businessName}\n🏷️ ${d.industry}${orgLine}\n🏦 Bank account: ${d.bankAccount}\n💳 Card payments: ${d.cardPayments}\n\nReply *Confirm* ✅ to register or *Edit* to start over.`,
        newState: { ...state, step: 'rsvp_confirm', data: d }
      }
    }

    case 'rsvp_confirm': {
      if (/confirm|yes|correct|ok|✅/i.test(lower)) {
        return saveRsvp(state.data)
      }
      if (/edit|no|start|again/i.test(lower)) {
        return {
          reply: `No problem! Let's start over. What is your *first name*?`,
          newState: { step: 'rsvp_firstname', data: {} }
        }
      }
      return {
        reply: `Please reply *Confirm* to register or *Edit* to start over.`,
        newState: state
      }
    }

    default:
      return aiResponse(state, text)
  }
}

async function saveRsvp(data) {
  const ref = `RSVP-WA-${new Date().getFullYear()}-${Math.floor(Math.random() * 90000 + 10000)}`

  const { error } = await supabase.from('event_rsvps').insert({
    event_name: 'Spaza Kulture Summit - Tshwane - 08 Dec 2026',
    ref_number: ref,
    first_name: data.firstName,
    last_name: data.lastName,
    email: data.email,
    phone: null,
    business_name: data.businessName,
    industry: data.industry,
    bank_account: data.bankAccount || null,
    card_payments: data.cardPayments || null,
    topics: data.organisation ? `WhatsApp Registration — ${data.organisation}` : 'WhatsApp Registration'
  })

  if (error) {
    console.error('Supabase save error:', error.message)
    return {
      reply: `Sorry, something went wrong saving your registration. Please try the web form at:\nspazakulture.co.za/event-rsvp.html`,
      newState: { step: 'idle', data: {} }
    }
  }

  return {
    reply: [
      `✅ *You're registered!*\n\n🎟️ *Ref: ${ref}*\n\n📅 08 December 2026\n📍 City of Tshwane\n⏰ 08:00–17:00\n\nWe'll send venue confirmation and final details soon. See you there! 🎉`,
      `📲 Know someone who should attend?\nShare this link:\nspazakulture.co.za/event-rsvp.html`
    ],
    newState: { step: 'idle', data: {} }
  }
}

async function aiResponse(state, text) {
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 250,
      system: `You are the Spaza Kulture WhatsApp assistant — friendly, helpful, South African.

Spaza Kulture supports township entrepreneurs and spaza shop owners: formalisation, compliance, funding, training.

Upcoming event:
- FNB Spaza Kulture Summit & Expo
- 08 December 2026, City of Tshwane, 08:00–17:00
- Free entry, by registration
- Contact: info@spazakulture.co.za | 073 900 0321

If they want to register, say: "Just reply *register* to get started!"
Keep replies SHORT — max 3 lines. Plain text only, no markdown except *bold*.`,
      messages: [{ role: 'user', content: text }]
    })

    return {
      reply: res.content[0].text,
      newState: { ...state, step: 'idle' }
    }
  } catch (err) {
    console.error('Claude error:', err.message)
    return {
      reply: `Hi! I'm the Spaza Kulture assistant. Reply *register* to sign up for the summit, or email info@spazakulture.co.za for help.`,
      newState: { step: 'idle', data: {} }
    }
  }
}

function cleanName(text) {
  return text
    .replace(/^(my name is|i'?m|i am|call me)\s+/i, '')
    .replace(/[^a-zA-Z\s'\-]/g, '')
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms))
}

module.exports = { handleMessage }
