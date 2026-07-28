# Wasify — WhatsApp CRM for Shopify merchants

A rebuild of the Wasify platform on the new design: a real-time WhatsApp inbox,
COD order confirmation, abandoned-cart recovery, broadcasts, flows and a
keyword chatbot — all scoped to one merchant per login.

---

## Setup

**→ Follow [SETUP.md](SETUP.md).** It walks through Supabase, every environment
variable and exactly where to find it, Vercel, cron-job.org scheduling, and
connecting WhatsApp and Shopify — with a troubleshooting table at the end.

After deploying, `https://your-app.vercel.app/api/health` reports which
variables are missing and what each one breaks.

### Scheduling

Vercel's Hobby plan allows only one cron run per day, which cannot express a
45-minute first cart reminder. Scheduling therefore lives in an external
service — `vercel.json` declares no crons.

Set up two jobs at [cron-job.org](https://cron-job.org), both `GET`, each
carrying your cron secret as a header. Which header depends on which variable
you set — `CRON_SECRET` uses `Authorization: Bearer <value>`, and
`AUTOMATION_CRON_SECRET` uses `x-cron-secret: <value>`. `/api/health` prints
the exact line to paste.

| Schedule | URL | What it does |
|---|---|---|
| every 15 min | `/api/cron/tick` | COD reminders, cart-recovery sends, automation waits, flow delays, queued broadcasts, snooze wake-ups |
| daily 03:00 | `/api/cron/daily` | Shopify backfill, RFM scoring, segment refresh, log pruning |

Every sweep is idempotent, so running either more often than needed is
harmless. On Vercel Pro you can move both back into `vercel.json` — the block
to paste is in the file's comment.

---

## How the pieces fit

```
Meta ──► /api/whatsapp/webhook ─┐
                                ├─► resolve tenant by phone_number_id
Shopify ► /api/shopify/webhook ─┘   └─► find-or-create contact + conversation
                                        └─► flow ─► automations ─► chatbot
                                            └─► COD reply ─► opt-out check

cron-job.org ─► /api/cron/tick ──► COD timers, recovery sweep, flow delays,
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
npm test                       # 60 unit tests
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
# or, if you set AUTOMATION_CRON_SECRET instead:
curl -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://your-app.vercel.app/api/cron/tick
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
