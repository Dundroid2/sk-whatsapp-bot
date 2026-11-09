const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')
const { downloadMediaMessage } = require('@whiskeysockets/baileys')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

const conversations = new Map()

// ── Provinces (static) ──────────────────────────────────────────────────────
const PROVINCES = {
  '1': { id: 'EC',  name: 'Eastern Cape' },
  '2': { id: 'FS',  name: 'Free State' },
  '3': { id: 'GP',  name: 'Gauteng' },
  '4': { id: 'KZN', name: 'KwaZulu-Natal' },
  '5': { id: 'LP',  name: 'Limpopo' },
  '6': { id: 'MP',  name: 'Mpumalanga' },
  '7': { id: 'NC',  name: 'Northern Cape' },
  '8': { id: 'NW',  name: 'North West' },
  '9': { id: 'WC',  name: 'Western Cape' },
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function hasMedia(msg) {
  return !!(
    msg.message?.imageMessage ||
    msg.message?.documentMessage ||
    msg.message?.videoMessage
  )
}

function mediaType(msg) {
  if (msg.message?.imageMessage) return 'image'
  if (msg.message?.documentMessage) return 'document'
  if (msg.message?.videoMessage) return 'video'
  return null
}

function mediaExt(msg) {
  const doc = msg.message?.documentMessage
  if (doc?.fileName) {
    const parts = doc.fileName.split('.')
    return parts.length > 1 ? parts.pop().toLowerCase() : 'pdf'
  }
  if (msg.message?.imageMessage) return 'jpg'
  return 'bin'
}

// SA ID: 13 digits, Luhn check, valid date
function validateSaId(id) {
  if (!/^\d{13}$/.test(id)) return false
  const month = parseInt(id.substring(2, 4))
  const day   = parseInt(id.substring(4, 6))
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  let sum = 0
  for (let i = 0; i < 12; i++) {
    let d = parseInt(id[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return (10 - (sum % 10)) % 10 === parseInt(id[12])
}

// Passport: letter + 8 alphanumeric
function validatePassport(id) {
  return /^[A-Z][A-Z0-9]{7,11}$/i.test(id)
}

// Format SA mobile to +27XXXXXXXXX
function formatPhone(raw) {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('27') && digits.length === 11) return '+' + digits
  if (digits.startsWith('0') && digits.length === 10) return '+27' + digits.slice(1)
  return null
}

// Upload WhatsApp media buffer to Supabase storage
async function uploadDoc(sock, msg, ref, docType) {
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
      reuploadRequest: sock.updateMediaMessage
    })
    const ext = mediaExt(msg)
    const path = `applications/${ref}/${docType}.${ext}`
    const contentType = ext === 'pdf' ? 'application/pdf' : `image/${ext}`
    const { error } = await supabase.storage.from('documents').upload(path, buffer, { contentType, upsert: true })
    if (error) { console.error('Storage upload error:', error.message); return null }
    return path
  } catch (err) {
    console.error('Media download error:', err.message)
    return null
  }
}

// ── Message handler ──────────────────────────────────────────────────────────

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid
  const text = extractText(msg)
  const media = hasMedia(msg)

  if (!text && !media) return

  let state = getState(jid)
  // Store sender's WhatsApp number in state
  if (!state.data.waPhone) {
    const waNum = jid.replace(/@.*/, '')
    state = { ...state, data: { ...state.data, waPhone: waNum } }
  }

  const result = await processMessage(sock, state, text, msg, media)
  setState(jid, result.newState)

  const replies = Array.isArray(result.reply) ? result.reply : [result.reply]
  for (const r of replies) {
    if (r) await sock.sendMessage(jid, { text: r })
    if (replies.length > 1) await delay(600)
  }
}

// ── Main router ──────────────────────────────────────────────────────────────

async function processMessage(sock, state, text, msg, media) {
  const lower = (text || '').toLowerCase().trim()

  switch (state.step) {

    // ─── IDLE ────────────────────────────────────────────────────────────────
    case 'idle': {
      if (/spaza|shop|register my|open a|my shop|compliance|certificate/i.test(lower)) {
        return {
          reply: [
            `👋 Welcome to *Spaza Kulture!*`,
            `🏪 *Register Your Spaza Shop*\n\nFree help to open or formalise your spaza shop — compliance, certificates and set-up done with you.\n\nThis takes about 3 minutes. Let's start.\n\nWhat is your *first name*?`
          ],
          newState: { step: 'shop_firstname', data: {} }
        }
      }
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

    // ─── SHOP: PERSONAL DETAILS ───────────────────────────────────────────────
    case 'shop_firstname': {
      const name = cleanName(text)
      if (!name) return { reply: `Please tell me your first name:`, newState: state }
      return {
        reply: `Nice to meet you, *${name}*! What is your *surname*?`,
        newState: { ...state, step: 'shop_lastname', data: { ...state.data, firstName: name } }
      }
    }

    case 'shop_lastname': {
      const name = cleanName(text)
      if (!name) return { reply: `Your surname please:`, newState: state }
      return {
        reply: `What is your *SA cell number*?\n\n_e.g. 073 123 4567_`,
        newState: { ...state, step: 'shop_phone', data: { ...state.data, lastName: name } }
      }
    }

    case 'shop_phone': {
      const formatted = formatPhone(text)
      if (!formatted) {
        return {
          reply: `That doesn't look like a valid SA number. Please enter your 10-digit cell number:\n_e.g. 073 123 4567_`,
          newState: state
        }
      }
      return {
        reply: `Got it. What is your *SA ID number* (13 digits) or *passport number*?`,
        newState: { ...state, step: 'shop_idnumber', data: { ...state.data, phone: formatted } }
      }
    }

    case 'shop_idnumber': {
      const val = text.replace(/\s/g, '').toUpperCase()
      if (validateSaId(val)) {
        return {
          reply: `What is your *nationality*?\n\n1️⃣ South African\n2️⃣ Zimbabwean\n3️⃣ Mozambican\n4️⃣ Malawian\n5️⃣ Somali\n6️⃣ Nigerian\n7️⃣ Pakistani\n8️⃣ Other`,
          newState: { ...state, step: 'shop_nationality', data: { ...state.data, idNumber: val, idType: 'sa_id' } }
        }
      }
      if (validatePassport(val)) {
        return {
          reply: `What is your *nationality*?\n\n1️⃣ South African\n2️⃣ Zimbabwean\n3️⃣ Mozambican\n4️⃣ Malawian\n5️⃣ Somali\n6️⃣ Nigerian\n7️⃣ Pakistani\n8️⃣ Other`,
          newState: { ...state, step: 'shop_nationality', data: { ...state.data, idNumber: val, idType: 'passport' } }
        }
      }
      return {
        reply: `That doesn't look right.\n\n• *SA ID*: exactly 13 digits (e.g. 9001015009087)\n• *Passport*: letter + numbers (e.g. A12345678)\n\nPlease try again:`,
        newState: state
      }
    }

    case 'shop_nationality': {
      const natMap = { '1': 'za', '2': 'zw', '3': 'mz', '4': 'mw', '5': 'so', '6': 'ng', '7': 'pk', '8': 'other' }
      const nat = natMap[text.trim()] || 'other'
      return {
        reply: `What is your *trading / business name*?\n\n_Reply *skip* if you haven't chosen a name yet._`,
        newState: { ...state, step: 'shop_bizname', data: { ...state.data, nationality: nat } }
      }
    }

    case 'shop_bizname': {
      const val = /^skip$/i.test(lower) ? null : text.trim()
      return {
        reply: `Are you registered with *CIPC*?\n\n1️⃣ Yes — I have a CIPC number\n2️⃣ No — sole trader / not registered yet\n3️⃣ Not sure`,
        newState: { ...state, step: 'shop_cipc', data: { ...state.data, bizName: val } }
      }
    }

    case 'shop_cipc': {
      const cipcMap = { '1': 'yes', '2': 'no', '3': 'unsure' }
      const val = cipcMap[text.trim()] || 'unsure'
      return {
        reply: `What do you *sell or plan to sell*?\n\n1️⃣ Packaged & dry goods (groceries, drinks)\n2️⃣ Fresh / perishables (produce, meat, dairy)\n3️⃣ Cooked & prepared food (magwinya, kotas, braai)\n4️⃣ Mix of food types\n5️⃣ Non-food only (airtime, clothing, paraffin)`,
        newState: { ...state, step: 'shop_products', data: { ...state.data, cipc: val } }
      }
    }

    case 'shop_products': {
      const prodMap = { '1': 'packaged', '2': 'fresh', '3': 'cooked', '4': 'mix', '5': 'nonfood' }
      const val = prodMap[text.trim()] || text.trim()
      return {
        reply: `Which track fits your situation?\n\n*A* — I already have a room or space to trade from\n*B* — I need a container or kiosk built\n\n_Reply A or B._`,
        newState: { ...state, step: 'shop_track', data: { ...state.data, products: val } }
      }
    }

    // ─── SHOP: LOCATION ───────────────────────────────────────────────────────
    case 'shop_track': {
      const val = /^b$/i.test(lower) ? 'B' : 'A'
      const provinceList = Object.entries(PROVINCES).map(([k, v]) => `${k}️⃣ ${v.name}`).join('\n')
      return {
        reply: `Which *province* is your shop in?\n\n${provinceList}`,
        newState: { ...state, step: 'shop_province', data: { ...state.data, track: val } }
      }
    }

    case 'shop_province': {
      const p = PROVINCES[text.trim()]
      if (!p) return { reply: `Please reply with a number 1–9 for your province:`, newState: state }
      return {
        reply: `Type your *municipality name* (or part of it) and I'll find it.\n\n_e.g. "Johannesburg" or "Mangaung"_`,
        newState: { ...state, step: 'shop_municipality_search', data: { ...state.data, provinceId: p.id, provinceName: p.name } }
      }
    }

    case 'shop_municipality_search': {
      if (text.length < 2) return { reply: `Please type at least 2 letters of your municipality name:`, newState: state }
      const { data: results, error } = await supabase
        .from('sk_municipalities')
        .select('id, name, display_name')
        .eq('province_id', state.data.provinceId)
        .ilike('name', `%${text}%`)
        .limit(8)
      if (error || !results || results.length === 0) {
        return { reply: `No municipality found matching "*${text}*" in ${state.data.provinceName}. Try a different spelling:`, newState: state }
      }
      if (results.length === 1) {
        const m = results[0]
        return {
          reply: `What is your *suburb* or area name?\n\n_e.g. Soweto, Mitchells Plain, Soshanguve_`,
          newState: { ...state, step: 'shop_suburb', data: { ...state.data, municipalityId: m.id, municipalityName: m.display_name || m.name } }
        }
      }
      const list = results.map((m, i) => `${i + 1}. ${m.display_name || m.name}`).join('\n')
      return {
        reply: `Found these — reply with the number:\n\n${list}`,
        newState: { ...state, step: 'shop_municipality_pick', data: { ...state.data, _muniResults: results } }
      }
    }

    case 'shop_municipality_pick': {
      const idx = parseInt(text.trim()) - 1
      const results = state.data._muniResults || []
      if (isNaN(idx) || idx < 0 || idx >= results.length) {
        const list = results.map((m, i) => `${i + 1}. ${m.display_name || m.name}`).join('\n')
        return { reply: `Please reply with a number from the list:\n\n${list}`, newState: state }
      }
      const m = results[idx]
      const { _muniResults, ...cleanData } = state.data
      return {
        reply: `What is your *suburb* or area name?\n\n_e.g. Soweto, Mitchells Plain, Soshanguve_`,
        newState: { ...state, step: 'shop_suburb', data: { ...cleanData, municipalityId: m.id, municipalityName: m.display_name || m.name } }
      }
    }

    case 'shop_suburb': {
      return {
        reply: `What is the *street address* of the shop?\n\n_e.g. 12 Mokoena Street · Reply *skip* if you don't have a street address yet._`,
        newState: { ...state, step: 'shop_address', data: { ...state.data, suburb: text.trim() } }
      }
    }

    case 'shop_address': {
      const val = /^skip$/i.test(lower) ? null : text.trim()
      return {
        reply: `How long have you been trading?\n\n1️⃣ Starting now / less than 1 year\n2️⃣ 1 – 3 years\n3️⃣ More than 3 years`,
        newState: { ...state, step: 'shop_years', data: { ...state.data, address: val } }
      }
    }

    case 'shop_years': {
      const yMap = { '1': 'new', '2': '1to3', '3': '3plus' }
      const val = yMap[text.trim()] || text.trim()
      return {
        reply: `How many people work in the shop?\n\n1️⃣ Just me\n2️⃣ 2 – 5 people\n3️⃣ 6 or more`,
        newState: { ...state, step: 'shop_staff', data: { ...state.data, yearsTrading: val } }
      }
    }

    case 'shop_staff': {
      const sMap = { '1': 'solo', '2': '2to5', '3': '6plus' }
      const val = sMap[text.trim()] || text.trim()
      const d = { ...state.data, staffCount: val }
      const trackLabel = d.track === 'B' ? 'Container Build' : 'Existing Premises'
      const bizLine = d.bizName ? `\n🏪 ${d.bizName}` : ''
      const addrLine = d.address ? `\n📍 ${d.suburb}, ${d.address}` : `\n📍 ${d.suburb}`
      return {
        reply: `📋 *Please confirm your details:*\n\n👤 ${d.firstName} ${d.lastName}\n📞 ${d.phone}\n🪪 ID: ${d.idNumber}\n🌍 ${d.municipalityName}, ${d.provinceName}${addrLine}\n🛒 Products: ${d.products}\n🏗️ Track: ${trackLabel}${bizLine}\n📅 Trading: ${d.yearsTrading} · Staff: ${d.staffCount}\n\nReply *Confirm* ✅ to submit or *Edit* to start over.`,
        newState: { ...state, step: 'shop_confirm', data: d }
      }
    }

    case 'shop_confirm': {
      if (/confirm|yes|correct|ok|✅/i.test(lower)) {
        const saved = await saveShopApplication(state.data)
        if (saved.error) return saved
        return {
          reply: [
            saved.reply,
            `📄 *Documents (optional — upload now or later)*\n\nSend each document as a photo or PDF, or reply *skip* to upload later.\n\n*1 of 4:* Copy of your SA ID or Passport`
          ],
          newState: { step: 'shop_doc_id', data: { ...state.data, ref: saved.ref } }
        }
      }
      if (/edit|no|start|again/i.test(lower)) {
        return { reply: `No problem! Let's start over. What is your *first name*?`, newState: { step: 'shop_firstname', data: {} } }
      }
      return { reply: `Please reply *Confirm* to submit or *Edit* to start over.`, newState: state }
    }

    // ─── SHOP: DOCUMENTS ──────────────────────────────────────────────────────
    case 'shop_doc_id': {
      let docPath = null
      if (media) {
        docPath = await uploadDoc(sock, msg, state.data.ref, 'id_doc')
      }
      const skipped = /^skip$/i.test(lower) || (!media && !text)
      await updateDocs(state.data.ref, 'id_doc', docPath)
      return {
        reply: skipped || !docPath
          ? `Skipped. *2 of 4:* Proof of address (utility bill or bank statement, 3 months)\n\nSend the file or reply *skip*.`
          : `Saved. *2 of 4:* Proof of address (utility bill or bank statement, 3 months)\n\nSend the file or reply *skip*.`,
        newState: { ...state, step: 'shop_doc_addr' }
      }
    }

    case 'shop_doc_addr': {
      let docPath = null
      if (media) docPath = await uploadDoc(sock, msg, state.data.ref, 'proof_addr')
      await updateDocs(state.data.ref, 'proof_addr', docPath)
      const nextPrompt = state.data.track === 'A'
        ? `*3 of 4:* Title deed, lease agreement or consent letter for the premises\n\nSend the file or reply *skip*.`
        : `*3 of 4:* Proof of land / site for the container (consent letter or sketch map)\n\nSend the file or reply *skip*.`
      return {
        reply: nextPrompt,
        newState: { ...state, step: 'shop_doc_title' }
      }
    }

    case 'shop_doc_title': {
      let docPath = null
      if (media) docPath = await uploadDoc(sock, msg, state.data.ref, 'title_deed')
      await updateDocs(state.data.ref, 'title_deed', docPath)
      return {
        reply: `*4 of 4:* CIPC registration certificate (COR14.3 or CoR9.1) — only if you have one\n\nSend the file or reply *skip*.`,
        newState: { ...state, step: 'shop_doc_cipc' }
      }
    }

    case 'shop_doc_cipc': {
      let docPath = null
      if (media) docPath = await uploadDoc(sock, msg, state.data.ref, 'cipc_doc')
      await updateDocs(state.data.ref, 'cipc_doc', docPath)
      return {
        reply: [
          `All done! Our team will review your application and contact you within 2 working days.\n\n📋 Ref: *${state.data.ref}*`,
          `📲 Any missing documents can be sent later — just message us your reference number.\n\nvisit spazakulture.co.za for more info.`
        ],
        newState: { step: 'idle', data: {} }
      }
    }

    // ─── RSVP FLOW ────────────────────────────────────────────────────────────
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
        reply: `Which *organisation or department* are you from?\n_(e.g. City of Tshwane — EHP Dept, FNB Township Banking)_\n\nOr reply *skip* to continue.`,
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
      if (/confirm|yes|correct|ok|✅/i.test(lower)) return saveRsvp(state.data)
      if (/edit|no|start|again/i.test(lower)) {
        return { reply: `No problem! Let's start over. What is your *first name*?`, newState: { step: 'rsvp_firstname', data: {} } }
      }
      return { reply: `Please reply *Confirm* to register or *Edit* to start over.`, newState: state }
    }

    default:
      return aiResponse(state, text)
  }
}

// ── Save helpers ──────────────────────────────────────────────────────────────

async function saveShopApplication(data) {
  const year = new Date().getFullYear()
  const rand = Math.floor(Math.random() * 90000 + 10000)
  const ref = `SK-WA-${year}-${rand}`

  const { error } = await supabase.from('applications').insert({
    ref,
    first_name: data.firstName,
    last_name: data.lastName,
    id_number: data.idNumber,
    nationality: data.nationality || 'za',
    phone: data.phone || data.waPhone || 'unknown',
    email: null,
    biz_name: data.bizName || null,
    cipc: data.cipc || 'unsure',
    products: data.products,
    track: data.track,
    address: data.address || null,
    suburb: data.suburb || null,
    municipality_id: data.municipalityId || null,
    municipality_name: data.municipalityName || null,
    province_id: data.provinceId || null,
    province_name: data.provinceName || null,
    years_trading: data.yearsTrading || null,
    staff_count: data.staffCount || null,
    docs: {},
    consent: true,
    stage: 1
  })

  if (error) {
    console.error('Shop application save error:', error.message)
    return {
      error: true,
      reply: `Sorry, something went wrong saving your application. Please try the web form at spazakulture.co.za or call us on 073 900 0321.`,
      newState: { step: 'idle', data: {} }
    }
  }

  return { ref, reply: `✅ *Application received!*\n\n📋 *Ref: ${ref}*\n\nOur team will contact you within 2 working days.` }
}

async function updateDocs(ref, docType, path) {
  if (!path) return
  try {
    const { data: row } = await supabase.from('applications').select('docs').eq('ref', ref).single()
    const existing = row?.docs || {}
    await supabase.from('applications').update({ docs: { ...existing, [docType]: path } }).eq('ref', ref)
  } catch (err) {
    console.error('updateDocs error:', err.message)
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
    console.error('RSVP save error:', error.message)
    return {
      reply: `Sorry, something went wrong. Please try the web form at spazakulture.co.za/event-rsvp.html`,
      newState: { step: 'idle', data: {} }
    }
  }

  return {
    reply: [
      `✅ *You're registered!*\n\n🎟️ *Ref: ${ref}*\n\n📅 08 December 2026\n📍 City of Tshwane\n⏰ 08:00–17:00\n\nWe'll send venue confirmation and final details soon. See you there!`,
      `📲 Know someone who should attend?\nShare this link:\nspazakulture.co.za/event-rsvp.html`
    ],
    newState: { step: 'idle', data: {} }
  }
}

// ── AI fallback ───────────────────────────────────────────────────────────────

async function aiResponse(state, text) {
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 250,
      system: `You are the Spaza Kulture WhatsApp assistant — friendly, helpful, South African.

Spaza Kulture supports township entrepreneurs and spaza shop owners: formalisation, compliance, funding, training.

Two services:
1. SHOP REGISTRATION — free help to open or formalise a spaza shop. Say: "Reply *spaza shop* to get started!"
2. SUMMIT RSVP — Spaza Kulture Summit, 08 December 2026, City of Tshwane. Say: "Reply *summit* to register!"

Contact: info@spazakulture.co.za | 073 900 0321

Keep replies SHORT — max 3 lines. Plain text only, no markdown except *bold*.`,
      messages: [{ role: 'user', content: text || 'hello' }]
    })
    return { reply: res.content[0].text, newState: { ...state, step: 'idle' } }
  } catch (err) {
    console.error('Claude error:', err.message)
    return {
      reply: `Hi! I'm the Spaza Kulture assistant. Reply *spaza shop* to register your shop, or *summit* to attend the event.`,
      newState: { step: 'idle', data: {} }
    }
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function cleanName(text) {
  return (text || '')
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
