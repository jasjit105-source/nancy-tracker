const { neon } = require("@neondatabase/serverless");

function db() {
  const u = process.env.DATABASE_URL;
  if (!u) throw new Error("DATABASE_URL not set");
  return neon(u);
}

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
  return { success: true };
}

const hoursSinceExpr = `COALESCE(EXTRACT(EPOCH FROM (NOW() - last_contact_date))/3600, hours_since, 0)`;
const cols = `id, phone, name, buy_score, win_status, agent, city, lifecycle, reasons, ROUND(${hoursSinceExpr})::int as hours_since, crm_score, priority, status, notes, whatsapp_sent, COALESCE(whatsapp_sent_date, NULL)::timestamp as whatsapp_sent_date, date_added, date_updated, is_new, batch_date, buy_pct, reason_to_buy`;

async function getJazminContacts(filters) {
  const q = db();
  const { status, search } = filters || {};
  let sql = `SELECT ${cols}, 'jazmin' as source FROM jazmin_contacts WHERE (crm_score IS NULL OR crm_score >= 400) AND ((${hoursSinceExpr}) < 85 OR (lifecycle IS NOT NULL AND LOWER(lifecycle) = 'customer'))`;
  const p = []; let i = 1;
  if (status && status !== 'all') { sql += ` AND status = $${i++}`; p.push(status); }
  if (search) { sql += ` AND (name ILIKE $${i} OR phone ILIKE $${i})`; p.push('%'+search+'%'); i++; }
  sql += ` ORDER BY is_new DESC, buy_pct DESC NULLS LAST, crm_score DESC NULLS LAST`;
  return await q(sql, p);
}

async function getNancyContacts(filters) {
  const q = db();
  const { status, search } = filters || {};
  let sql1 = `SELECT ${cols}, 'nancy' as source FROM nancy_contacts WHERE (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= 400)`;
  let sql2 = `SELECT ${cols}, 'jazmin_handoff' as source FROM jazmin_contacts WHERE (${hoursSinceExpr}) >= 85 AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= 400) AND phone NOT IN (SELECT phone FROM nancy_contacts)`;
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
  let sql = `SELECT ${cols}, 'yoana' as source FROM yoana_contacts WHERE (crm_score IS NULL OR crm_score >= 400)`;
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
function calcBuyPct(buyScore) {
  if (!buyScore) return 0;
  return Math.round((buyScore / 165) * 100);
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

  // Archive contacts with notes from all tables
  for (const a of AGENTS) {
    const t = tbl(a);
    const ht = htbl(a);
    const withNotes = await q(`SELECT * FROM ${t} WHERE notes IS NOT NULL AND notes != ''`);
    for (const c of withNotes) {
      await q(`INSERT INTO ${ht} (phone,name,agent,city,lifecycle,crm_score,status,notes,whatsapp_sent,whatsapp_sent_date,date_added) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [c.phone,c.name,c.agent,c.city,c.lifecycle,c.crm_score,c.status,c.notes,c.whatsapp_sent,c.whatsapp_sent_date,c.date_added]);
      result.archived++;
    }
    // Clean low score non-customers
    await q(`DELETE FROM ${t} WHERE crm_score IS NOT NULL AND crm_score < 400 AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer')`);
    // Mark not new
    await q(`UPDATE ${t} SET is_new = FALSE WHERE is_new = TRUE`);
  }

  // Track all phones we've processed to prevent dupes within this upload
  const processed = new Set();

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
    if (!isCustomer && score < 400) { result.skipped++; continue; }

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
    const buyPct = calcBuyPct(c.buy_score);
    const reasonToBuy = calcReason(c);
    const lastContactDate = hours ? `NOW() - INTERVAL '${parseInt(hours)} hours'` : 'NULL';

    // Check if phone exists in ANY agent table (prevent cross-table dupes)
    let exists = false;
    for (const a of AGENTS) {
      const found = await q(`SELECT id FROM ${tbl(a)} WHERE phone = $1`, [phone]);
      if (found.length > 0) {
        // Update in place if it's the same target, skip if different
        if (a === targetAgent) {
          await q(`UPDATE ${tbl(a)} SET name=$1,buy_score=$2,win_status=$3,agent=$4,city=$5,lifecycle=$6,reasons=$7,hours_since=$8,crm_score=$9,priority=$10,last_contact_date=${lastContactDate},buy_pct=$11,reason_to_buy=$12,date_updated=NOW(),batch_date=CURRENT_DATE WHERE phone=$13`,
            [c.name||null,c.buy_score||null,c.window||null,c.agent||null,c.city||null,c.lifecycle||null,c.reasons||null,hours||null,score||null,c.priority||null,buyPct,reasonToBuy,phone]);
          result[targetAgent].upd++;
        } else {
          result.dupes++;
        }
        exists = true;
        break;
      }
    }

    if (!exists) {
      await q(`INSERT INTO ${t} (phone,name,buy_score,win_status,agent,city,lifecycle,reasons,hours_since,crm_score,priority,last_contact_date,buy_pct,reason_to_buy,status,is_new,batch_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${lastContactDate},$12,$13,'Pendiente',TRUE,CURRENT_DATE)`,
        [phone,c.name||null,c.buy_score||null,c.window||null,c.agent||null,c.city||null,c.lifecycle||null,c.reasons||null,hours||null,score||null,c.priority||null,buyPct,reasonToBuy]);
      result[targetAgent].new++;
    }
  }
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
  let sets = ['date_updated = NOW()'], p = [], i = 1;
  if (status) { sets.push(`status = $${i++}`); p.push(status); }
  if (notes !== undefined) { sets.push(`notes = $${i++}`); p.push(notes); }
  if (whatsapp_sent !== undefined) { sets.push(`whatsapp_sent = $${i++}`); p.push(whatsapp_sent); if (whatsapp_sent) sets.push('whatsapp_sent_date = NOW()'); }
  p.push(id);
  await q(`UPDATE ${t} SET ${sets.join(', ')} WHERE id = $${i}`, p);
  return { success: true };
}

async function getStats(agent) {
  const q = db();
  if (agent === 'jazmin') {
    const f = `(crm_score IS NULL OR crm_score >= 400) AND ((${hoursSinceExpr}) < 85 OR (lifecycle IS NOT NULL AND LOWER(lifecycle) = 'customer'))`;
    const total = await q(`SELECT COUNT(*) as count FROM jazmin_contacts WHERE ${f}`);
    const byStatus = await q(`SELECT status, COUNT(*) as count FROM jazmin_contacts WHERE ${f} GROUP BY status ORDER BY count DESC`);
    const newToday = await q(`SELECT COUNT(*) as count FROM jazmin_contacts WHERE is_new = TRUE AND ${f}`);
    const byAgent = await q(`SELECT agent, COUNT(*) as count FROM jazmin_contacts WHERE ${f} GROUP BY agent ORDER BY count DESC`);
    const histCount = await q(`SELECT COUNT(*) as count FROM jazmin_historial`);
    return { total: total[0].count, newToday: newToday[0].count, byStatus, byAgent, historialCount: histCount[0].count };
  }
  if (agent === 'yoana') {
    const f = `(crm_score IS NULL OR crm_score >= 400)`;
    const total = await q(`SELECT COUNT(*) as count FROM yoana_contacts WHERE ${f}`);
    const byStatus = await q(`SELECT status, COUNT(*) as count FROM yoana_contacts WHERE ${f} GROUP BY status ORDER BY count DESC`);
    const newToday = await q(`SELECT COUNT(*) as count FROM yoana_contacts WHERE is_new = TRUE AND ${f}`);
    const byAgent = await q(`SELECT agent, COUNT(*) as count FROM yoana_contacts WHERE ${f} GROUP BY agent ORDER BY count DESC`);
    const histCount = await q(`SELECT COUNT(*) as count FROM yoana_historial`);
    return { total: total[0].count, newToday: newToday[0].count, byStatus, byAgent, historialCount: histCount[0].count };
  }
  // Nancy: her table + jazmin handoffs
  const nf = `(lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= 400)`;
  const jf = `(${hoursSinceExpr}) >= 85 AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= 400) AND phone NOT IN (SELECT phone FROM nancy_contacts)`;
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

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (authHeader.replace('Bearer ', '') !== (process.env.APP_TOKEN || 'sahiba2026')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'No autorizado' }) };
  }
  try {
    const path = event.path.replace('/.netlify/functions/api', '').replace('/api', '') || '/';
    const method = event.httpMethod;
    const qs = event.queryStringParameters || {};
    if (method === 'POST' && path === '/init') return { statusCode: 200, headers, body: JSON.stringify(await initDB()) };
    
    if (method === 'POST' && path === '/upload-single') {
      const body = JSON.parse(event.body);
      return { statusCode: 200, headers, body: JSON.stringify(await uploadSingle(body.contacts || [])) };
    }
    if (method === 'POST' && path === '/upload') {
      const body = JSON.parse(event.body);
      const a = validAgent(body.agent);
      if (!a) return { statusCode: 400, headers, body: JSON.stringify({ error: 'agent required' }) };
      return { statusCode: 200, headers, body: JSON.stringify(await uploadContacts(a, body.contacts || [])) };
    }
    if (method === 'POST' && path === '/clear') {
      const body = JSON.parse(event.body);
      const a = validAgent(body.agent);
      if (!a) return { statusCode: 400, headers, body: JSON.stringify({ error: 'agent required' }) };
      const count = await db()(`DELETE FROM ${tbl(a)} RETURNING id`);
      return { statusCode: 200, headers, body: JSON.stringify({ cleared: count.length }) };
    }

    const agent = validAgent(qs.agent);
    if (method === 'GET' && path === '/contacts') {
      if (!agent) return { statusCode: 400, headers, body: JSON.stringify({ error: 'agent required' }) };
      return { statusCode: 200, headers, body: JSON.stringify(await getContacts(agent, qs)) };
    }
    if (method === 'GET' && path === '/historial') {
      if (!agent) return { statusCode: 400, headers, body: JSON.stringify({ error: 'agent required' }) };
      return { statusCode: 200, headers, body: JSON.stringify(await getHistorial(agent, qs)) };
    }
    if (method === 'PUT' && path.startsWith('/contact/')) {
      const id = parseInt(path.split('/').pop());
      const body = JSON.parse(event.body);
      const a = validAgent(body.agent || qs.agent);
      if (!a) return { statusCode: 400, headers, body: JSON.stringify({ error: 'agent required' }) };
      return { statusCode: 200, headers, body: JSON.stringify(await updateContact(a, id, body)) };
    }
    if (method === 'GET' && path === '/stats') {
      if (!agent) return { statusCode: 400, headers, body: JSON.stringify({ error: 'agent required' }) };
      return { statusCode: 200, headers, body: JSON.stringify(await getStats(agent)) };
    }
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
  } catch (err) {
    console.error('Error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, type: err.constructor.name }) };
  }
};
