import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyOutcome, assigneeForLifecycle, buildNote, buildSeedRows, followupActor, greetingName,
  identifyFollowupPin, normalizeLead, parseCsv, projectFollowup, suggestedMessage,
  LEAD_FIELDS, COLD_STATUS, MAX_ATTEMPTS,
} from '../netlify/functions/followup-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error('FAIL:', msg); }
}

// Intento → Perla. Hot Lead alternates Perla / Jazmin. Visita and Cold → Yoana.
assert(assigneeForLifecycle('Intento de compra') === 'perla', 'intento → perla');
assert(assigneeForLifecycle('Hot Lead', 0) === 'perla', 'first hot → perla');
assert(assigneeForLifecycle('Hot Lead', 1) === 'jazmin', 'second hot → jazmin');
assert(assigneeForLifecycle('Hot Lead', 2) === 'perla', 'third hot → perla');
assert(assigneeForLifecycle('Visita a la tienda') === 'yoana', 'visita → yoana');
assert(assigneeForLifecycle('Cold Lead') === 'yoana', 'cold → yoana');
assert(assigneeForLifecycle('Customer') === null, 'unknown lifecycle skipped');

const mini = buildSeedRows([
  { contact_id: '1', name: 'A', lifecycle: 'Intento de compra', phone: '1' },
  { contact_id: '2', name: 'B', lifecycle: 'Hot Lead', phone: '2' },
  { contact_id: '3', name: 'C', lifecycle: 'Hot Lead', phone: '3' },
  { contact_id: '4', name: 'D', lifecycle: 'Hot Lead', phone: '4' },
  { contact_id: '5', name: 'E', lifecycle: 'Visita a la tienda', phone: '5' },
  { contact_id: '6', name: 'F', lifecycle: 'Cold Lead', phone: '6' },
]);
assert(mini.rows.map((r) => r.assignee).join(',') === 'perla,perla,jazmin,perla,yoana,yoana', 'seed order ' + mini.rows.map((r) => r.assignee).join(','));
assert(mini.rows[1].suggested_message.includes('Perla') && mini.rows[2].suggested_message.includes('Jazmin'), 'hot sender follows assignee');

// Messages carry the brief for each lifecycle, in Spanish, with the right sender.
const intento = suggestedMessage('Intento de compra', 'Lucía Mosqueda');
assert(intento.includes('Perla') && intento.includes('Lucía') && intento.includes('anticipo'), 'intento message');
const hot = suggestedMessage('Hot Lead', '😀');
assert(hot.startsWith('Hola, soy Perla') && hot.includes('promo') && /reserv/i.test(hot), 'hot message, emoji name');
const hotJaz = suggestedMessage('Hot Lead', 'Ana', 'jazmin');
assert(hotJaz.includes('soy Jazmin') && hotJaz.includes('promo') && !hotJaz.includes('Perla'), 'jazmin hot message');
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
const jazLead = normalizeLead({ contact_id: '2', assignee: 'Jazmin', lifecycle: 'Hot Lead', name: 'Ana' }, 0);
assert(jazLead.ok && jazLead.row.assignee === 'jazmin' && jazLead.row.suggested_message.includes('Jazmin'), 'jazmin assignee accepted');

for (const f of ['outcome', 'outcome_comment', 'outcome_at', 'attempts', 'active']) {
  assert(!LEAD_FIELDS.includes(f), 'lead fields exclude ' + f);
}

// Outcome rules.
const a1 = applyOutcome({ active: true, attempts: 0 }, 'No contestó', '  buzón ');
assert(a1.dropped === false && a1.attempts === 1 && a1.outcome === 'No contestó' && a1.outcome_comment === 'buzón', 'first miss stays');
const a2 = applyOutcome({ active: true, attempts: 1 }, 'Volver a llamar', 'pide mañana');
assert(a2.dropped === true && a2.cold === true && a2.outcome === COLD_STATUS && a2.attempts === MAX_ATTEMPTS, 'second attempt goes cold');
assert(a2.events.length === 2 && a2.events[1].auto === true, 'cold event recorded');
const sold = applyOutcome({ active: true, attempts: 1 }, 'Vendido', 'pagó');
assert(sold.dropped === true && sold.cold === false && sold.outcome === 'Vendido' && sold.attempts === 1, 'sale drops without extra attempt');
assert(applyOutcome({ active: false, attempts: 0 }, 'Vendido', 'nota').code === 409, 'closed row rejected');
assert(applyOutcome({ active: true, attempts: 0 }, 'Pendiente', 'nota').code === 400, 'unknown status');
assert(applyOutcome({ active: true, attempts: 0 }, 'No contestó', '   ').code === 400, 'blank note rejected');
assert(applyOutcome({ active: true, attempts: 0 }, 'Vendido', '').code === 400, 'missing note rejected');
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
  assert(seeded.stats.perla === 131 && seeded.stats.jazmin === 70 && seeded.stats.yoana === 218, 'split ' + seeded.stats.perla + '/' + seeded.stats.jazmin + '/' + seeded.stats.yoana);
  assert(seeded.stats.byLife['intento de compra'] === 61, 'intento count');
  assert(seeded.stats.byLife['hot lead'] === 140, 'hot count');
  assert(seeded.stats.byLife['visita a la tienda'] === 168, 'visita count');
  assert(seeded.stats.byLife['cold lead'] === 50, 'cold count');
  assert(seeded.stats.skipped === 0, 'none skipped');
  let hotSeen = 0;
  const bad = seeded.rows.find((r) => {
    if (r.lifecycle === 'Intento de compra') return r.assignee !== 'perla';
    if (r.lifecycle === 'Visita a la tienda' || r.lifecycle === 'Cold Lead') return r.assignee !== 'yoana';
    if (r.lifecycle === 'Hot Lead') {
      const expect = hotSeen % 2 === 0 ? 'perla' : 'jazmin';
      hotSeen++;
      if (r.assignee !== expect) return true;
      const who = expect === 'jazmin' ? 'Jazmin' : 'Perla';
      return !r.suggested_message.includes('soy ' + who);
    }
    return true;
  });
  assert(!bad, 'every row matches the three-way split');
  assert(hotSeen === 140, 'hot leads alternated');
  const order = seeded.rows.map((r) => r.sort_order);
  assert(order[0] === 1 && order[order.length - 1] === 419, 'priority order preserved');
  const withCity = seeded.rows.filter((r) => r.ciudad && r.ciudad.includes(','));
  assert(withCity.length > 0, 'quoted cities kept');
} else {
  console.log('SKIP real CSV (not on disk)');
}

const pins = {
  FOLLOWUP_PIN_ADMIN: 'admin-secret',
  FOLLOWUP_PIN_PERLA: '1111',
  FOLLOWUP_PIN_YOANA: '2222',
  FOLLOWUP_PIN_JAZMIN: '3333',
};
assert(identifyFollowupPin('1111', pins) === 'perla', 'perla pin');
assert(identifyFollowupPin('3333', pins) === 'jazmin', 'jazmin pin');
assert(identifyFollowupPin('admin-secret', pins) === 'admin', 'admin pin');
assert(identifyFollowupPin('sahiba2026', pins) === null, 'app token is not a pin');
assert(identifyFollowupPin('', pins) === null, 'empty pin');
assert(identifyFollowupPin('1111', {}) === null, 'unset env fails closed');
assert(identifyFollowupPin('same', { FOLLOWUP_PIN_PERLA: 'same', FOLLOWUP_PIN_YOANA: 'same' }) === null, 'shared pin fails closed');
assert(followupActor('perla').person === 'perla' && followupActor('admin').person === null, 'actor shape');

const events = [
  { status: 'No contestó', comment: 'secreto yoana', person: 'yoana', auto: false },
  { status: 'Volver a llamar', comment: 'nota perla', person: 'perla', auto: false },
  { status: 'Frío', comment: 'Se marcó como fría tras 2 intentos', person: 'yoana', auto: true },
];
const asPerla = projectFollowup({ note: 'pidió vestido', outcome_comment: 'secreto yoana', history: events }, followupActor('perla'));
assert(asPerla.history.length === 1 && asPerla.history[0].comment === 'nota perla', 'staff history is hers');
assert(asPerla.outcome_comment === 'nota perla', 'staff last note is hers');
assert(asPerla.note === 'pidió vestido', 'customer note stays');
assert(!JSON.stringify(asPerla).includes('secreto yoana'), 'other note stripped');
const asAdmin = projectFollowup({ outcome_comment: 'secreto yoana', history: events }, followupActor('admin'));
assert(asAdmin.history.length === 3 && asAdmin.outcome_comment === 'secreto yoana', 'admin sees every note');

const appIdx = apiSrc.indexOf("process.env.APP_TOKEN || 'sahiba2026'");
const pinIdx = apiSrc.indexOf("path === '/followups/login'");
assert(pinIdx !== -1 && appIdx !== -1 && pinIdx < appIdx, 'follow-up PIN check runs before the app token');
assert(!apiSrc.slice(appIdx).includes("'/followups/summary'"), 'summary is not behind the app token');
assert(/ADD COLUMN IF NOT EXISTS person/.test(apiSrc), 'person column is added on existing tables');
const reassign = apiSrc.match(/UPDATE followups SET assignee = \$1, date_updated = NOW\(\)/);
assert(reassign && !/outcome|attempts|\bactive\b/.test(reassign[0]), 'reassign does not clear history');

if (failed) {
  console.error(failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('followup tests ok');
