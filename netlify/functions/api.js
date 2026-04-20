const { neon } = require("@neondatabase/serverless");

function db() {
  const u = process.env.DATABASE_URL;
  if (!u) throw new Error("DATABASE_URL not set");
  return neon(u);
}

function tbl(a) { return a === 'jazmin' ? 'jazmin_contacts' : 'nancy_contacts'; }
function otbl(a) { return a === 'jazmin' ? 'nancy_contacts' : 'jazmin_contacts'; }
function htbl(a) { return a === 'jazmin' ? 'jazmin_historial' : 'nancy_historial'; }
function validAgent(a) { return ['nancy','jazmin'].includes((a||'').toLowerCase()) ? a.toLowerCase() : null; }

async function initDB() {
  const q = db();
  for (const t of ['nancy_contacts','jazmin_contacts']) {
    await q(`CREATE TABLE IF NOT EXISTS ${t} (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE NOT NULL, name VARCHAR(200), buy_score INTEGER, win_status VARCHAR(50), agent VARCHAR(100), city VARCHAR(200), lifecycle VARCHAR(100), reasons TEXT, hours_since INTEGER, crm_score INTEGER, priority VARCHAR(10), status VARCHAR(50) DEFAULT 'Pendiente', notes TEXT DEFAULT '', whatsapp_sent BOOLEAN DEFAULT FALSE, whatsapp_sent_date TIMESTAMP, date_added TIMESTAMP DEFAULT NOW(), date_updated TIMESTAMP DEFAULT NOW(), is_new BOOLEAN DEFAULT TRUE, batch_date DATE DEFAULT CURRENT_DATE)`);
  }
  for (const t of ['nancy_historial','jazmin_historial']) {
    await q(`CREATE TABLE IF NOT EXISTS ${t} (id SERIAL PRIMARY KEY, phone VARCHAR(20) NOT NULL, name VARCHAR(200), agent VARCHAR(100), city VARCHAR(200), lifecycle VARCHAR(100), crm_score INTEGER, status VARCHAR(50), notes TEXT, whatsapp_sent BOOLEAN DEFAULT FALSE, whatsapp_sent_date TIMESTAMP, date_added TIMESTAMP, date_archived TIMESTAMP DEFAULT NOW())`);
  }
  // Add columns if missing
  for (const t of ['nancy_contacts','jazmin_contacts']) {
    try { await q(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS whatsapp_sent_date TIMESTAMP`); } catch(e) {}
    try { await q(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS last_contact_date TIMESTAMP`); } catch(e) {}
  }
  for (const t of ['nancy_historial','jazmin_historial']) {
    try { await q(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS whatsapp_sent_date TIMESTAMP`); } catch(e) {}
  }
  return { success: true };
}

// Dynamic hours calculation: EXTRACT(EPOCH FROM (NOW() - last_contact_date))/3600
// Falls back to static hours_since if last_contact_date is NULL
const hoursSinceExpr = `COALESCE(EXTRACT(EPOCH FROM (NOW() - last_contact_date))/3600, hours_since, 0)`;
const cols = `id, phone, name, buy_score, win_status, agent, city, lifecycle, reasons, ROUND(${hoursSinceExpr})::int as hours_since, crm_score, priority, status, notes, whatsapp_sent, COALESCE(whatsapp_sent_date, NULL)::timestamp as whatsapp_sent_date, date_added, date_updated, is_new, batch_date`;

// JAZMIN VIEW: contacts where dynamic hours < 85 OR customers
async function getJazminContacts(filters) {
  const q = db();
  const { status, search } = filters || {};
  let sql = `SELECT ${cols}, 'jazmin' as source FROM jazmin_contacts WHERE (crm_score IS NULL OR crm_score >= 400) AND ((${hoursSinceExpr}) < 85 OR (lifecycle IS NOT NULL AND LOWER(lifecycle) = 'customer'))`;
  const p = []; let i = 1;
  if (status && status !== 'all') { sql += ` AND status = $${i++}`; p.push(status); }
  if (search) { sql += ` AND (name ILIKE $${i} OR phone ILIKE $${i})`; p.push('%'+search+'%'); i++; }
  sql += ` ORDER BY is_new DESC, crm_score DESC NULLS LAST, date_added DESC`;
  return await q(sql, p);
}

// NANCY VIEW: her contacts + jazmin handoffs (dynamic hours >= 85, non-customer, no duplicates)
async function getNancyContacts(filters) {
  const q = db();
  const { status, search } = filters || {};
  let sql1 = `SELECT ${cols}, 'nancy' as source FROM nancy_contacts WHERE (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= 400)`;
  let sql2 = `SELECT ${cols}, 'jazmin_handoff' as source FROM jazmin_contacts WHERE (${hoursSinceExpr}) >= 85 AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= 400) AND phone NOT IN (SELECT phone FROM nancy_contacts)`;
  let sql = `SELECT * FROM ((${sql1}) UNION ALL (${sql2})) combined WHERE 1=1`;
  const p = []; let i = 1;
  if (status && status !== 'all') { sql += ` AND status = $${i++}`; p.push(status); }
  if (search) { sql += ` AND (name ILIKE $${i} OR phone ILIKE $${i})`; p.push('%'+search+'%'); i++; }
  sql += ` ORDER BY is_new DESC, crm_score DESC NULLS LAST, date_added DESC`;
  return await q(sql, p);
}

async function getContacts(agent, filters) {
  if (agent === 'jazmin') return getJazminContacts(filters);
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

async function uploadContacts(agent, contacts) {
  const q = db();
  const t = tbl(agent);
  const ot = otbl(agent);
  const ht = htbl(agent);
  let newCount=0, updatedCount=0, archivedCount=0, skippedCount=0, cleanedCount=0, dupCount=0;

  // Archive contacts with notes
  const withNotes = await q(`SELECT * FROM ${t} WHERE notes IS NOT NULL AND notes != ''`);
  for (const c of withNotes) {
    await q(`INSERT INTO ${ht} (phone,name,agent,city,lifecycle,crm_score,status,notes,whatsapp_sent,whatsapp_sent_date,date_added) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [c.phone,c.name,c.agent,c.city,c.lifecycle,c.crm_score,c.status,c.notes,c.whatsapp_sent,c.whatsapp_sent_date,c.date_added]);
    archivedCount++;
  }

  // Clean existing low score (but keep customers)
  const c2 = await q(`DELETE FROM ${t} WHERE crm_score IS NOT NULL AND crm_score < 400 AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') RETURNING id`);
  cleanedCount = c2.length;

  // Mark not new
  await q(`UPDATE ${t} SET is_new = FALSE WHERE is_new = TRUE`);

  for (const c of contacts) {
    const phone = String(c.phone||'').replace(/[^0-9]/g,'');
    if (!phone) continue;
    const isCustomer = c.lifecycle && String(c.lifecycle).toLowerCase().trim() === 'customer';
    if (!isCustomer && c.crm_score && Number(c.crm_score) < 400) { skippedCount++; continue; }

    // Check for duplicate in OTHER agent's table — skip if exists there
    const inOther = await q(`SELECT id FROM ${ot} WHERE phone = $1`, [phone]);
    if (inOther.length > 0) { dupCount++; continue; }

    // Calculate last_contact_date from hours_since
    const lastContactDate = c.hours_since ? `NOW() - INTERVAL '${parseInt(c.hours_since)} hours'` : 'NULL';

    const existing = await q(`SELECT id FROM ${t} WHERE phone = $1`, [phone]);
    if (existing.length > 0) {
      await q(`UPDATE ${t} SET name=$1,buy_score=$2,win_status=$3,agent=$4,city=$5,lifecycle=$6,reasons=$7,hours_since=$8,crm_score=$9,priority=$10,last_contact_date=${lastContactDate},date_updated=NOW(),batch_date=CURRENT_DATE WHERE phone=$11`,
        [c.name||null,c.buy_score||null,c.window||null,c.agent||null,c.city||null,c.lifecycle||null,c.reasons||null,c.hours_since||null,c.crm_score||null,c.priority||null,phone]);
      updatedCount++;
    } else {
      await q(`INSERT INTO ${t} (phone,name,buy_score,win_status,agent,city,lifecycle,reasons,hours_since,crm_score,priority,last_contact_date,status,is_new,batch_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${lastContactDate},'Pendiente',TRUE,CURRENT_DATE)`,
        [phone,c.name||null,c.buy_score||null,c.window||null,c.agent||null,c.city||null,c.lifecycle||null,c.reasons||null,c.hours_since||null,c.crm_score||null,c.priority||null]);
      newCount++;
    }
  }
  return { newCount, updatedCount, archivedCount, skippedCount, cleanedCount, dupCount, total: contacts.length };
}

async function updateContact(agent, id, updates) {
  const q = db();
  let t = tbl(agent);
  if (agent === 'nancy') {
    const inNancy = await q(`SELECT id FROM nancy_contacts WHERE id = $1`, [id]);
    if (inNancy.length === 0) t = 'jazmin_contacts';
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
  const nf = `(lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= 400)`;
  const jf = `(${hoursSinceExpr}) >= 85 AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') AND (crm_score IS NULL OR crm_score >= 400) AND phone NOT IN (SELECT phone FROM nancy_contacts)`;
  const total1 = await q(`SELECT COUNT(*) as count FROM nancy_contacts WHERE ${nf}`);
  const total2 = await q(`SELECT COUNT(*) as count FROM jazmin_contacts WHERE ${jf}`);
  const totalCount = parseInt(total1[0].count) + parseInt(total2[0].count);
  const byStatus = await q(`SELECT status, SUM(cnt)::int as count FROM (SELECT status, COUNT(*) as cnt FROM nancy_contacts WHERE ${nf} GROUP BY status UNION ALL SELECT status, COUNT(*) as cnt FROM jazmin_contacts WHERE ${jf} GROUP BY status) sub GROUP BY status ORDER BY count DESC`);
  const newN = await q(`SELECT COUNT(*) as count FROM nancy_contacts WHERE is_new = TRUE AND ${nf}`);
  const newJ = await q(`SELECT COUNT(*) as count FROM jazmin_contacts WHERE is_new = TRUE AND ${jf}`);
  const newCount = parseInt(newN[0].count) + parseInt(newJ[0].count);
  const byAgent = await q(`SELECT agent, SUM(cnt)::int as count FROM (SELECT agent, COUNT(*) as cnt FROM nancy_contacts WHERE ${nf} GROUP BY agent UNION ALL SELECT agent, COUNT(*) as cnt FROM jazmin_contacts WHERE ${jf} GROUP BY agent) sub GROUP BY agent ORDER BY count DESC`);
  const histCount = await q(`SELECT COUNT(*) as count FROM nancy_historial`);
  return { total: totalCount, newToday: newCount, byStatus, byAgent, historialCount: histCount[0].count };
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
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
    const agent = validAgent(qs.agent || (method !== 'GET' ? (JSON.parse(event.body || '{}').agent) : null));
    if (method === 'GET' && path === '/contacts') {
      if (!agent) return { statusCode: 400, headers, body: JSON.stringify({ error: 'agent required' }) };
      return { statusCode: 200, headers, body: JSON.stringify(await getContacts(agent, qs)) };
    }
    if (method === 'GET' && path === '/historial') {
      if (!agent) return { statusCode: 400, headers, body: JSON.stringify({ error: 'agent required' }) };
      return { statusCode: 200, headers, body: JSON.stringify(await getHistorial(agent, qs)) };
    }
    if (method === 'POST' && path === '/upload') {
      const body = JSON.parse(event.body);
      const a = validAgent(body.agent);
      if (!a) return { statusCode: 400, headers, body: JSON.stringify({ error: 'agent required' }) };
      return { statusCode: 200, headers, body: JSON.stringify(await uploadContacts(a, body.contacts || [])) };
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
