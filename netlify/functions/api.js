const { neon } = require("@neondatabase/serverless");

function sql() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set in environment");
  return neon(dbUrl);
}

async function initDB() {
  const db = sql();
  await db`
    CREATE TABLE IF NOT EXISTS nancy_contacts (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) UNIQUE NOT NULL,
      name VARCHAR(200),
      buy_score INTEGER,
      win_status VARCHAR(50),
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
  await db`
    CREATE TABLE IF NOT EXISTS nancy_historial (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) NOT NULL,
      name VARCHAR(200),
      agent VARCHAR(100),
      city VARCHAR(200),
      lifecycle VARCHAR(100),
      crm_score INTEGER,
      status VARCHAR(50),
      notes TEXT,
      whatsapp_sent BOOLEAN DEFAULT FALSE,
      date_added TIMESTAMP,
      date_archived TIMESTAMP DEFAULT NOW()
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS idx_nancy_phone ON nancy_contacts(phone)`;
  await db`CREATE INDEX IF NOT EXISTS idx_nancy_status ON nancy_contacts(status)`;
  await db`CREATE INDEX IF NOT EXISTS idx_historial_phone ON nancy_historial(phone)`;
  return { success: true };
}

async function getContacts(filters) {
  const db = sql();
  const { status, search, agent, view } = filters || {};

  // Default view excludes Customer lifecycle
  let query = `SELECT * FROM nancy_contacts WHERE 1=1`;
  const params = [];
  let paramIdx = 1;

  if (view !== 'all') {
    query += ` AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer')`;
  }

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

  const result = await db(query, params);
  return result;
}

async function getHistorial(filters) {
  const db = sql();
  const { search } = filters || {};

  let query = `SELECT * FROM nancy_historial WHERE 1=1`;
  const params = [];
  let paramIdx = 1;

  if (search) {
    query += ` AND (name ILIKE $${paramIdx} OR phone ILIKE $${paramIdx})`;
    params.push(`%${search}%`);
    paramIdx++;
  }

  query += ` ORDER BY date_archived DESC`;

  const result = await db(query, params);
  return result;
}

async function uploadContacts(contacts) {
  const db = sql();
  let newCount = 0;
  let updatedCount = 0;
  let archivedCount = 0;
  let skippedCustomers = 0;

  // Before merge: archive contacts that have notes to historial
  const withNotes = await db`SELECT * FROM nancy_contacts WHERE notes IS NOT NULL AND notes != ''`;
  for (const c of withNotes) {
    await db`
      INSERT INTO nancy_historial (phone, name, agent, city, lifecycle, crm_score, status, notes, whatsapp_sent, date_added)
      VALUES (${c.phone}, ${c.name}, ${c.agent}, ${c.city}, ${c.lifecycle}, ${c.crm_score}, ${c.status}, ${c.notes}, ${c.whatsapp_sent}, ${c.date_added})
    `;
    archivedCount++;
  }

  // Mark all existing as not new before merge
  await db`UPDATE nancy_contacts SET is_new = FALSE WHERE is_new = TRUE`;

  for (const c of contacts) {
    const phone = String(c.phone || "").replace(/[^0-9]/g, "");
    if (!phone) continue;

    // Skip customers
    if (c.lifecycle && String(c.lifecycle).toLowerCase().trim() === 'customer') {
      skippedCustomers++;
      continue;
    }

    const existing = await db`SELECT id, status FROM nancy_contacts WHERE phone = ${phone}`;

    if (existing.length > 0) {
      await db`
        UPDATE nancy_contacts SET
          name = ${c.name || null},
          buy_score = ${c.buy_score || null},
          win_status = ${c.window || null},
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
        INSERT INTO nancy_contacts (phone, name, buy_score, win_status, agent, city, lifecycle, reasons, hours_since, crm_score, priority, status, is_new, batch_date)
        VALUES (${phone}, ${c.name || null}, ${c.buy_score || null}, ${c.window || null}, ${c.agent || null}, ${c.city || null}, ${c.lifecycle || null}, ${c.reasons || null}, ${c.hours_since || null}, ${c.crm_score || null}, ${c.priority || null}, 'Pendiente', TRUE, CURRENT_DATE)
      `;
      newCount++;
    }
  }

  return { newCount, updatedCount, archivedCount, skippedCustomers, total: contacts.length };
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
  const total = await db`SELECT COUNT(*) as count FROM nancy_contacts WHERE (lifecycle IS NULL OR LOWER(lifecycle) != 'customer')`;
  const byStatus = await db`SELECT status, COUNT(*) as count FROM nancy_contacts WHERE (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') GROUP BY status ORDER BY count DESC`;
  const newToday = await db`SELECT COUNT(*) as count FROM nancy_contacts WHERE is_new = TRUE AND (lifecycle IS NULL OR LOWER(lifecycle) != 'customer')`;
  const byAgent = await db`SELECT agent, COUNT(*) as count FROM nancy_contacts WHERE (lifecycle IS NULL OR LOWER(lifecycle) != 'customer') GROUP BY agent ORDER BY count DESC`;
  const historialCount = await db`SELECT COUNT(*) as count FROM nancy_historial`;
  return {
    total: total[0].count,
    newToday: newToday[0].count,
    byStatus,
    byAgent,
    historialCount: historialCount[0].count
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

    if (method === "POST" && path === "/init") {
      const result = await initDB();
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (method === "GET" && path === "/contacts") {
      const params = event.queryStringParameters || {};
      const result = await getContacts(params);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (method === "GET" && path === "/historial") {
      const params = event.queryStringParameters || {};
      const result = await getHistorial(params);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (method === "POST" && path === "/upload") {
      const body = JSON.parse(event.body);
      const result = await uploadContacts(body.contacts || []);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (method === "PUT" && path.startsWith("/contact/")) {
      const id = parseInt(path.split("/").pop());
      const body = JSON.parse(event.body);
      const result = await updateContact(id, body);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (method === "GET" && path === "/stats") {
      const result = await getStats();
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: "Not found" }) };
  } catch (err) {
    console.error("Function error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, type: err.constructor.name })
    };
  }
};
