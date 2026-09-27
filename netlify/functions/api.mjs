import { neon } from "@neondatabase/serverless";
import { getConnectionString } from "@netlify/database";
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "crypto";
import { applyOutcome, followupActor, identifyFollowupPin, normalizeLead, parseCsv, projectFollowup, STAFF } from "./followup-lib.mjs";

// Netlify Functions v2 (ESM) so the Netlify Database connection (NETLIFY_DB_URL)
// is available at runtime. DATABASE_URL still wins if set explicitly.
function db() {
  let u = process.env.DATABASE_URL || process.env.NETLIFY_DB_URL;
  if (!u) { try { u = getConnectionString(); } catch (e) {} }
  if (!u) throw new Error("DATABASE_URL not set");
  return neon(u);
}


// Minimum crm_score to keep a non-customer contact. 0 = keep everyone (score scales vary by export).
const MIN_SCORE = parseInt(process.env.MIN_SCORE || '0', 10);
const AGENTS = ['nancy','jazmin','yoana'];
function tbl(a) { return a + '_contacts'; }
function otbls(a) { return AGENTS.filter(x=>x!==a).map(x=>x+'_contacts'); }
function htbl(a) { return a + '_historial'; }
function validAgent(a) { return AGENTS.includes((a||'').toLowerCase()) ? a.toLowerCase() : null; }

async function initDB() {
  const q = db();
  for (const a of AGENTS) {
    await q(`CREATE TABLE IF NOT EXISTS ${tbl(a)} (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE NOT NULL, name VARCHAR(200), buy_score INTEGER, win_status VARCHAR(50), agent VARCHAR(100), city VARCHAR(200), lifecycle VARCHAR(100), reasons TEXT, hours_since INTEGER, crm_score INTEGER, priority VARCHAR(10), status VARCHAR(50) DEFAULT 'Pendiente', notes TEXT DEFAULT '', whatsapp_sent BOOLEAN DEFAULT FALSE, whatsapp_sent_date TIMESTAMP, last_contact_date TIMESTAMP, date_added TIMESTAMP DEFAULT NOW(), date_updated TIMESTAMP DEFAULT NOW(), is_new BOOLEAN DEFAULT TRUE, batch_date DATE DEFAULT CURRENT_DATE, buy_pct INTEGER, reason_to_buy TEXT)`);
    await q(`CREATE TABLE IF NOT EXISTS ${htbl(a)} (id SERIAL PRIMARY KEY, phone VARCHAR(20) NOT NULL, name VARCHAR(200), agent VARCHAR(100), city VARCHAR(200), lifecycle VARCHAR(100), crm_score INTEGER, status VARCHAR(50), notes TEXT, whatsapp_sent BOOLEAN DEFAULT FALSE, whatsapp_sent_date TIMESTAMP, date_added TIMESTAMP, date_archived TIMESTAMP DEFAULT NOW())`);
  }
  // Add columns if missing on old tables
  for (const a of AGENTS) {
    for (const col of ['whatsapp_sent_date TIMESTAMP','last_contact_date TIMESTAMP','buy_pct INTEGER','reason_to_buy TEXT']) {
      try { await q(`ALTER TABLE ${tbl(a)} ADD COLUMN IF NOT EXISTS ${col}`); } catch(e) {}
    }
    try { await q(`ALTER TABLE ${htbl(a)} ADD COLUMN IF NOT EXISTS whatsapp_sent_date TIMESTAMP`); } catch(e) {}
  }
  // Records which agent a contact was handed off from (e.g. 'jazmin')
  try { await q(`ALTER TABLE nancy_contacts ADD COLUMN IF NOT EXISTS handoff_from VARCHAR(20)`); } catch(e) {}
  // Nancy Hot & Payment list (separate from the daily call lists)
  await q(`CREATE TABLE IF NOT EXISTS hot_contacts (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE NOT NULL, name VARCHAR(200), city VARCHAR(200), region VARCHAR(100), tag_bucket TEXT, score INTEGER, why TEXT, lifecycle VARCHAR(100), intent_score INTEGER, inbound_msgs INTEGER, photos INTEGER, last_inbound TIMESTAMP, last_ask TEXT, status VARCHAR(50) DEFAULT 'Pendiente', notes TEXT DEFAULT '', whatsapp_sent BOOLEAN DEFAULT FALSE, whatsapp_sent_date TIMESTAMP, unlocked_date DATE, sort_order INTEGER, date_added TIMESTAMP DEFAULT NOW(), date_updated TIMESTAMP DEFAULT NOW())`);
  // Shared settings: WhatsApp message templates, catalog metadata
  await q(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT NOW())`);
  // Catalog library: PDFs live in Netlify Blobs (key 'cat-<id>'), names/links here
  await q(`CREATE TABLE IF NOT EXISTS catalogs (id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, file_name TEXT, size INTEGER, uploaded_at TIMESTAMP DEFAULT NOW(), sort_order INTEGER DEFAULT 0)`);
  await ensureFollowupSchema();
  return { success: true };
}

const hoursSinceExpr = `COALESCE(EXTRACT(EPOCH FROM (NOW() - last_contact_date))/3600, hours_since, 0)`;
const cols = `id, phone, name, buy_score, win_status, agent, city, lifecycle, reasons, ROUND(${hoursSinceExpr})::int as hours_since, crm_score, priority, status, notes, whatsapp_sent, COALESCE(whatsapp_sent_date, NULL)::timestamp as whatsapp_sent_date, date_added, date_updated, is_new, batch_date, buy_pct, reason_to_buy`;

// HANDOFF: physically move Jazmin's non-customer contacts that have gone
// 85+ hours without contact into Nancy's table. Status, notes and WhatsApp
// history travel with the contact. Runs after every upload and before every
// contacts/stats read so the move happens even without a new upload.
async function handoffToNancy() {
  const q = db();
  const moved = await q(`WITH moved AS (
      DELETE FROM jazmin_contacts
      WHERE (${hoursSinceExpr}) >= 85
        AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer')
      RETURNING *
    )
    INSERT INTO nancy_contacts (phone,name,buy_score,win_status,agent,city,lifecycle,reasons,hours_since,crm_score,priority,status,notes,whatsapp_sent,whatsapp_sent_date,last_contact_date,date_added,date_updated,is_new,batch_date,buy_pct,reason_to_buy,handoff_from)
    SELECT phone,name,buy_score,win_status,agent,city,lifecycle,reasons,hours_since,crm_score,priority,status,notes,whatsapp_sent,whatsapp_sent_date,last_contact_date,date_added,NOW(),TRUE,CURRENT_DATE,buy_pct,reason_to_buy,'jazmin'
    FROM moved
    ON CONFLICT (phone) DO NOTHING
    RETURNING phone`);
  return moved.length;
}

async function getJazminContacts(filters) {
  const q = db();
  const { status, search } = filters || {};
  let sql = `SELECT ${cols}, 'jazmin' as source FROM jazmin_contacts WHERE COALESCE(whatsapp_sent, FALSE) = FALSE AND (crm_score IS NULL OR crm_score >= ${MIN_SCORE}) AND ((${hoursSinceExpr}) < 85 OR (lifecycle IS NOT NULL AND LOWER(lifecycle) = 'customer'))`;
  const p = []; let i = 1;
  if (status && status !== 'all') { sql += ` AND status = $${i++}`; p.push(status); }
  if (search) { sql += ` AND (name ILIKE $${i} OR phone ILIKE $${i})`; p.push('%'+search+'%'); i++; }
  sql += ` ORDER BY is_new DESC, buy_pct DESC NULLS LAST, crm_score DESC NULLS LAST`;
  return await q(sql, p);
}

async function getNancyContacts(filters) {
  const q = db();
  const { status, search } = filters || {};
  let sql1 = `SELECT ${cols}, CASE WHEN handoff_from = 'jazmin' THEN 'jazmin_handoff' ELSE 'nancy' END as source FROM nancy_contacts WHERE COALESCE(whatsapp_sent, FALSE) = FALSE AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= ${MIN_SCORE})`;
  let sql2 = `SELECT ${cols}, 'jazmin_handoff' as source FROM jazmin_contacts WHERE COALESCE(whatsapp_sent, FALSE) = FALSE AND (${hoursSinceExpr}) >= 85 AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= ${MIN_SCORE}) AND phone NOT IN (SELECT phone FROM nancy_contacts)`;
  let sql = `SELECT * FROM ((${sql1}) UNION ALL (${sql2})) combined WHERE 1=1`;
  const p = []; let i = 1;
  if (status && status !== 'all') { sql += ` AND status = $${i++}`; p.push(status); }
  if (search) { sql += ` AND (name ILIKE $${i} OR phone ILIKE $${i})`; p.push('%'+search+'%'); i++; }
  sql += ` ORDER BY is_new DESC, buy_pct DESC NULLS LAST, crm_score DESC NULLS LAST`;
  return await q(sql, p);
}

async function getYoanaContacts(filters) {
  const q = db();
  const { status, search } = filters || {};
  let sql = `SELECT ${cols}, 'yoana' as source FROM yoana_contacts WHERE COALESCE(whatsapp_sent, FALSE) = FALSE AND (crm_score IS NULL OR crm_score >= ${MIN_SCORE})`;
  const p = []; let i = 1;
  if (status && status !== 'all') { sql += ` AND status = $${i++}`; p.push(status); }
  if (search) { sql += ` AND (name ILIKE $${i} OR phone ILIKE $${i})`; p.push('%'+search+'%'); i++; }
  sql += ` ORDER BY is_new DESC, buy_pct DESC NULLS LAST, crm_score DESC NULLS LAST`;
  return await q(sql, p);
}

async function getContacts(agent, filters) {
  if (agent === 'jazmin') return getJazminContacts(filters);
  if (agent === 'yoana') return getYoanaContacts(filters);
  return getNancyContacts(filters);
}

async function getHistorial(agent, filters) {
  const q = db();
  const t = htbl(agent);
  const { search } = filters || {};
  let sql = `SELECT * FROM ${t} WHERE 1=1`;
  const p = []; let i = 1;
  if (search) { sql += ` AND (name ILIKE $${i} OR phone ILIKE $${i})`; p.push('%'+search+'%'); i++; }
  sql += ` ORDER BY date_archived DESC`;
  return await q(sql, p);
}

// Calculate buy percentage and reason
function calcBuyPct(buyScore, maxScore) {
  const b = Number(buyScore) || 0, m = Number(maxScore) || 165;
  if (!b) return 0;
  return Math.min(100, Math.round((b / m) * 100));
}

function calcReason(c) {
  const reasons = [];
  const raw = String(c.reasons || '');
  const life = String(c.lifecycle || '').toLowerCase();
  if (raw.includes('Payment') || raw.includes('💰')) reasons.push('Payment mentioned');
  if (raw.includes('Wholesale') || raw.includes('🏷')) reasons.push('Wholesale interest');
  if (life === 'customer') reasons.push('Existing customer');
  else if (life === 'hot lead') reasons.push('Hot lead');
  else if (life === 'intento de compra') reasons.push('Tried to buy');
  else if (life === 'payment') reasons.push('Payment stage');
  if (raw.includes('📷')) { try { const n=parseInt(raw.split('Sent ')[1]); if(n>=10) reasons.push(n+' product images'); else if(n>=3) reasons.push('Browsed '+n+' products'); } catch(e){} }
  if (raw.includes('💬')) { try { const n=parseInt(raw.split('💬 ')[1]); if(n>=50) reasons.push('Highly engaged ('+n+' msgs)'); else if(n>=20) reasons.push('Active ('+n+' msgs)'); } catch(e){} }
  const h = c.hours_since || 0;
  if (h < 24) reasons.push('Today');
  else if (h < 48) reasons.push('Last 2 days');
  else if (h < 72) reasons.push('This week');
  return reasons.join(' · ') || 'General interest';
}

// SINGLE UPLOAD: splits one file into agent tables automatically
async function uploadSingle(contacts) {
  const q = db();
  const result = { nancy: {new:0,upd:0}, jazmin: {new:0,upd:0}, yoana: {new:0,upd:0}, archived:0, skipped:0, dupes:0, total: contacts.length };

  // Reset the 'new' flag from the previous batch (contacts are never deleted or archived on upload)
  for (const a of AGENTS) await q(`UPDATE ${tbl(a)} SET is_new = FALSE WHERE is_new = TRUE`);

  // Track all phones we've processed to prevent dupes within this upload
  const processed = new Set();

  const maxBuy = Math.max(1, ...contacts.map(c => Number(c.buy_score) || 0));
  for (const c of contacts) {
    const phone = String(c.phone||'').replace(/[^0-9]/g,'');
    if (!phone) continue;
    if (processed.has(phone)) { result.dupes++; continue; }
    processed.add(phone);

    const lifecycle = String(c.lifecycle||'').toLowerCase().trim();
    const isCustomer = lifecycle === 'customer';
    const score = Number(c.crm_score) || 0;
    const hours = Number(c.hours_since) || 0;
    const agentRaw = String(c.agent||'').toLowerCase().trim();

    // Skip non-customer low scores
    if (!isCustomer && score < MIN_SCORE) { result.skipped++; continue; }

    // Determine target agent
    let targetAgent;
    if (agentRaw.includes('yoana')) {
      targetAgent = 'yoana';
    } else if (agentRaw.includes('jazmin') || agentRaw.includes('adriana')) {
      if (isCustomer || hours < 85) {
        targetAgent = 'jazmin';
      } else {
        targetAgent = 'nancy'; // 85+ hour handoff
      }
    } else if (agentRaw.includes('nancy') || agentRaw.includes('asesor')) {
      targetAgent = 'nancy';
    } else {
      targetAgent = 'nancy'; // unassigned -> nancy
    }

    const t = tbl(targetAgent);
    const buyPct = calcBuyPct(c.buy_score, maxBuy);
    const reasonToBuy = calcReason(c);
    const lastContactDate = hours ? `NOW() - INTERVAL '${parseInt(hours)} hours'` : 'NULL';

    // If the phone already exists in ANY agent table, refresh it in place there.
    // The owning table never changes on upload; only handoffToNancy() moves contacts.
    let exists = false;
    for (const a of AGENTS) {
      const found = await q(`SELECT id FROM ${tbl(a)} WHERE phone = $1`, [phone]);
      if (found.length > 0) {
        await q(`UPDATE ${tbl(a)} SET name=$1,buy_score=$2,win_status=$3,agent=$4,city=$5,lifecycle=$6,reasons=$7,hours_since=$8,crm_score=$9,priority=$10,last_contact_date=${lastContactDate},buy_pct=$11,reason_to_buy=$12,date_updated=NOW(),batch_date=CURRENT_DATE WHERE phone=$13`,
          [c.name||null,c.buy_score||null,c.window||null,c.agent||null,c.city||null,c.lifecycle||null,c.reasons||null,hours||null,score||null,c.priority||null,buyPct,reasonToBuy,phone]);
        result[a].upd++;
        if (a !== targetAgent) result.dupes++;
        exists = true;
        break;
      }
    }

    if (!exists) {
      // A Jazmin/Adriana row routed to Nancy at upload time is a handoff too; tag it so the UI shows the pill
      const handoffCol = (targetAgent === 'nancy' && (agentRaw.includes('jazmin') || agentRaw.includes('adriana'))) ? `,'jazmin'` : '';
      await q(`INSERT INTO ${t} (phone,name,buy_score,win_status,agent,city,lifecycle,reasons,hours_since,crm_score,priority,last_contact_date,buy_pct,reason_to_buy,status,is_new,batch_date${handoffCol ? ',handoff_from' : ''}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${lastContactDate},$12,$13,'Pendiente',TRUE,CURRENT_DATE${handoffCol})`,
        [phone,c.name||null,c.buy_score||null,c.window||null,c.agent||null,c.city||null,c.lifecycle||null,c.reasons||null,hours||null,score||null,c.priority||null,buyPct,reasonToBuy]);
      result[targetAgent].new++;
    }
  }
  // Move Jazmin's stale (85h+, non-customer) contacts to Nancy
  result.handoff = await handoffToNancy();
  return result;
}

async function uploadContacts(agent, contacts) {
  // Keep backward compat for per-agent upload
  const wrapped = contacts.map(c => ({ ...c, agent: agent }));
  return await uploadSingle(wrapped);
}

async function updateContact(agent, id, updates) {
  const q = db();
  // Find which table has this id
  let t = tbl(agent);
  const inAgent = await q(`SELECT id FROM ${t} WHERE id = $1`, [id]);
  if (inAgent.length === 0) {
    // Check other tables (for handoff contacts)
    for (const a of AGENTS) {
      if (a === agent) continue;
      const found = await q(`SELECT id FROM ${tbl(a)} WHERE id = $1`, [id]);
      if (found.length > 0) { t = tbl(a); break; }
    }
  }
  const { status, notes, whatsapp_sent } = updates;
  if (whatsapp_sent) {
    const ready = await q(`SELECT (${hoursSinceExpr}) >= ${MIN_SILENT_HOURS} AS ok FROM ${t} WHERE id = $1`, [id]);
    if (ready.length && !ready[0].ok) return { error: 'too_recent', code: 403 };
  }
  let sets = ['date_updated = NOW()'], p = [], i = 1;
  if (status) { sets.push(`status = $${i++}`); p.push(status); }
  if (notes !== undefined) { sets.push(`notes = $${i++}`); p.push(notes); }
  if (whatsapp_sent !== undefined) { sets.push(`whatsapp_sent = $${i++}`); p.push(whatsapp_sent); if (whatsapp_sent) { sets.push('whatsapp_sent_date = NOW()'); if (!status) sets.push(`status = CASE WHEN status = 'Pendiente' THEN 'Contactada' ELSE status END`); } }
  p.push(id);
  await q(`UPDATE ${t} SET ${sets.join(', ')} WHERE id = $${i}`, p);
  return { success: true };
}

async function getStats(agent) {
  const q = db();
  if (agent === 'jazmin') {
    const f = `(crm_score IS NULL OR crm_score >= ${MIN_SCORE}) AND ((${hoursSinceExpr}) < 85 OR (lifecycle IS NOT NULL AND LOWER(lifecycle) = 'customer'))`;
    const total = await q(`SELECT COUNT(*) as count FROM jazmin_contacts WHERE ${f}`);
    const byStatus = await q(`SELECT status, COUNT(*) as count FROM jazmin_contacts WHERE ${f} GROUP BY status ORDER BY count DESC`);
    const newToday = await q(`SELECT COUNT(*) as count FROM jazmin_contacts WHERE is_new = TRUE AND ${f}`);
    const byAgent = await q(`SELECT agent, COUNT(*) as count FROM jazmin_contacts WHERE ${f} GROUP BY agent ORDER BY count DESC`);
    const histCount = await q(`SELECT COUNT(*) as count FROM jazmin_historial`);
    return { total: total[0].count, newToday: newToday[0].count, byStatus, byAgent, historialCount: histCount[0].count };
  }
  if (agent === 'yoana') {
    const f = `(crm_score IS NULL OR crm_score >= ${MIN_SCORE})`;
    const total = await q(`SELECT COUNT(*) as count FROM yoana_contacts WHERE ${f}`);
    const byStatus = await q(`SELECT status, COUNT(*) as count FROM yoana_contacts WHERE ${f} GROUP BY status ORDER BY count DESC`);
    const newToday = await q(`SELECT COUNT(*) as count FROM yoana_contacts WHERE is_new = TRUE AND ${f}`);
    const byAgent = await q(`SELECT agent, COUNT(*) as count FROM yoana_contacts WHERE ${f} GROUP BY agent ORDER BY count DESC`);
    const histCount = await q(`SELECT COUNT(*) as count FROM yoana_historial`);
    return { total: total[0].count, newToday: newToday[0].count, byStatus, byAgent, historialCount: histCount[0].count };
  }
  // Nancy: her table + jazmin handoffs
  const nf = `(lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= ${MIN_SCORE})`;
  const jf = `(${hoursSinceExpr}) >= 85 AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= ${MIN_SCORE}) AND phone NOT IN (SELECT phone FROM nancy_contacts)`;
  const t1 = await q(`SELECT COUNT(*) as count FROM nancy_contacts WHERE ${nf}`);
  const t2 = await q(`SELECT COUNT(*) as count FROM jazmin_contacts WHERE ${jf}`);
  const totalCount = parseInt(t1[0].count) + parseInt(t2[0].count);
  const byStatus = await q(`SELECT status, SUM(cnt)::int as count FROM (SELECT status, COUNT(*) as cnt FROM nancy_contacts WHERE ${nf} GROUP BY status UNION ALL SELECT status, COUNT(*) as cnt FROM jazmin_contacts WHERE ${jf} GROUP BY status) sub GROUP BY status ORDER BY count DESC`);
  const n1 = await q(`SELECT COUNT(*) as count FROM nancy_contacts WHERE is_new = TRUE AND ${nf}`);
  const n2 = await q(`SELECT COUNT(*) as count FROM jazmin_contacts WHERE is_new = TRUE AND ${jf}`);
  const newCount = parseInt(n1[0].count) + parseInt(n2[0].count);
  const byAgent = await q(`SELECT agent, SUM(cnt)::int as count FROM (SELECT agent, COUNT(*) as cnt FROM nancy_contacts WHERE ${nf} GROUP BY agent UNION ALL SELECT agent, COUNT(*) as cnt FROM jazmin_contacts WHERE ${jf} GROUP BY agent) sub GROUP BY agent ORDER BY count DESC`);
  const histCount = await q(`SELECT COUNT(*) as count FROM nancy_historial`);
  return { total: totalCount, newToday: newCount, byStatus, byAgent, historialCount: histCount[0].count };
}

// ===== NANCY HOT & PAYMENT LIST =====
// Separate list (hot_contacts). Every day HOT_DAILY_LIMIT locked contacts are
// unlocked (highest score first) for Nancy; WhatsApp sends are only accepted
// for contacts unlocked today. Days are Mexico City days.
// 0 = no daily cap: every eligible (85h-silent) chat opens at once
const HOT_DAILY_LIMIT = parseInt(process.env.HOT_DAILY_LIMIT || '0', 10);
// A chat may only be messaged once the client has been silent this long (both lists)
const MIN_SILENT_HOURS = parseInt(process.env.MIN_SILENT_HOURS || '85', 10);
const HOT_READY = `(last_inbound IS NULL OR last_inbound <= NOW() - INTERVAL '${MIN_SILENT_HOURS} hours')`;
const MX_TODAY = `(NOW() AT TIME ZONE 'America/Mexico_City')::date`;
const MX_DATE = (col) => `((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Mexico_City')::date`;

async function unlockHotDaily() {
  const q = db();
  const c = await q(`SELECT COUNT(*)::int AS n FROM hot_contacts WHERE unlocked_date = ${MX_TODAY}`);
  const need = HOT_DAILY_LIMIT > 0 ? HOT_DAILY_LIMIT - c[0].n : 100000;
  if (need <= 0) return 0;
  const r = await q(`UPDATE hot_contacts SET unlocked_date = ${MX_TODAY}, date_updated = NOW() WHERE id IN (SELECT id FROM hot_contacts WHERE unlocked_date IS NULL AND ${HOT_READY} ORDER BY score DESC NULLS LAST, sort_order ASC NULLS LAST, id ASC LIMIT $1) RETURNING id`, [need]);
  return r.length;
}

const hotCols = `id, phone, name, city, region, tag_bucket, score, why, lifecycle, intent_score, inbound_msgs, photos, last_inbound, last_ask, status, notes, whatsapp_sent, whatsapp_sent_date, unlocked_date, ROUND(EXTRACT(EPOCH FROM (NOW() - last_inbound))/3600)::int AS hours_since, (unlocked_date = ${MX_TODAY}) AS is_today, ${HOT_READY} AS is_ready, (whatsapp_sent_date IS NOT NULL AND ${MX_DATE('whatsapp_sent_date')} = ${MX_TODAY}) AS sent_today`;

async function getHotContacts(qs) {
  const q = db();
  await unlockHotDaily();
  const { mode, status, search } = qs || {};
  const p = []; let i = 1; let where = 'WHERE 1=1';
  if (status && status !== 'all') { where += ` AND status = $${i++}`; p.push(status); }
  if (search) { where += ` AND (name ILIKE $${i} OR phone ILIKE $${i} OR city ILIKE $${i})`; p.push('%' + search + '%'); i++; }
  where += ' AND COALESCE(whatsapp_sent, FALSE) = FALSE'; // sent contacts live in History
  if (mode !== 'all') where += ' AND unlocked_date IS NOT NULL';
  const rows = await q(`SELECT ${hotCols} FROM hot_contacts ${where} ORDER BY unlocked_date DESC NULLS LAST, score DESC NULLS LAST, sort_order ASC NULLS LAST, id ASC`, p);
  const counts = await q(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE unlocked_date IS NULL)::int AS locked, COUNT(*) FILTER (WHERE unlocked_date = ${MX_TODAY})::int AS today, COUNT(*) FILTER (WHERE whatsapp_sent_date IS NOT NULL AND ${MX_DATE('whatsapp_sent_date')} = ${MX_TODAY})::int AS sent_today, COUNT(*) FILTER (WHERE status = 'Venta')::int AS sales FROM hot_contacts`);
  return {
    limit: HOT_DAILY_LIMIT,
    today: rows.filter(r => r.is_today),
    earlier: rows.filter(r => !r.is_today && r.unlocked_date),
    locked: rows.filter(r => !r.unlocked_date),
    counts: counts[0],
  };
}

const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const toTs = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString(); // Excel serial
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const d = new Date(s); return isNaN(d) ? null : d.toISOString();
};

// Upsert the whole list in chunks (one statement per chunk so 400+ rows fit
// inside the function timeout). Keeps status/notes/unlock state for phones
// that already exist. With replace=true, phones missing from the file are removed.
async function uploadHot(contacts, replace) {
  const q = db();
  const result = { new: 0, upd: 0, removed: 0, skipped: 0, total: contacts.length };
  const seen = new Set(); const clean = [];
  for (const c of contacts) {
    const phone = String(c.phone || '').replace(/[^0-9]/g, '');
    if (!phone || seen.has(phone)) { result.skipped++; continue; }
    seen.add(phone);
    clean.push({ phone, name: c.name || null, city: c.city || null, region: c.region || null, tag_bucket: c.tag_bucket || null, score: toInt(c.score), why: c.why || null, lifecycle: c.lifecycle || null, intent_score: toInt(c.intent_score), inbound_msgs: toInt(c.inbound_msgs), photos: toInt(c.photos), last_inbound: toTs(c.last_inbound), last_ask: c.last_ask || null, sort_order: clean.length + 1 });
  }
  const CHUNK = 150;
  for (let s = 0; s < clean.length; s += CHUNK) {
    const part = clean.slice(s, s + CHUNK);
    const col = (k) => part.map(r => r[k]);
    const r = await q(`INSERT INTO hot_contacts (phone,name,city,region,tag_bucket,score,why,lifecycle,intent_score,inbound_msgs,photos,last_inbound,last_ask,sort_order)
      SELECT * FROM UNNEST($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::int[],$7::text[],$8::text[],$9::int[],$10::int[],$11::int[],$12::timestamp[],$13::text[],$14::int[])
      ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name, city=EXCLUDED.city, region=EXCLUDED.region, tag_bucket=EXCLUDED.tag_bucket, score=EXCLUDED.score, why=EXCLUDED.why, lifecycle=EXCLUDED.lifecycle, intent_score=EXCLUDED.intent_score, inbound_msgs=EXCLUDED.inbound_msgs, photos=EXCLUDED.photos, last_inbound=EXCLUDED.last_inbound, last_ask=EXCLUDED.last_ask, sort_order=EXCLUDED.sort_order, date_updated=NOW()
      RETURNING (xmax = 0) AS inserted`,
      [col('phone'), col('name'), col('city'), col('region'), col('tag_bucket'), col('score'), col('why'), col('lifecycle'), col('intent_score'), col('inbound_msgs'), col('photos'), col('last_inbound'), col('last_ask'), col('sort_order')]);
    for (const row of r) { if (row.inserted) result.new++; else result.upd++; }
  }
  if (replace && clean.length) {
    const del = await q(`DELETE FROM hot_contacts WHERE NOT (phone = ANY($1::text[])) RETURNING id`, [clean.map(r => r.phone)]);
    result.removed = del.length;
  }
  return result;
}

async function updateHotContact(id, updates) {
  const q = db();
  const { status, notes, whatsapp_sent } = updates;
  const row = await q(`SELECT id, unlocked_date, whatsapp_sent, (unlocked_date = ${MX_TODAY}) AS is_today, ${HOT_READY} AS is_ready FROM hot_contacts WHERE id = $1`, [id]);
  if (!row.length) return { error: 'not found', code: 404 };
  if (!row[0].unlocked_date) return { error: 'locked', code: 403 };
  // First send only on today's chats; re-sending to an already-contacted client (follow-up from History) is always allowed
  if (HOT_DAILY_LIMIT > 0 && whatsapp_sent && !row[0].is_today && !row[0].whatsapp_sent) return { error: 'daily_limit', code: 403 };
  if (whatsapp_sent && !row[0].is_ready) return { error: 'too_recent', code: 403 };
  let sets = ['date_updated = NOW()'], p = [], i = 1;
  if (status) { sets.push(`status = $${i++}`); p.push(status); }
  if (notes !== undefined) { sets.push(`notes = $${i++}`); p.push(notes); }
  if (whatsapp_sent !== undefined) { sets.push(`whatsapp_sent = $${i++}`); p.push(whatsapp_sent); if (whatsapp_sent) { sets.push('whatsapp_sent_date = NOW()'); if (!status) sets.push(`status = CASE WHEN status = 'Pendiente' THEN 'Contactada' ELSE status END`); } }
  p.push(id);
  await q(`UPDATE hot_contacts SET ${sets.join(', ')} WHERE id = $${i}`, p);
  return { success: true };
}

// ===== HISTORY: every contact that has been messaged, from both lists =====
// Rows stay in their own table (status/notes remain editable); this is a view.
async function getHistory(qs) {
  const q = db();
  const { status, search, list } = qs || {};
  const p = []; let i = 1; let where = '';
  if (status && status !== 'all') { where += ` AND status = $${i++}`; p.push(status); }
  if (search) { where += ` AND (name ILIKE $${i} OR phone ILIKE $${i} OR city ILIKE $${i})`; p.push('%' + search + '%'); i++; }
  const parts = [];
  for (const a of AGENTS) {
    parts.push(`SELECT id, '${a}' AS agent, 'contacts' AS list, phone, name, city, lifecycle, status, notes, whatsapp_sent_date, date_updated, buy_pct AS score FROM ${tbl(a)} WHERE whatsapp_sent = TRUE${where}`);
  }
  parts.push(`SELECT id, 'nancy' AS agent, 'hot' AS list, phone, name, city, lifecycle, status, notes, whatsapp_sent_date, date_updated, score FROM hot_contacts WHERE whatsapp_sent = TRUE${where}`);
  let sql = `SELECT * FROM (${parts.map(x => '(' + x + ')').join(' UNION ALL ')}) h`;
  if (list === 'contacts' || list === 'hot') sql += ` WHERE list = '${list}'`;
  sql += ` ORDER BY whatsapp_sent_date DESC NULLS LAST, date_updated DESC`;
  // the same $n params are reused by every UNION branch
  return await q(sql, p);
}

// ===== SETTINGS (shared WhatsApp templates) + CATALOG PDF (Netlify Blobs) =====
async function getSettings() {
  const rows = await db()(`SELECT key, value FROM settings`);
  const o = {}; for (const r of rows) o[r.key] = r.value; return o;
}
async function putSettings(obj) {
  const q = db();
  for (const [k, v] of Object.entries(obj || {})) {
    if (!/^[a-z0-9_]{1,50}$/.test(k)) continue;
    await q(`INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [k, v == null ? null : String(v)]);
  }
  return getSettings();
}
const catalogStore = () => getStore({ name: 'catalog', consistency: 'strong' });
const slugify = (s) => (String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'catalogo';
const CAT_COLS = `id, slug, name, file_name, size, uploaded_at, sort_order`;
async function listCatalogs() { return db()(`SELECT ${CAT_COLS} FROM catalogs ORDER BY sort_order ASC, id ASC`); }

// Upload a PDF. With ?id=<n> it replaces the file of an existing catalog,
// otherwise it creates a new catalog named by the X-Catalog-Name header.
async function saveCatalog(req, qs) {
  const q = db();
  const fileName = decodeURIComponent(req.headers.get('x-file-name') || 'catalogo.pdf');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return { error: 'empty file', code: 400 };
  const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 5)));
  if (!head.startsWith('%PDF')) return { error: 'File is not a PDF', code: 400 };
  let row;
  if (qs && qs.id) {
    const found = await q(`SELECT ${CAT_COLS} FROM catalogs WHERE id = $1`, [parseInt(qs.id, 10)]);
    if (!found.length) return { error: 'catalog not found', code: 404 };
    row = found[0];
  } else {
    const name = (decodeURIComponent(req.headers.get('x-catalog-name') || '').trim()) || fileName.replace(/\.pdf$/i, '');
    const base = slugify(name); let slug = base;
    for (let n = 2; (await q(`SELECT 1 FROM catalogs WHERE slug = $1`, [slug])).length; n++) slug = `${base}-${n}`;
    const ord = await q(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS o FROM catalogs`);
    row = (await q(`INSERT INTO catalogs (slug, name, sort_order) VALUES ($1, $2, $3) RETURNING ${CAT_COLS}`, [slug, name, ord[0].o]))[0];
  }
  await catalogStore().set('cat-' + row.id, buf, { metadata: { name: row.name, fileName, size: buf.byteLength } });
  const upd = await q(`UPDATE catalogs SET file_name = $1, size = $2, uploaded_at = NOW() WHERE id = $3 RETURNING ${CAT_COLS}`, [fileName, buf.byteLength, row.id]);
  return { success: true, catalog: upd[0] };
}
async function updateCatalog(id, body) {
  const q = db();
  const sets = [], p = []; let i = 1;
  if (body.name != null && String(body.name).trim()) { sets.push(`name = $${i++}`); p.push(String(body.name).trim()); }
  if (body.sort_order != null) { sets.push(`sort_order = $${i++}`); p.push(parseInt(body.sort_order, 10) || 0); }
  if (!sets.length) return { error: 'nothing to update', code: 400 };
  p.push(id);
  const r = await q(`UPDATE catalogs SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${CAT_COLS}`, p);
  return r.length ? { success: true, catalog: r[0] } : { error: 'catalog not found', code: 404 };
}
async function deleteCatalog(id) {
  const r = await db()(`DELETE FROM catalogs WHERE id = $1 RETURNING id`, [id]);
  if (!r.length) return { error: 'catalog not found', code: 404 };
  try { await catalogStore().delete('cat-' + id); } catch (e) {}
  return { success: true };
}
// Public: customers open /catalogo/<slug> from the WhatsApp message.
// /catalogo with no slug serves the first catalog.
async function serveCatalog(slug) {
  const q = db();
  const rows = slug
    ? await q(`SELECT ${CAT_COLS} FROM catalogs WHERE slug = $1`, [slug])
    : await q(`SELECT ${CAT_COLS} FROM catalogs WHERE file_name IS NOT NULL ORDER BY sort_order ASC, id ASC LIMIT 1`);
  if (!rows.length || !rows[0].file_name) return new Response('No hay catálogo disponible', { status: 404 });
  const r = await catalogStore().get('cat-' + rows[0].id, { type: 'arrayBuffer' });
  if (!r) return new Response('No hay catálogo disponible', { status: 404 });
  const fname = String(rows[0].file_name || 'catalogo.pdf').replace(/[^\w.\-]/g, '_');
  return new Response(r, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fname}"`, 'Cache-Control': 'no-cache' } });
}

// ===== SEGUIMIENTO: Perla, Jazmin (calls) and Yoana (WhatsApp) =====
// Each person authenticates with her own PIN. APP_TOKEN does not open these routes.
// Lead fields are refreshed on import. Outcome, attempts, and history are not.
const FOLLOWUP_STATUSES_REACHED = ['Vendido', 'Viene a la tienda', 'Volver a llamar', 'No le interesa'];

let followupReady = null;
function ensureFollowupSchema() {
  if (!followupReady) {
    followupReady = (async () => {
      const q = db();
      await q(`CREATE TABLE IF NOT EXISTS followups (
        id SERIAL PRIMARY KEY,
        contact_id TEXT UNIQUE NOT NULL,
        name TEXT,
        phone TEXT,
        lifecycle TEXT,
        assignee TEXT NOT NULL,
        note TEXT,
        suggested_message TEXT,
        last_interaction TIMESTAMP,
        days_since NUMERIC,
        ciudad TEXT,
        outcome TEXT,
        outcome_comment TEXT,
        outcome_at TIMESTAMP,
        attempts INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER,
        date_added TIMESTAMP DEFAULT NOW(),
        date_updated TIMESTAMP DEFAULT NOW()
      )`);
      await q(`CREATE TABLE IF NOT EXISTS followup_outcomes (
        id SERIAL PRIMARY KEY,
        contact_id TEXT NOT NULL,
        status TEXT NOT NULL,
        comment TEXT,
        auto BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      await q(`ALTER TABLE followup_outcomes ADD COLUMN IF NOT EXISTS person TEXT`);
      await q(`CREATE INDEX IF NOT EXISTS followups_assignee_active_idx ON followups (assignee, active)`);
      await q(`CREATE INDEX IF NOT EXISTS followup_outcomes_contact_idx ON followup_outcomes (contact_id)`);
      await q(`CREATE INDEX IF NOT EXISTS followup_outcomes_created_idx ON followup_outcomes (created_at)`);
    })().catch((err) => { followupReady = null; throw err; });
  }
  return followupReady;
}

function asDay(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const m = v.match(/\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

function shapeFollowup(row) {
  const active = row.active === true || row.active === 't' || row.active === 'true';
  const daysLive = row.days_since_now == null || row.days_since_now === '' ? null : Number(row.days_since_now);
  return {
    contact_id: row.contact_id,
    name: row.name,
    phone: row.phone,
    lifecycle: row.lifecycle,
    assignee: row.assignee,
    note: row.note,
    suggested_message: row.suggested_message,
    last_interaction: row.last_interaction,
    days_since: row.days_since == null || row.days_since === '' ? null : Number(row.days_since),
    days_since_now: Number.isFinite(daysLive) ? daysLive : null,
    ciudad: row.ciudad,
    outcome: row.outcome,
    outcome_comment: row.outcome_comment,
    outcome_at: row.outcome_at,
    attempts: Number(row.attempts) || 0,
    active,
    sort_order: row.sort_order == null ? null : Number(row.sort_order),
  };
}

const followupSelect = `contact_id, name, phone, lifecycle, assignee, note, suggested_message, last_interaction, days_since, ciudad, outcome, outcome_comment, outcome_at, attempts, active, sort_order,
  CASE WHEN last_interaction IS NOT NULL
    THEN ROUND((EXTRACT(EPOCH FROM (NOW() - last_interaction)) / 86400.0)::numeric, 1)
    ELSE days_since END AS days_since_now`;

function parseHistory(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (e) { return []; } }
  return [];
}

async function listFollowups(qs, actor) {
  await ensureFollowupSchema();
  const q = db();
  const staff = actor.role === 'staff';
  const requested = String((qs && qs.assignee) || '').toLowerCase();
  if (staff && requested && requested !== actor.person) return { error: 'No autorizado', code: 403 };
  const assignee = staff ? actor.person : (requested || 'all');
  if (!staff && assignee !== 'all' && !STAFF.includes(assignee)) return { rows: [], count: 0 };
  const scope = qs && qs.scope === 'all' ? 'all' : 'active';
  const life = qs && qs.lifecycle ? String(qs.lifecycle) : '';
  const search = qs && qs.search ? String(qs.search).trim() : '';
  const p = [];
  let i = 1;
  const personSql = staff ? ` AND o.person = $${i++}` : '';
  if (staff) p.push(actor.person);
  let sql = `SELECT ${followupSelect},
    COALESCE((
      SELECT json_agg(json_build_object(
        'status', o.status, 'comment', o.comment, 'auto', o.auto, 'created_at', o.created_at, 'person', o.person
      ) ORDER BY o.created_at, o.id)
      FROM followup_outcomes o
      WHERE o.contact_id = followups.contact_id${personSql}
    ), '[]'::json) AS history
    FROM followups WHERE 1=1`;
  if (assignee !== 'all') { sql += ` AND assignee = $${i++}`; p.push(assignee); }
  if (scope !== 'all') sql += ` AND active = TRUE`;
  if (life) { sql += ` AND lifecycle = $${i++}`; p.push(life); }
  if (search) {
    sql += ` AND (name ILIKE $${i} OR phone ILIKE $${i} OR ciudad ILIKE $${i} OR note ILIKE $${i} OR contact_id ILIKE $${i})`;
    p.push('%' + search + '%');
    i++;
  }
  sql += ` ORDER BY sort_order ASC NULLS LAST, id ASC`;
  const rows = await q(sql, p);
  return {
    rows: rows.map((r) => projectFollowup({ ...shapeFollowup(r), history: parseHistory(r.history) }, actor)),
    count: rows.length,
  };
}

async function followupSummary() {
  await ensureFollowupSchema();
  const q = db();
  const todayRows = await q(`SELECT (NOW() AT TIME ZONE 'America/Mexico_City')::date AS today`);
  const grouped = await q(`SELECT f.assignee,
      COUNT(DISTINCT f.contact_id) FILTER (WHERE f.active)::int AS assigned,
      COUNT(DISTINCT f.contact_id) FILTER (WHERE o.auto = FALSE AND ${MX_DATE('o.created_at')} = ${MX_TODAY})::int AS contacted,
      COUNT(DISTINCT f.contact_id) FILTER (WHERE o.status IN ('Vendido','Viene a la tienda','Volver a llamar','No le interesa') AND ${MX_DATE('o.created_at')} = ${MX_TODAY})::int AS reached,
      COUNT(DISTINCT f.contact_id) FILTER (WHERE o.status = 'Vendido' AND ${MX_DATE('o.created_at')} = ${MX_TODAY})::int AS sold,
      COUNT(DISTINCT f.contact_id) FILTER (WHERE o.status = 'Viene a la tienda' AND ${MX_DATE('o.created_at')} = ${MX_TODAY})::int AS coming_to_store
    FROM followups f
    LEFT JOIN followup_outcomes o ON o.contact_id = f.contact_id
    WHERE f.assignee IN ('perla','yoana','jazmin')
    GROUP BY f.assignee`);
  const blank = () => ({ assigned: 0, contacted: 0, reached: 0, sold: 0, coming_to_store: 0 });
  const people = {
    perla: { ...blank(), channel: 'llamadas' },
    jazmin: { ...blank(), channel: 'llamadas' },
    yoana: { ...blank(), channel: 'whatsapp' },
  };
  for (const r of grouped) {
    if (!people[r.assignee]) continue;
    people[r.assignee].assigned = Number(r.assigned) || 0;
    people[r.assignee].contacted = Number(r.contacted) || 0;
    people[r.assignee].reached = Number(r.reached) || 0;
    people[r.assignee].sold = Number(r.sold) || 0;
    people[r.assignee].coming_to_store = Number(r.coming_to_store) || 0;
  }
  return {
    timezone: 'America/Mexico_City',
    date: todayRows[0] ? asDay(todayRows[0].today) : null,
    perla: people.perla,
    jazmin: people.jazmin,
    yoana: people.yoana,
    reached_statuses: FOLLOWUP_STATUSES_REACHED,
  };
}

async function historyFor(contactId, actor) {
  const q = db();
  const staff = actor.role === 'staff';
  const rows = await q(
    `SELECT status, comment, auto, created_at, person FROM followup_outcomes
     WHERE contact_id = $1${staff ? ' AND person = $2' : ''}
     ORDER BY created_at, id`,
    staff ? [contactId, actor.person] : [contactId]
  );
  return rows;
}

async function recordFollowupOutcome(contactId, body, actor) {
  await ensureFollowupSchema();
  const q = db();
  const found = await q(`SELECT contact_id, attempts, active, assignee FROM followups WHERE contact_id = $1`, [contactId]);
  if (!found.length) return { error: 'No encontramos ese contacto', code: 404 };
  if (actor.role === 'staff' && found[0].assignee !== actor.person) return { error: 'No autorizado', code: 403 };
  const decision = applyOutcome({
    active: found[0].active === true || found[0].active === 't' || found[0].active === 'true',
    attempts: Number(found[0].attempts) || 0,
  }, body && body.status, body && (body.comment != null ? body.comment : body.comentario));
  if (decision.error) return { error: decision.error, code: decision.code || 400 };
  const updated = await q(
    `UPDATE followups SET attempts = $1, outcome = $2, outcome_comment = $3, outcome_at = NOW(), active = $4, date_updated = NOW()
     WHERE contact_id = $5 AND active = TRUE AND attempts = $6
     RETURNING outcome, outcome_comment, outcome_at, attempts, active`,
    [decision.attempts, decision.outcome, decision.outcome_comment, decision.active, contactId, Number(found[0].attempts) || 0]
  );
  if (!updated.length) return { error: 'Este contacto ya cambió. Actualiza la lista.', code: 409 };
  const person = actor.role === 'admin' ? 'admin' : actor.person;
  for (const ev of decision.events) {
    await q(`INSERT INTO followup_outcomes (contact_id, status, comment, auto, person) VALUES ($1,$2,$3,$4,$5)`, [contactId, ev.status, ev.comment, !!ev.auto, person]);
  }
  const u = updated[0];
  const history = await historyFor(contactId, actor);
  const projected = projectFollowup({
    outcome_comment: u.outcome_comment,
    history,
  }, actor);
  return {
    success: true,
    dropped: decision.dropped,
    cold: !!decision.cold,
    attempts: Number(u.attempts) || 0,
    outcome: u.outcome,
    outcome_comment: projected.outcome_comment,
    outcome_at: u.outcome_at,
    active: u.active === true || u.active === 't' || u.active === 'true',
    history: projected.history,
  };
}

async function reassignFollowup(contactId, body, actor) {
  if (!actor || actor.role !== 'admin') return { error: 'No autorizado', code: 403 };
  await ensureFollowupSchema();
  const assignee = String((body && body.assignee) || '').trim().toLowerCase();
  if (!STAFF.includes(assignee)) return { error: 'Asignación no válida', code: 400 };
  const r = await db()(
    `UPDATE followups SET assignee = $1, date_updated = NOW() WHERE contact_id = $2 RETURNING contact_id, assignee`,
    [assignee, contactId]
  );
  if (!r.length) return { error: 'No encontramos ese contacto', code: 404 };
  return { success: true, contact_id: r[0].contact_id, assignee: r[0].assignee };
}

async function importFollowups(items) {
  await ensureFollowupSchema();
  const q = db();
  const clean = [];
  const seen = new Map();
  let skipped = 0;
  let dupes = 0;
  const skip_reasons = {};
  (items || []).forEach((item, index) => {
    const n = normalizeLead(item, index);
    if (!n.ok) {
      skipped++;
      skip_reasons[n.reason] = (skip_reasons[n.reason] || 0) + 1;
      return;
    }
    if (seen.has(n.row.contact_id)) {
      dupes++;
      clean[seen.get(n.row.contact_id)] = n.row;
      return;
    }
    seen.set(n.row.contact_id, clean.length);
    clean.push(n.row);
  });
  let inserted = 0;
  let updated = 0;
  const CHUNK = 150;
  for (let s = 0; s < clean.length; s += CHUNK) {
    const part = clean.slice(s, s + CHUNK);
    const col = (k) => part.map((r) => r[k]);
    const r = await q(`INSERT INTO followups (contact_id, name, phone, lifecycle, assignee, note, suggested_message, last_interaction, days_since, ciudad, sort_order)
      SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::timestamp[], $9::numeric[], $10::text[], $11::int[])
      ON CONFLICT (contact_id) DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        lifecycle = EXCLUDED.lifecycle,
        assignee = EXCLUDED.assignee,
        note = EXCLUDED.note,
        suggested_message = EXCLUDED.suggested_message,
        last_interaction = EXCLUDED.last_interaction,
        days_since = EXCLUDED.days_since,
        ciudad = EXCLUDED.ciudad,
        sort_order = EXCLUDED.sort_order,
        date_updated = NOW()
      RETURNING (xmax = 0) AS inserted`,
      [col('contact_id'), col('name'), col('phone'), col('lifecycle'), col('assignee'), col('note'), col('suggested_message'), col('last_interaction'), col('days_since'), col('ciudad'), col('sort_order')]);
    for (const row of r) { if (row.inserted === true || row.inserted === 't') inserted++; else updated++; }
  }
  return { inserted, updated, skipped, dupes, total: (items || []).length };
}

async function exportFollowups() {
  await ensureFollowupSchema();
  const q = db();
  const rows = await q(`SELECT f.contact_id, f.name, f.phone, f.lifecycle, f.assignee, f.note, f.suggested_message,
      f.last_interaction, f.days_since, f.ciudad, f.outcome, f.outcome_comment, f.outcome_at, f.attempts, f.active, f.sort_order,
      CASE WHEN f.last_interaction IS NOT NULL
        THEN ROUND((EXTRACT(EPOCH FROM (NOW() - f.last_interaction)) / 86400.0)::numeric, 1)
        ELSE f.days_since END AS days_since_now,
      f.date_added, f.date_updated,
      COALESCE(o.outcomes, '[]'::json) AS outcomes
    FROM followups f
    LEFT JOIN (
      SELECT contact_id, json_agg(json_build_object(
        'status', status, 'comment', comment, 'auto', auto, 'created_at', created_at, 'person', person
      ) ORDER BY created_at, id) AS outcomes
      FROM followup_outcomes
      GROUP BY contact_id
    ) o ON o.contact_id = f.contact_id
    ORDER BY f.sort_order ASC NULLS LAST, f.id ASC`);
  return {
    exported_at: new Date().toISOString(),
    count: rows.length,
    rows: rows.map((r) => {
      let outcomes = r.outcomes;
      if (typeof outcomes === 'string') { try { outcomes = JSON.parse(outcomes); } catch (e) { outcomes = []; } }
      return { ...shapeFollowup(r), date_added: r.date_added, date_updated: r.date_updated, outcomes: outcomes || [] };
    }),
  };
}

function bearerToken(req) {
  const header = req.headers.get('authorization') || '';
  return /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : '';
}

function importAuthorized(req) {
  const expected = process.env.FOLLOWUP_IMPORT_TOKEN || '';
  if (!expected) return false;
  const header = req.headers.get('authorization') || '';
  const token = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : (req.headers.get('x-import-token') || '');
  if (!token || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function readImportPayload(req) {
  const ctype = (req.headers.get('content-type') || '').toLowerCase();
  const text = await req.text();
  const trimmed = text.trim();
  if (!trimmed) return { rows: [] };
  const asCsv = ctype.includes('csv') || ctype.includes('text/plain') || (!trimmed.startsWith('[') && !trimmed.startsWith('{'));
  if (asCsv) return { rows: parseCsv(trimmed) };
  try {
    const body = JSON.parse(trimmed);
    if (typeof body.csv === 'string') return { rows: parseCsv(body.csv) };
    const list = Array.isArray(body) ? body : (body.rows || body.contacts || body.data || null);
    if (!Array.isArray(list)) return { error: 'El cuerpo debe ser un arreglo JSON o un CSV' };
    return { rows: list };
  } catch (e) {
    return { error: 'JSON no válido' };
  }
}

const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Import-Token', 'Content-Type': 'application/json' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: HEADERS });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: HEADERS });
  const url = new URL(req.url);
  const path = url.pathname.replace('/.netlify/functions/api', '').replace('/api', '') || '/';
  const method = req.method;
  // Public catalog link (no token): /catalogo
  const catMatch = url.pathname.match(/^\/catalogo(?:\/([a-z0-9-]+))?\/?$/);
  if (method === 'GET' && catMatch) {
    try { return await serveCatalog(catMatch[1] || null); } catch (err) { console.error('catalog', err); return new Response('Error', { status: 500 }); }
  }
  // Import/export use FOLLOWUP_IMPORT_TOKEN, not the app token baked into the page.
  // Staff and admin lists use each person's PIN. APP_TOKEN is rejected on both.
  if (path === '/followups/import' || path === '/followups/export') {
    if (!importAuthorized(req)) return json({ error: 'No autorizado' }, 401);
    try {
      if (method === 'POST' && path === '/followups/import') {
        const parsed = await readImportPayload(req);
        if (parsed.error) return json({ error: parsed.error }, 400);
        return json(await importFollowups(parsed.rows));
      }
      if (method === 'GET' && path === '/followups/export') return json(await exportFollowups());
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('followup import/export', err);
      return json({ error: err.message }, 500);
    }
  }
  const fuPinRoute = path === '/followups/login' || path === '/followups/summary' || path === '/followups' || /^\/followups\/[0-9]+\/(outcome|reassign)$/.test(path);
  if (fuPinRoute) {
    try {
      const readBody = async () => { try { return await req.json(); } catch (e) { return {}; } };
      if (method === 'POST' && path === '/followups/login') {
        const body = await readBody();
        const actor = followupActor(identifyFollowupPin(body && body.pin));
        if (!actor) return json({ error: 'PIN incorrecto' }, 401);
        return json({ ok: true, role: actor.role, person: actor.person });
      }
      const actor = followupActor(identifyFollowupPin(bearerToken(req)));
      if (!actor) return json({ error: 'No autorizado' }, 401);
      const qs = Object.fromEntries(url.searchParams);
      if (method === 'GET' && path === '/followups/summary') {
        if (actor.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        return json(await followupSummary());
      }
      if (method === 'GET' && path === '/followups') {
        const r = await listFollowups(qs, actor);
        return r.error ? json({ error: r.error }, r.code || 400) : json(r);
      }
      const fuOutcome = path.match(/^\/followups\/([0-9]+)\/outcome$/);
      if (method === 'POST' && fuOutcome) {
        const r = await recordFollowupOutcome(fuOutcome[1], await readBody(), actor);
        return r.error ? json({ error: r.error }, r.code || 400) : json(r);
      }
      const fuMove = path.match(/^\/followups\/([0-9]+)\/reassign$/);
      if (method === 'POST' && fuMove) {
        const r = await reassignFollowup(fuMove[1], await readBody(), actor);
        return r.error ? json({ error: r.error }, r.code || 400) : json(r);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('followup', err);
      return json({ error: err.message }, 500);
    }
  }
  const authHeader = req.headers.get('authorization') || '';
  if (authHeader.replace('Bearer ', '') !== (process.env.APP_TOKEN || 'sahiba2026')) {
    return json({ error: 'No autorizado' }, 401);
  }
  try {
    const qs = Object.fromEntries(url.searchParams);
    const readBody = async () => { try { return await req.json(); } catch (e) { return {}; } };

    if (method === 'POST' && path === '/init') return json(await initDB());

    if (method === 'POST' && path === '/upload-single') {
      const body = await readBody();
      return json(await uploadSingle(body.contacts || []));
    }
    if (method === 'POST' && path === '/upload') {
      const body = await readBody();
      const a = validAgent(body.agent);
      if (!a) return json({ error: 'agent required' }, 400);
      return json(await uploadContacts(a, body.contacts || []));
    }
    if (method === 'POST' && path === '/clear') {
      const body = await readBody();
      const a = validAgent(body.agent);
      if (!a) return json({ error: 'agent required' }, 400);
      const count = await db()(`DELETE FROM ${tbl(a)} RETURNING id`);
      return json({ cleared: count.length });
    }

    // History: contacted clients from both lists
    if (method === 'GET' && path === '/history') return json(await getHistory(qs));

    // Shared settings + catalog upload
    if (method === 'GET' && path === '/settings') return json(await getSettings());
    if (method === 'PUT' && path === '/settings') return json(await putSettings(await readBody()));
    if (method === 'GET' && path === '/catalogs') return json(await listCatalogs());
    if (method === 'POST' && path === '/catalog') {
      const r = await saveCatalog(req, qs);
      return r.error ? json({ error: r.error }, r.code) : json(r);
    }
    if (method === 'PUT' && path.startsWith('/catalogs/')) {
      const r = await updateCatalog(parseInt(path.split('/').pop(), 10), await readBody());
      return r.error ? json({ error: r.error }, r.code) : json(r);
    }
    if (method === 'DELETE' && path.startsWith('/catalogs/')) {
      const r = await deleteCatalog(parseInt(path.split('/').pop(), 10));
      return r.error ? json({ error: r.error }, r.code) : json(r);
    }

    // Nancy Hot & Payment list
    if (method === 'GET' && path === '/hot/contacts') return json(await getHotContacts(qs));
    if (method === 'POST' && path === '/hot/upload') {
      const body = await readBody();
      return json(await uploadHot(body.contacts || [], body.replace !== false));
    }
    // Full reset: every contact list, history and follow-up table. Settings (message templates) and catalogs are kept.
    if (method === 'POST' && path === '/reset-all') {
      const body = await readBody();
      if (body.confirm !== 'BORRAR TODO') return json({ error: 'confirm required' }, 400);
      const q = db(); const out = {};
      for (const tname of [...AGENTS.map(tbl), ...AGENTS.map(htbl), 'hot_contacts', 'followup_outcomes', 'followups']) {
        try { out[tname] = (await q(`DELETE FROM ${tname} RETURNING 1`)).length; } catch (e) { out[tname] = 'skip: ' + e.message.slice(0, 40); }
      }
      return json({ success: true, cleared: out });
    }
    if (method === 'POST' && path === '/hot/clear') {
      const r = await db()(`DELETE FROM hot_contacts RETURNING id`);
      return json({ cleared: r.length });
    }
    if (method === 'PUT' && path.startsWith('/hot/contact/')) {
      const id = parseInt(path.split('/').pop());
      const body = await readBody();
      const r = await updateHotContact(id, body);
      return r.error ? json({ error: r.error }, r.code) : json(r);
    }

    const agent = validAgent(qs.agent);
    if (method === 'GET' && path === '/contacts') {
      if (!agent) return json({ error: 'agent required' }, 400);
      if (agent !== 'yoana') await handoffToNancy();
      return json(await getContacts(agent, qs));
    }
    if (method === 'GET' && path === '/historial') {
      if (!agent) return json({ error: 'agent required' }, 400);
      return json(await getHistorial(agent, qs));
    }
    if (method === 'PUT' && path.startsWith('/contact/')) {
      const id = parseInt(path.split('/').pop());
      const body = await readBody();
      const a = validAgent(body.agent || qs.agent);
      if (!a) return json({ error: 'agent required' }, 400);
      const r = await updateContact(a, id, body);
      return r.error ? json({ error: r.error }, r.code) : json(r);
    }
    if (method === 'GET' && path === '/stats') {
      if (!agent) return json({ error: 'agent required' }, 400);
      if (agent !== 'yoana') await handoffToNancy();
      return json(await getStats(agent));
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    console.error('Error:', err);
    return json({ error: err.message, type: err.constructor.name }, 500);
  }
};

export const config = { path: ['/.netlify/functions/api', '/.netlify/functions/api/*', '/catalogo', '/catalogo/*'] };
