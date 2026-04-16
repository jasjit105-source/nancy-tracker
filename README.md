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

## Tech Stack
- Frontend: Single HTML file (vanilla JS + SheetJS for Excel parsing)
- Backend: Netlify Functions (serverless)
- Database: Neon Postgres (serverless)
