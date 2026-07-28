# Wasify — WhatsApp CRM for Shopify merchants

A rebuild of the Wasify platform on the new design: a real-time WhatsApp inbox,
COD order confirmation, abandoned-cart recovery, broadcasts, flows and a
keyword chatbot — all scoped to one merchant per login.

---

## Setup in five steps

### 1. Create a Supabase project

New project → **SQL Editor** → paste the whole of [`supabase/schema.sql`](supabase/schema.sql)
→ **Run**.

It creates 54 tables with Row Level Security on every one of them, plus the
indexes, triggers and realtime publication the app expects. The file is
idempotent — re-running it never destroys data, so it is safe to apply again
after pulling changes.

Then in **Authentication → Providers**, make sure **Email** is enabled. If you
leave "Confirm email" on, new users must click the link before their first
sign-in.

### 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill it in. The two that people miss:

| Variable | Why it matters |
|---|---|
| `ENCRYPTION_KEY` | 64 hex chars (`openssl rand -hex 32`). Encrypts every stored WhatsApp and Shopify token. **Never change it after tokens are saved** — they become undecryptable. |
| `NEXT_PUBLIC_SITE_URL` | Builds the OAuth redirect and webhook callback URLs. Set it explicitly on Vercel; the auto-generated preview URL will break Shopify OAuth. |

`META_APP_SECRET` and `SHOPIFY_CLIENT_SECRET` are **required in production**.
Both webhooks refuse all traffic (HTTP 503) when their signing secret is
missing, because an unverified webhook would let anyone who knows the URL
inject messages into a tenant's inbox.

### 3. Deploy to Vercel

```bash
vercel --prod
```

Add the same variables under **Settings → Environment Variables**.

`vercel.json` already declares the two cron jobs:

| Schedule | Route | What it does |
|---|---|---|
| every 15 min | `/api/cron/tick` | COD reminders, cart-recovery sends, automation waits, flow delays, queued broadcasts, snooze wake-ups |
| daily 03:00 UTC | `/api/cron/daily` | Shopify backfill, nightly RFM scoring, static segment refresh, webhook-log pruning |

The 15-minute cadence is deliberate: the first cart reminder fires 45 minutes
after abandonment, and a daily cron cannot express that. **Vercel Hobby only
allows daily crons** — on Hobby, `/api/cron/tick` will run once a day and cart
reminders will be late. Use a Pro plan, or point an external scheduler
(cron-job.org, GitHub Actions) at the same URL with the `Authorization: Bearer
$CRON_SECRET` header.

### 4. Connect WhatsApp

**Integrations → WhatsApp Cloud API → Connect.**

1. Paste your **Phone number ID** and **WhatsApp Business Account ID** from
   Meta → WhatsApp → API Setup.
2. Paste a **permanent access token**. It is encrypted before storage and is
   never sent back to the browser — the field shows a masked value.
3. Press **Generate** next to *Webhook verify token* and copy the value.
4. In the Meta App Dashboard → WhatsApp → Configuration, set:
   - Callback URL: `https://your-app.vercel.app/api/whatsapp/webhook`
   - Verify token: the value you just generated
   - Subscribe to the **messages** field
5. Back in Wasify, press **Run diagnostics**. It makes live Graph API calls and
   tells you exactly which piece is wrong if something is.

### 5. Connect Shopify

**Integrations → Shopify → Connect store**, enter `your-store.myshopify.com`,
approve the scopes. Webhooks are registered automatically on the way back.

Scopes requested: `read_customers`, `read_orders`, `write_orders` (COD tags),
`read_checkouts`, `read_fulfillments`, `read_products`, `read_discounts`,
`write_discounts` (single-use recovery codes).

Widening scopes later always requires the merchant to re-approve — the Catalog
screen shows a reconnect banner when `write_discounts` is missing.

---

## How the pieces fit

```
Meta ──► /api/whatsapp/webhook ─┐
                                ├─► resolve tenant by phone_number_id
Shopify ► /api/shopify/webhook ─┘   └─► find-or-create contact + conversation
                                        └─► flow ─► automations ─► chatbot
                                            └─► COD reply ─► opt-out check

Vercel cron ──► /api/cron/tick ──► COD timers, recovery sweep, flow delays,
                                   automation waits, broadcast batches
```

### Rules that must not be broken

These were learned the hard way in the previous production app. Each one is
enforced in code, and most are covered by a test.

1. **Never message a paying customer.** The recovery sweep re-reads the
   checkout immediately before every send and stops if it completed.
2. **Only Approved templates are sendable.** Every send resolves the exact
   name and language against templates synced from Meta, which is what avoids
   error #132001.
3. **Free text only inside the 24-hour window**, measured from the last
   *inbound* message. Outbound never resets it. The server refuses free text
   once it expires — the UI cannot bypass it.
4. **Everything is idempotent.** One COD row per order, one recovery row per
   checkout, one conversation per contact, wamid-deduped messages, and counter
   gates on every timer. Running a sweep twice never double-sends.
5. **Backfilled data never triggers messaging.** Imported orders are written
   with `source='backfill'`; only live webhook events start a conversation.
   (Recovery *rows* are the deliberate exception, so the carts page has
   history — sending stays gated.)
6. **Contact dedupe is one algorithm.** `phonesMatch()` — exact digits or the
   last 8 — used by the webhook, new-chat, CSV import, COD and recovery alike.
   Two implementations means split threads.
7. **Tokens are encrypted** with AES-256-GCM (`iv:ct:tag` hex) and never
   returned to the browser.
8. **Webhook routing keys are unique.** `phone_number_id` and `store_domain`
   are globally unique, so a second tenant cannot squat another's routing.
9. **Meta dynamic URL buttons take only a suffix.** The base URL lives in the
   template; the app sends the cart link's path and query as `{{1}}`.
10. **Marketing needs consent.** STOP / BAJA / PARAR / UNSUBSCRIBE opt a
    contact out instantly and suppress their number. COD confirmations are
    transactional and unaffected.

---

## Local development

```bash
npm install
cp .env.example .env.local     # fill it in
npm run dev                    # http://localhost:3000
npm test                       # 44 unit tests
npm run typecheck
```

For webhooks locally, tunnel with `ngrok http 3000` and set
`NEXT_PUBLIC_SITE_URL` to the tunnel URL.

### Testing the timers without waiting

Back-date a row, then trigger the sweep:

```sql
update checkout_recoveries set created_at = now() - interval '2 hours' where id = '...';
```

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/tick
```

Every sweep is idempotent, so you can run it as often as you like.

---

## Project layout

```
supabase/schema.sql          the whole database, idempotent
src/app/(auth)/              login, signup
src/app/(app)/               the 13 screens, wrapped in the shell
src/app/api/                 route handlers
src/lib/
  phone.ts                   sanitize / validate / match — the dedupe rules
  window.ts                  the 24-hour customer-service window
  crypto.ts                  AES-256-GCM token storage
  contacts.ts                shared find-or-create for contacts + conversations
  whatsapp/                  Graph API client and send helpers
  shopify/                   Admin API, OAuth, webhook registration, backfill
  engines/                   cod · recovery · flows · automations · chatbot ·
                             broadcasts · segments · discounts
src/components/              shell, UI primitives, charts, segment builder
```

---

## What is not built yet

Stated plainly so nothing looks finished when it is not:

- **AI agent** — parked at your request. The Chatbot screen's keyword rules and
  FAQ knowledge base work today with no API key and no per-message cost. The
  persona, intent classification and confidence-threshold handoff are designed,
  the columns exist and the UI is visible, but `chatbot_config.ai_enabled`
  defaults to false and no model is ever called.
- **Team logins** — agents are assignment labels. They route conversations and
  deals and appear in reports, but they do not have their own seats. Real
  multi-user access needs an org layer and a rewrite of every RLS policy, so it
  is a deliberate next step rather than a half-built one.
- **Multi-store** — one Shopify store and one WhatsApp number per account, as
  agreed. The store switcher in the top bar shows the connected store and says
  so.
- **True holdout experiments** — the Analytics comparison of messaged vs
  not-messaged customers is observational and labelled as such in the UI. A
  causal number needs a control group assigned before sending.
- **Revenue attribution** is last-touch over a 7-day window and currently
  credits any order from a contact you messaged in the period.
