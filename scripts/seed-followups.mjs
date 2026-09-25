#!/usr/bin/env node
// Convert the warm-lead CSV into the Seguimiento import payload.
//
//   node scripts/seed-followups.mjs --stats
//   node scripts/seed-followups.mjs --json > /tmp/followups.json
//   FOLLOWUP_IMPORT_URL=https://<site>/.netlify/functions/api/followups/import \
//   FOLLOWUP_IMPORT_TOKEN=... \
//   node scripts/seed-followups.mjs --post
//
// The CSV has customer phone numbers. This script never writes that file,
// and it refuses to write the JSON payload inside the repo (except uploads/,
// which is gitignored).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeedRows, parseCsv } from '../netlify/functions/followup-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : '';
}

function has(name) { return process.argv.includes(name); }

function findCsv() {
  const fromFlag = arg('--csv');
  const candidates = [
    fromFlag ? path.resolve(fromFlag) : null,
    process.env.FOLLOWUP_CSV ? path.resolve(process.env.FOLLOWUP_CSV) : null,
    path.join(repoRoot, 'uploads', 'followup-warm-2026-09-25.csv'),
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[0] || path.join(repoRoot, 'uploads', 'followup-warm-2026-09-25.csv');
}

function assertSafeOut(dest) {
  const abs = path.resolve(dest);
  const root = repoRoot + path.sep;
  const uploads = path.join(repoRoot, 'uploads') + path.sep;
  if (abs.startsWith(root) && !abs.startsWith(uploads)) {
    console.error('No escribo teléfonos dentro del repo. Usa uploads/ (está en .gitignore) o una ruta fuera del repo.');
    process.exit(1);
  }
}

const csvPath = findCsv();
if (!existsSync(csvPath)) {
  console.error('No está el CSV. Colócalo en uploads/followup-warm-2026-09-25.csv o pasa --csv.');
  process.exit(1);
}

const { rows, stats } = buildSeedRows(parseCsv(readFileSync(csvPath, 'utf8')));
const wantJson = has('--json') || arg('--out') != null;
const wantPost = has('--post');
const wantStats = has('--stats') || (!wantJson && !wantPost);

if (wantStats) {
  console.log(`Filas: ${rows.length}  (CSV ${stats.total}, omitidas ${stats.skipped})`);
  console.log(`Perla (llamadas): ${stats.perla}  · Intento de compra ${stats.byLife['intento de compra'] || 0} · Hot Lead ${stats.byLife['hot lead'] || 0}`);
  console.log(`Yoana (WhatsApp): ${stats.yoana}  · Visita a la tienda ${stats.byLife['visita a la tienda'] || 0} · Cold Lead ${stats.byLife['cold lead'] || 0}`);
}

const out = arg('--out');
if (out != null && out !== '') {
  assertSafeOut(out);
  writeFileSync(path.resolve(out), JSON.stringify(rows));
  console.log('Escrito:', path.resolve(out));
} else if (has('--json') && !wantPost) {
  process.stdout.write(JSON.stringify(rows));
  if (process.stdout.isTTY) process.stdout.write('\n');
}

if (wantPost) {
  const token = process.env.FOLLOWUP_IMPORT_TOKEN || '';
  const url = process.env.FOLLOWUP_IMPORT_URL || '';
  if (!token || !url) {
    console.error('Para --post hacen falta FOLLOWUP_IMPORT_URL y FOLLOWUP_IMPORT_TOKEN.');
    process.exit(1);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(rows),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error('Import falló', res.status, body.slice(0, 500));
    process.exit(1);
  }
  console.log('Import OK', body.slice(0, 500));
}
