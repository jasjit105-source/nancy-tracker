import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyOutcome, assigneeForLifecycle, buildNote, buildSeedRows, greetingName,
  normalizeLead, parseCsv, suggestedMessage, LEAD_FIELDS, COLD_STATUS, MAX_ATTEMPTS,
} from '../netlify/functions/followup-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error('FAIL:', msg); }
}

// Assignment follows lifecycle, not round-robin.
assert(assigneeForLifecycle('Intento de compra') === 'perla', 'intento → perla');
assert(assigneeForLifecycle('Hot Lead') === 'perla', 'hot → perla');
assert(assigneeForLifecycle('Visita a la tienda') === 'yoana', 'visita → yoana');
assert(assigneeForLifecycle('Cold Lead') === 'yoana', 'cold → yoana');
assert(assigneeForLifecycle('Customer') === null, 'unknown lifecycle skipped');

// Messages carry the brief for each lifecycle, in Spanish, with the right sender.
const intento = suggestedMessage('Intento de compra', 'Lucía Mosqueda');
assert(intento.includes('Perla') && intento.includes('Lucía') && intento.includes('anticipo'), 'intento message');
const hot = suggestedMessage('Hot Lead', '😀');
assert(hot.startsWith('Hola, soy Perla') && hot.includes('promo') && /reserv/i.test(hot), 'hot message, emoji name');
const visita = suggestedMessage('Visita a la tienda', 'María');
assert(visita.includes('Yoana') && visita.includes('Mixcalco') && visita.includes('Milagros') && visita.includes('regalo de bienvenida'), 'visita message');
const cold = suggestedMessage('Cold Lead', 'Ana');
assert(cold.includes('Yoana') && cold.includes('sin prisa') && !cold.includes('anticipo'), 'cold message');

assert(greetingName('Ma. Esther') === 'Esther', 'skip abbreviation');
assert(greetingName('✨💛') === '', 'emoji-only name');
assert(greetingName('C') === '', 'single letter');

assert(buildNote('  Quiere el vestido rojo  ', 'Hot Lead') === 'Quiere el vestido rojo', 'comentarios win');
assert(buildNote('', 'Hot Lead').includes('promo'), 'note falls back to lifecycle');

// Quoted commas survive (city field in the real export).
const parsed = parseCsv('contact_id,name,phone,lifecycle,ciudad\n1,Ana,521111,"Hot Lead","Cuautitlán Izcalli, Estado de México."\n');
assert(parsed.length === 1 && parsed[0].ciudad.includes('Izcalli, Estado'), 'csv quotes');

const lead = normalizeLead({
  contact_id: '99', assignee: 'PERLA', name: 'Ana', phone: '+52 55 1234 5678',
  lifecycle: 'Hot Lead', days_since: '4.1', last_interaction: '2026-09-21 12:40:27',
  outcome: 'Vendido', attempts: 5, active: false, outcome_comment: 'no tocar',
}, 0);
assert(lead.ok && lead.row.assignee === 'perla', 'assignee normalized');
assert(lead.row.phone === '525512345678', 'phone digits');
assert(lead.row.days_since === 4.1, 'days float');
assert(lead.row.last_interaction.startsWith('2026-09-21T12:40:27'), 'timestamp');
assert(lead.row.outcome === undefined && lead.row.attempts === undefined && lead.row.active === undefined, 'import shape drops outcome fields');
assert(normalizeLead({ contact_id: '', assignee: 'perla' }).reason === 'missing_id', 'missing id');
assert(normalizeLead({ contact_id: '1', assignee: 'nancy' }).reason === 'bad_assignee', 'bad assignee');

for (const f of ['outcome', 'outcome_comment', 'outcome_at', 'attempts', 'active']) {
  assert(!LEAD_FIELDS.includes(f), 'lead fields exclude ' + f);
}

// Outcome rules.
const a1 = applyOutcome({ active: true, attempts: 0 }, 'No contestó', '  buzón ');
assert(a1.dropped === false && a1.attempts === 1 && a1.outcome === 'No contestó' && a1.outcome_comment === 'buzón', 'first miss stays');
const a2 = applyOutcome({ active: true, attempts: 1 }, 'Volver a llamar', '');
assert(a2.dropped === true && a2.cold === true && a2.outcome === COLD_STATUS && a2.attempts === MAX_ATTEMPTS, 'second attempt goes cold');
assert(a2.events.length === 2 && a2.events[1].auto === true, 'cold event recorded');
const sold = applyOutcome({ active: true, attempts: 1 }, 'Vendido', 'pagó');
assert(sold.dropped === true && sold.cold === false && sold.outcome === 'Vendido' && sold.attempts === 1, 'sale drops without extra attempt');
assert(applyOutcome({ active: false, attempts: 0 }, 'Vendido', '').code === 409, 'closed row rejected');
assert(applyOutcome({ active: true, attempts: 0 }, 'Pendiente', '').code === 400, 'unknown status');
const long = applyOutcome({ active: true, attempts: 0 }, 'No le interesa', 'x'.repeat(500));
assert(long.outcome_comment.length === 280, 'comment capped');

// The upsert in the API must not write outcome columns.
const apiSrc = readFileSync(path.join(root, 'netlify/functions/api.mjs'), 'utf8');
const upsert = apiSrc.match(/ON CONFLICT \(contact_id\) DO UPDATE SET([\s\S]*?)RETURNING/);
assert(upsert, 'upsert present');
if (upsert) {
  assert(!/outcome|attempts|\bactive\b/.test(upsert[1]), 're-import does not overwrite outcome columns');
  for (const col of ['name', 'phone', 'lifecycle', 'assignee', 'note', 'suggested_message', 'last_interaction', 'days_since', 'ciudad', 'sort_order']) {
    assert(upsert[1].includes(col), 'upsert refreshes ' + col);
  }
}

const csvCandidates = [
  process.env.FOLLOWUP_CSV,
  path.join(root, 'uploads', 'followup-warm-2026-09-25.csv'),
  '/home/ubuntu/.cursor/projects/workspace/uploads/followup-warm-2026-09-25_7913.csv',
].filter(Boolean);
const csvPath = csvCandidates.find((p) => existsSync(p));
if (csvPath) {
  const seeded = buildSeedRows(parseCsv(readFileSync(csvPath, 'utf8')));
  assert(seeded.rows.length === 419, 'seed count ' + seeded.rows.length);
  assert(seeded.stats.perla === 201 && seeded.stats.yoana === 218, 'split ' + seeded.stats.perla + '/' + seeded.stats.yoana);
  assert(seeded.stats.byLife['intento de compra'] === 61, 'intento count');
  assert(seeded.stats.byLife['hot lead'] === 140, 'hot count');
  assert(seeded.stats.byLife['visita a la tienda'] === 168, 'visita count');
  assert(seeded.stats.byLife['cold lead'] === 50, 'cold count');
  assert(seeded.stats.skipped === 0, 'none skipped');
  const bad = seeded.rows.find((r) => {
    const expect = (r.lifecycle === 'Intento de compra' || r.lifecycle === 'Hot Lead') ? 'perla' : 'yoana';
    return r.assignee !== expect;
  });
  assert(!bad, 'every row matches its lifecycle bucket');
  const order = seeded.rows.map((r) => r.sort_order);
  assert(order[0] === 1 && order[order.length - 1] === 419, 'priority order preserved');
  const withCity = seeded.rows.filter((r) => r.ciudad && r.ciudad.includes(','));
  assert(withCity.length > 0, 'quoted cities kept');
} else {
  console.log('SKIP real CSV (not on disk)');
}

if (failed) {
  console.error(failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('followup tests ok');
