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
| `FOLLOWUP_PIN_PERLA` | Perla's Seguimiento PIN. **Required.** She sends it as `Authorization: Bearer`. It is not `APP_TOKEN` and it is not shared. |
| `FOLLOWUP_PIN_YOANA` | Yoana's Seguimiento PIN. **Required.** Same rules as Perla's. |
| `FOLLOWUP_PIN_JAZMIN` | Jazmin's Seguimiento PIN. **Required.** This only opens her Seguimiento list. Her existing CRM link (`?v=jazmin`) still uses the app token. |
| `FOLLOWUP_PIN_ADMIN` | Jasjit's Seguimiento PIN. **Required** to see all three lists, every note, the summary, and to reassign a row. Separate from the admin password typed in the page and from `APP_TOKEN`. |

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

## Seguimiento (Perla, Yoana y Jazmin)

Mobile list of warm leads whose Respond.io 24h window has expired. The screen is in Spanish.

Seed split for the warm list:

| Lifecycle | Who |
|-----------|-----|
| Intento de compra | Perla (calls) |
| Hot Lead | Perla and Jazmin, alternating in file order (first hot lead → Perla) |
| Visita a la tienda | Yoana (personal WhatsApp) |
| Cold Lead | Yoana (personal WhatsApp) |

Each person logs in with her own PIN (`FOLLOWUP_PIN_PERLA`, `FOLLOWUP_PIN_YOANA`, `FOLLOWUP_PIN_JAZMIN`). Jasjit uses `FOLLOWUP_PIN_ADMIN`. These are checked on the server. `APP_TOKEN` does not open Seguimiento, and one PIN cannot read another person's rows, tabs, or call notes. If a PIN env var is missing, that login fails. If two PINs are identical, both fail.

| Who | URL | What they see |
|-----|-----|----------------|
| Perla | `/?v=perla` | Only her rows and her own call notes. Opens on Seguimiento. |
| Yoana | `/?v=yoana&seg=1` | Only her rows and her notes. Her Contactos page is unchanged. |
| Jazmin | `/?v=jazmin&seg=1` | Only her rows and her notes. Her Contactos page is unchanged. |
| Jasjit (admin) | `/` then **Seguimiento** | All three tabs, every note, reassignment, and today's summary side by side. The CRM still asks for the admin password; Seguimiento then asks for `FOLLOWUP_PIN_ADMIN`. |

On each card: name, phone, lifecycle, days since last contact (from `last_interaction`), city, the customer note, the suggested message, and the attempt history this person is allowed to see. **Llamar** uses `tel:`, **WhatsApp** opens `https://wa.me/<digits>?text=...`, **Copiar mensaje** copies the text. Hot-lead messages use the assignee's name (Perla or Jazmin).

Outcome buttons: Vendido, Viene a la tienda, Volver a llamar, No contestó, No le interesa, Número equivocado. A short note about the call or WhatsApp is **required** before it saves. The server stores the timestamp and who wrote it. Final outcomes leave the active list. **No contestó** and **Volver a llamar** stay, with an attempt counter; the second one marks the row **Frío** and removes it. Admin sees every attempt (date/time, person, outcome, note). Each staff member sees only her own attempts for that contact. Reassigning a row does not erase history; the new assignee does not see the previous person's notes.

### Endpoints

All of these live on the existing function (`/.netlify/functions/api/...`).

Login and the list use the per-person PIN. The app token is rejected.

| Method | Path | |
|--------|------|--|
| `POST` | `/followups/login` | Body `{ "pin" }`. Returns `{ "ok", "role": "admin"\|"staff", "person" }`. Does not echo the PIN. |
| `GET` | `/followups?assignee=perla\|yoana\|jazmin\|all&scope=active\|all` | Header `Authorization: Bearer <pin>`. Staff are forced to their own assignee. Another assignee returns 403. History in the payload is filtered the same way. |
| `GET` | `/followups/summary` | Admin PIN only. Per person, for today in `America/Mexico_City`: `assigned` (active queue), `contacted`, `reached`, `sold`, `coming_to_store`. Reached means Vendido, Viene a la tienda, Volver a llamar, or No le interesa. |
| `POST` | `/followups/:contact_id/outcome` | Body `{ "status", "comment" }`. `comment` is required. Staff can only update their own rows. |
| `POST` | `/followups/:contact_id/reassign` | Admin PIN only. Body `{ "assignee": "perla"\|"yoana"\|"jazmin" }`. Does not clear outcomes or attempts. |

Import and export (header `Authorization: Bearer <FOLLOWUP_IMPORT_TOKEN>` or `X-Import-Token`). These reject the app token and the PINs. If the env var is missing, they return 401.

| Method | Path | |
|--------|------|--|
| `POST` | `/followups/import` | JSON array, `{ "rows": [...] }`, or `text/csv`. Upserts by `contact_id`. Fields: `contact_id`, `name`, `phone`, `lifecycle`, `assignee` (`perla`, `yoana`, or `jazmin`), `note`, `suggested_message`, `last_interaction`, `days_since`, `ciudad`. A later import refreshes those fields and does **not** overwrite outcome, attempts, or outcome history. |
| `GET` | `/followups/export` | Every row plus its `outcomes` array (including `person`), for the automation that reads results back. |

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
