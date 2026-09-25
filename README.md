# Sahiba — Nancy Call Tracker

Shared contact management app for Nancy's WhatsApp call lists.

## Setup

### 1. Deploy to Netlify
- Connect this GitHub repo to Netlify
- Or drag-and-drop the folder to Netlify

### 2. Set Environment Variables in Netlify
Go to **Site settings → Environment variables** and add:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Your Neon Postgres connection string |
| `APP_TOKEN` | Any password to protect the app (default: `sahiba2026`) |
| `FOLLOWUP_IMPORT_TOKEN` | Secret for the Seguimiento import/export endpoints. **Required** before an automation can load or read the warm-lead list. Generate a long random value and do not reuse `APP_TOKEN` (that one is in the page). |

### 3. Redeploy
After adding env vars, trigger a redeploy for them to take effect.

### 4. Open the App
First time: enter the Netlify site URL and your APP_TOKEN.

## How It Works

- **Admin (you):** Upload daily Excel call lists → auto-merges new contacts, preserves Nancy's status/notes
- **Nancy:** Opens the same URL → updates status, adds notes, sends WhatsApp messages
- **Both:** Real-time shared view with filters, search, and stats

## Status Stages
Pendiente → Contactada → Respondió → Sin Respuesta → Venta → No Interesada

## Seguimiento (Perla y Yoana)

Mobile list of warm leads whose Respond.io 24h window has expired. Perla calls **Intento de compra** and **Hot Lead**. Yoana writes **Visita a la tienda** and **Cold Lead** on personal WhatsApp. The screen is in Spanish.

Same login style as the rest of the CRM:

| Who | URL | What they see |
|-----|-----|----------------|
| Perla | `/?v=perla` | Only her rows. Opens on Seguimiento. |
| Yoana | `/?v=yoana&seg=1` | Only her rows. Her existing Contactos page is unchanged; this link opens Seguimiento. |
| Jasjit (admin) | `/` then **Seguimiento** | Both lists, closed rows, and today's summary. Same admin password as the rest of the app. |

On each card: name, phone, lifecycle, days since last contact (from `last_interaction`), city, note, and the suggested message. **Llamar** uses `tel:`, **WhatsApp** opens `https://wa.me/<digits>?text=...`, **Copiar mensaje** copies the text.

Outcome buttons: Vendido, Viene a la tienda, Volver a llamar, No contestó, No le interesa, Número equivocado. Optional comment. The server stores the timestamp. Final outcomes leave the active list. **No contestó** and **Volver a llamar** stay, with an attempt counter; the second one marks the row **Frío** and removes it.

### Endpoints

All of these live on the existing function (`/.netlify/functions/api/...`).

Staff and admin (header `Authorization: Bearer <APP_TOKEN>`):

| Method | Path | |
|--------|------|--|
| `GET` | `/followups?assignee=perla\|yoana\|all&scope=active\|all` | Active list by default. `assignee=all` is the admin view. |
| `GET` | `/followups/summary` | Per person, for today in `America/Mexico_City`: `assigned` (active queue), `contacted`, `reached`, `sold`, `coming_to_store`. Reached means Vendido, Viene a la tienda, Volver a llamar, or No le interesa. |
| `POST` | `/followups/:contact_id/outcome` | Body `{ "status", "comment" }`. |

Import and export (header `Authorization: Bearer <FOLLOWUP_IMPORT_TOKEN>` or `X-Import-Token`). These reject the app token. If the env var is missing, they return 401.

| Method | Path | |
|--------|------|--|
| `POST` | `/followups/import` | JSON array, `{ "rows": [...] }`, or `text/csv`. Upserts by `contact_id`. Fields: `contact_id`, `name`, `phone`, `lifecycle`, `assignee` (`perla` or `yoana`), `note`, `suggested_message`, `last_interaction`, `days_since`, `ciudad`. A later import refreshes those fields and does **not** overwrite outcome, attempts, or outcome history. |
| `GET` | `/followups/export` | Every row plus its `outcomes` array, for the automation that reads results back. |

### Loading the warm list

Put the CSV at `uploads/followup-warm-2026-09-25.csv` (that folder is gitignored; it contains phone numbers). Then:

```bash
node scripts/seed-followups.mjs --stats
FOLLOWUP_IMPORT_URL=https://<site>/.netlify/functions/api/followups/import \
FOLLOWUP_IMPORT_TOKEN=... \
node scripts/seed-followups.mjs --post
```

`--json` prints the payload. Do not commit it.

## Tech Stack
- Frontend: Single HTML file (vanilla JS + SheetJS for Excel parsing)
- Backend: Netlify Functions (serverless)
- Database: Neon Postgres (serverless)
