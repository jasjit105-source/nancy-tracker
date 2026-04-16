const { neon } = require("@neondatabase/serverless");

const DATABASE_URL = process.env.DATABASE_URL;

function sql() {
  return neon(DATABASE_URL);
}

async function initDB() {
  const db = sql();
  await db`
    CREATE TABLE IF NOT EXISTS nancy_contacts (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) UNIQUE NOT NULL,
      name VARCHAR(200),
      buy_score INTEGER,
      window VARCHAR(50),
      agent VARCHAR(100),
      city VARCHAR(200),
      lifecycle VARCHAR(100),
      reasons TEXT,
      hours_since INTEGER,
      crm_score INTEGER,
      priority VARCHAR(10),
      status VARCHAR(50) DEFAULT 'Pendiente',
      notes TEXT DEFAULT '',
      whatsapp_sent BOOLEAN DEFAULT FALSE,
      date_added TIMESTAMP DEFAULT NOW(),
      date_updated TIMESTAMP DEFAULT NOW(),
      is_new BOOLEAN DEFAULT TRUE,
      batch_date DATE DEFAULT CURRENT_DATE
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS idx_nancy_phone ON nancy_contacts(phone)`;
  await db`CREATE INDEX IF NOT EXISTS idx_nancy_status ON nancy_contacts(status)`;
  return { success: true };
}

async function getContacts(filters) {
  const db = sql();
  const { status, search, agent } = filters || {};

  let query = `SELECT * FROM nancy_contacts WHERE 1=1`;
  const params = [];
  let paramIdx = 1;

  if (status && status !== "all") {
    query += ` AND status = $${paramIdx++}`;
    params.push(status);
  }
  if (agent && agent !== "all") {
    query += ` AND agent = $${paramIdx++}`;
    params.push(agent);
  }
  if (search) {
    query += ` AND (name ILIKE $${paramIdx} OR phone ILIKE $${paramIdx})`;
    params.push(`%${search}%`);
    paramIdx++;
  }

  query += ` ORDER BY is_new DESC, crm_score DESC NULLS LAST, date_added DESC`;

  // Use tagged template for simple case, raw for dynamic
  const result = await db(query, params);
  return result;
}

async function uploadContacts(contacts) {
  const db = sql();
  let newCount = 0;
  let updatedCount = 0;

  // Mark all existing as not new before merge
  await db`UPDATE nancy_contacts SET is_new = FALSE WHERE is_new = TRUE`;

  for (const c of contacts) {
    const phone = String(c.phone || "").replace(/[^0-9]/g, "");
    if (!phone) continue;

    const existing = await db`SELECT id, status FROM nancy_contacts WHERE phone = ${phone}`;

    if (existing.length > 0) {
      // Update data fields but preserve status and notes
      await db`
        UPDATE nancy_contacts SET
          name = ${c.name || null},
          buy_score = ${c.buy_score || null},
          window = ${c.window || null},
          agent = ${c.agent || null},
          city = ${c.city || null},
          lifecycle = ${c.lifecycle || null},
          reasons = ${c.reasons || null},
          hours_since = ${c.hours_since || null},
          crm_score = ${c.crm_score || null},
          priority = ${c.priority || null},
          date_updated = NOW(),
          batch_date = CURRENT_DATE
        WHERE phone = ${phone}
      `;
      updatedCount++;
    } else {
      await db`
        INSERT INTO nancy_contacts (phone, name, buy_score, window, agent, city, lifecycle, reasons, hours_since, crm_score, priority, status, is_new, batch_date)
        VALUES (${phone}, ${c.name || null}, ${c.buy_score || null}, ${c.window || null}, ${c.agent || null}, ${c.city || null}, ${c.lifecycle || null}, ${c.reasons || null}, ${c.hours_since || null}, ${c.crm_score || null}, ${c.priority || null}, 'Pendiente', TRUE, CURRENT_DATE)
      `;
      newCount++;
    }
  }

  return { newCount, updatedCount, total: contacts.length };
}

async function updateContact(id, updates) {
  const db = sql();
  const { status, notes, whatsapp_sent } = updates;

  await db`
    UPDATE nancy_contacts SET
      status = COALESCE(${status || null}, status),
      notes = COALESCE(${notes !== undefined ? notes : null}, notes),
      whatsapp_sent = COALESCE(${whatsapp_sent !== undefined ? whatsapp_sent : null}, whatsapp_sent),
      date_updated = NOW()
    WHERE id = ${id}
  `;

  return { success: true };
}

async function getStats() {
  const db = sql();
  const total = await db`SELECT COUNT(*) as count FROM nancy_contacts`;
  const byStatus = await db`SELECT status, COUNT(*) as count FROM nancy_contacts GROUP BY status ORDER BY count DESC`;
  const newToday = await db`SELECT COUNT(*) as count FROM nancy_contacts WHERE is_new = TRUE`;
  const byAgent = await db`SELECT agent, COUNT(*) as count FROM nancy_contacts GROUP BY agent ORDER BY count DESC`;
  return {
    total: total[0].count,
    newToday: newToday[0].count,
    byStatus,
    byAgent
  };
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // Simple auth check
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace("Bearer ", "");
  const validToken = process.env.APP_TOKEN || "sahiba2026";

  if (token !== validToken) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: "No autorizado" })
    };
  }

  try {
    const path = event.path.replace("/.netlify/functions/api", "").replace("/api", "") || "/";
    const method = event.httpMethod;

    // POST /init
    if (method === "POST" && path === "/init") {
      const result = await initDB();
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // GET /contacts
    if (method === "GET" && path === "/contacts") {
      const params = event.queryStringParameters || {};
      const result = await getContacts(params);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // POST /upload
    if (method === "POST" && path === "/upload") {
      const body = JSON.parse(event.body);
      const result = await uploadContacts(body.contacts || []);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // PUT /contact/:id
    if (method === "PUT" && path.startsWith("/contact/")) {
      const id = parseInt(path.split("/").pop());
      const body = JSON.parse(event.body);
      const result = await updateContact(id, body);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // GET /stats
    if (method === "GET" && path === "/stats") {
      const result = await getStats();
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: "Not found" }) };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
