// Pure helpers for the Seguimiento list. No database imports, so the seed
// script and tests can reuse the same assignment, messages, and outcome rules.

export const FINAL_STATUSES = ['Vendido', 'Viene a la tienda', 'No le interesa', 'Número equivocado'];
export const RETRY_STATUSES = ['No contestó', 'Volver a llamar'];
export const COLD_STATUS = 'Frío';
export const MAX_ATTEMPTS = 2;
export const REACHED_STATUSES = ['Vendido', 'Viene a la tienda', 'Volver a llamar', 'No le interesa'];

// Columns an import is allowed to refresh. Outcome history is intentionally absent.
export const LEAD_FIELDS = [
  'contact_id', 'name', 'phone', 'lifecycle', 'assignee', 'note',
  'suggested_message', 'last_interaction', 'days_since', 'ciudad', 'sort_order',
];

const NOTE_BY_LIFE = {
  'intento de compra': 'Intentó comprar y el pedido quedó pendiente. Cerrar hoy con el anticipo.',
  'hot lead': 'Lead caliente. Ofrecer la promo de la semana y pedir que reserve piezas.',
  'visita a la tienda': 'Quiere conocer la tienda. Invitar a Mixcalco esta semana.',
  'cold lead': 'Hace tiempo que no escribe. Acercamiento suave, sin presión.',
};

export function normLife(lifecycle) {
  return String(lifecycle || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function assigneeForLifecycle(lifecycle) {
  const k = normLife(lifecycle);
  if (k === 'intento de compra' || k === 'hot lead') return 'perla';
  if (k === 'visita a la tienda' || k === 'cold lead') return 'yoana';
  return null;
}

export function greetingName(name) {
  const cleaned = String(name || '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || !/\p{L}/u.test(cleaned)) return '';
  const parts = cleaned.split(' ').filter((p) => /\p{L}/u.test(p) && !/^\d+$/.test(p));
  if (!parts.length) return '';
  let pick = parts[0];
  if ((pick.endsWith('.') || pick.length <= 2) && parts[1]) pick = parts[1];
  pick = pick.replace(/\.$/, '');
  if (pick.length < 2) return '';
  return pick;
}

function intro(name, who) {
  const n = greetingName(name);
  return n ? `Hola ${n}, soy ${who} de Sahiba.` : `Hola, soy ${who} de Sahiba.`;
}

export function suggestedMessage(lifecycle, name) {
  const k = normLife(lifecycle);
  if (k === 'intento de compra') {
    return `${intro(name, 'Perla')} Vi que tu compra se quedó a un paso. Si hoy dejas el anticipo, te aparto las piezas y cerramos el pedido. ¿Lo hacemos ahora?`;
  }
  if (k === 'hot lead') {
    return `${intro(name, 'Perla')} Esta semana tenemos una promo en la colección. Si te late, te reservo las piezas para que no se agoten. ¿Cuáles aparto?`;
  }
  if (k === 'visita a la tienda') {
    return `${intro(name, 'Yoana')} Te invito a la tienda de Mixcalco esta semana. Pregunta por Milagros y te damos un regalo de bienvenida. ¿Qué día puedes venir?`;
  }
  if (k === 'cold lead') {
    return `${intro(name, 'Yoana')} Solo paso a saludarte y saber cómo vas. Si todavía buscas algo de la colección, aquí estoy para ayudarte, sin prisa.`;
  }
  return '';
}

export function buildNote(comentarios, lifecycle) {
  const c = String(comentarios || '').trim();
  if (c) return c;
  const k = normLife(lifecycle);
  return NOTE_BY_LIFE[k] || (String(lifecycle || '').trim() || 'Sin nota');
}

export function parseTimestamp(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.replace(' ', 'T');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// RFC4180-ish parser. Handles quotes, escaped quotes, and commas inside cities.
export function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cur = '';
  let i = 0;
  let inQ = false;
  while (i < src.length) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur += '"'; i += 2; continue; }
        inQ = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(cur); cur = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.length || row.length) {
    row.push(cur);
    if (row.some((cell) => cell !== '')) rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, idx) => { if (h) o[h] = r[idx] != null ? r[idx] : ''; });
    return o;
  });
}

export function normalizeLead(raw, index) {
  const src = raw || {};
  const contact_id = String(src.contact_id ?? src.id ?? '').trim().slice(0, 40);
  if (!contact_id) return { ok: false, reason: 'missing_id' };
  const assignee = String(src.assignee || '').trim().toLowerCase();
  if (assignee !== 'perla' && assignee !== 'yoana') return { ok: false, reason: 'bad_assignee' };
  const phoneDigits = String(src.phone ?? '').replace(/\D/g, '');
  const daysRaw = src.days_since;
  const days = daysRaw === '' || daysRaw == null ? null : Number(daysRaw);
  const sortRaw = src.sort_order;
  const sort = sortRaw === '' || sortRaw == null ? index + 1 : Number(sortRaw);
  const note = src.note == null ? buildNote(src.comentarios, src.lifecycle) : String(src.note);
  const message = src.suggested_message == null || src.suggested_message === ''
    ? suggestedMessage(src.lifecycle, src.name)
    : String(src.suggested_message);
  return {
    ok: true,
    row: {
      contact_id,
      name: String(src.name || '').trim() || null,
      phone: phoneDigits || null,
      lifecycle: String(src.lifecycle || '').trim() || null,
      assignee,
      note: note.slice(0, 2000),
      suggested_message: message.slice(0, 2000),
      last_interaction: parseTimestamp(src.last_interaction),
      days_since: Number.isFinite(days) ? days : null,
      ciudad: String(src.ciudad || src.city || '').trim() || null,
      sort_order: Number.isFinite(sort) ? Math.round(sort) : index + 1,
    },
  };
}

export function buildSeedRows(csvRows) {
  const stats = { perla: 0, yoana: 0, skipped: 0, total: csvRows.length, byLife: {} };
  const rows = [];
  csvRows.forEach((raw, idx) => {
    const life = String(raw.lifecycle || '').trim();
    const assignee = assigneeForLifecycle(life);
    if (!raw.contact_id || !assignee) { stats.skipped++; return; }
    const key = normLife(life);
    stats.byLife[key] = (stats.byLife[key] || 0) + 1;
    stats[assignee]++;
    const shaped = normalizeLead({
      contact_id: raw.contact_id,
      name: raw.name,
      phone: raw.phone,
      lifecycle: life,
      assignee,
      note: buildNote(raw.comentarios, life),
      suggested_message: suggestedMessage(life, raw.name),
      last_interaction: raw.last_interaction,
      days_since: raw.days_since,
      ciudad: raw.ciudad,
      sort_order: idx + 1,
    }, idx);
    if (!shaped.ok) { stats.skipped++; return; }
    rows.push(shaped.row);
  });
  return { rows, stats };
}

// Decide the next stored state. Does not touch the database.
// Retry statuses stay on the list until the 2nd attempt, which marks the row cold.
export function applyOutcome(row, statusIn, commentIn) {
  const active = !(row && (row.active === false || row.active === 'f' || row.active === 'false'));
  if (!row || !active) {
    return { error: 'Este contacto ya no está en la lista activa', code: 409 };
  }
  const status = String(statusIn || '').trim();
  const allowed = FINAL_STATUSES.concat(RETRY_STATUSES);
  if (!allowed.includes(status)) return { error: 'Estado no válido', code: 400 };
  const comment = String(commentIn || '').trim().slice(0, 280);
  const events = [{ status, comment: comment || null, auto: false }];
  const prevAttempts = Number(row.attempts) || 0;
  if (RETRY_STATUSES.includes(status)) {
    const attempts = prevAttempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      events.push({ status: COLD_STATUS, comment: 'Se marcó como fría tras 2 intentos', auto: true });
      return {
        attempts,
        outcome: COLD_STATUS,
        outcome_comment: comment || null,
        active: false,
        events,
        dropped: true,
        cold: true,
      };
    }
    return {
      attempts,
      outcome: status,
      outcome_comment: comment || null,
      active: true,
      events,
      dropped: false,
      cold: false,
    };
  }
  return {
    attempts: prevAttempts,
    outcome: status,
    outcome_comment: comment || null,
    active: false,
    events,
    dropped: true,
    cold: false,
  };
}
