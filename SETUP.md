# Setup guide — Vercel Hobby + external cron

Follow this top to bottom. It takes about 30 minutes.

---

## Step 1 — Supabase

**a) Create the project**

[supabase.com](https://supabase.com) → **New project**. Pick a region close to
your customers (Frankfurt / `eu-central-1` for Spain). Save the database
password somewhere safe.

**b) Run the schema**

Left sidebar → **SQL Editor** → **New query** → paste the entire contents of
[`supabase/schema.sql`](supabase/schema.sql) → **Run**.

You should see `Success. No rows returned`. That created 54 tables with Row
Level Security on every one. Running it again later is safe — it never drops
data.

**c) Enable email login**

**Authentication → Sign In / Providers → Email** → make sure it is enabled.

> If **Confirm email** is on, you must click the link in your inbox before your
> first sign-in. To skip that while testing, turn it off here.

**d) Copy the three keys**

**Project Settings → API keys**

| Copy this | Into this variable |
|---|---|
| Project URL (`https://xxxx.supabase.co`) | `NEXT_PUBLIC_SUPABASE_URL` |
| `anon` / `public` key — also shown as **publishable** | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` key — also shown as **secret**, click *Reveal* | `SUPABASE_SERVICE_ROLE_KEY` |

> Supabase renamed these in 2025. If you see `sb_publishable_…` and
> `sb_secret_…` instead of the older JWT-looking keys, use those — publishable
> is the anon key, secret is the service-role key. Both styles work.

**The `service_role` key bypasses all security.** It goes in Vercel only —
never in client code, never in a repo, never shared.

---

## Step 2 — Generate two secrets yourself

Run these locally (Mac/Linux terminal, or Git Bash on Windows):

```bash
openssl rand -hex 32     # -> ENCRYPTION_KEY  (must be exactly 64 characters)
openssl rand -hex 24     # -> CRON_SECRET     (any long random string)
```

**These two are not obtained from anywhere.** They are passwords you invent.
Nothing external issues them — the app simply compares what it receives against
what you stored. Any long random string works; the commands above just produce
a good one.

No terminal? Use [generate-random.org/api-key-generator](https://generate-random.org/api-key-generator)
— for `ENCRYPTION_KEY` you need **64 characters, hex only** (`0-9`, `a-f`).

> **`ENCRYPTION_KEY` can never be changed once WhatsApp or Shopify tokens are
> saved.** It is the key those tokens are encrypted with — change it and they
> become unreadable, and you have to reconnect both integrations. Save it in a
> password manager now.

### `CRON_SECRET` vs `AUTOMATION_CRON_SECRET`

The app accepts either, and they do the same job — but **each pairs with a
different HTTP header**, and mixing them is the most common reason a scheduler
gets a silent `401`:

| If you set this variable | Your scheduler must send this header |
|---|---|
| `CRON_SECRET` | `Authorization: Bearer <value>` |
| `AUTOMATION_CRON_SECRET` | `x-cron-secret: <value>` |

Set **one** of them. If you are unsure which you have, open
`https://YOUR-APP.vercel.app/api/health` — the `cron` block names the variable
it found and the exact header to paste:

```json
"cron": {
  "usingVariable": "AUTOMATION_CRON_SECRET",
  "headerName": "x-cron-secret",
  "authHeader": "x-cron-secret: <your AUTOMATION_CRON_SECRET>"
}
```

A rejected cron call says the same thing in its response body, so a
misconfigured job diagnoses itself.

---

## Step 3 — Meta / WhatsApp

You need one value here: `META_APP_SECRET`.

1. [developers.facebook.com/apps](https://developers.facebook.com/apps) → your app
   (or **Create App** → type **Business**)
2. Left sidebar → **App settings → Basic**
3. **App Secret** → **Show** → copy it

That is the only Meta value that goes in Vercel. The Phone Number ID, WABA ID
and access token are entered **inside Wasify** (Integrations screen) after
deploy, because they are encrypted and stored per account.

---

## Step 4 — Shopify *(skip if you are not using Shopify yet)*

Skip this whole step if Shopify is not connected yet — every other feature
works without it.

### 4a. Copy the credentials

[partners.shopify.com](https://partners.shopify.com) → **Apps** → your app
(or **Create app → Create app manually**) → **Configuration → Client credentials**

| Copy this | Into this variable |
|---|---|
| Client ID (older UI: *API key*) | `SHOPIFY_CLIENT_ID` |
| Client secret (older UI: *API secret key*) | `SHOPIFY_CLIENT_SECRET` |

### 4b. App settings — the exact values

In the Partner Dashboard, **Configuration** (or **Create version**):

| Field | Value | Why |
|---|---|---|
| **App URL** | `https://YOUR-APP.vercel.app` | Not `https://example.com`. Where Shopify sends merchants. |
| **Embed app in Shopify admin** | ☐ **UNCHECKED** | Wasify is a standalone app at its own domain with its own login. Embedded apps run in an iframe inside Shopify admin and need App Bridge and session tokens — and the session cookies this app sets are blocked in that third-party iframe, so ticking this breaks sign-in. |
| **Preferences URL** | leave empty | Optional; only used by embedded apps. |
| **Webhooks API version** | `2026-04` | Must match `SHOPIFY_API_VERSION` in `src/lib/shopify/admin.ts`, or a payload can arrive in a shape the parsers were not written against. |
| **Use legacy install flow** | ☐ **UNCHECKED** | Leave Shopify managed installation on — it is the recommended path, and scopes come from the list below. |
| **Redirect URLs** | `https://YOUR-APP.vercel.app/api/shopify/callback` | **The single most common blocker.** Empty here means OAuth fails with *"redirect_uri is not whitelisted"*. Must match exactly — a trailing slash breaks it. It has to equal `NEXT_PUBLIC_SITE_URL` + `/api/shopify/callback`: `/api/health` prints that exact string under `shopify.redirectUrl`, and so does the Connect-store dialog. Copy it from there rather than typing it. |

### 4c. Scopes — copy this line exactly

Paste into **API access → Scopes**, as one comma-separated line with no spaces:

```
read_customers,read_orders,write_orders,read_checkouts,read_fulfillments,read_products,read_discounts,write_discounts
```

Leave **Optional scopes** empty.

This must match `SHOPIFY_SCOPES` in `src/lib/shopify/admin.ts`. What each one
is for:

| Scope | Without it |
|---|---|
| `read_customers` | Orders and carts mirror with no customer name or email |
| `read_orders` | No `orders/*` **and no `checkouts/*` webhooks** — Shopify gates the checkout topics on `read_orders`, not on `read_checkouts` |
| `write_orders` | COD tags never applied — no "COD Pending" → "COD Confirmed" in Shopify |
| `read_checkouts` | The abandoned-cart backfill cannot read checkout history |
| `read_fulfillments` | No `fulfillments/*` webhooks — no tracking numbers on the contact drawer |
| `read_products` | The Catalog screen stays empty |
| `read_discounts` | Cannot read existing discounts |
| `write_discounts` | Cart recovery sends **without** a discount code — quietly, by design, since a code failure must never block the reminder |

Two scopes are deliberately **not** requested, and should be removed if a
previous version added them: `read_product_listings` (for sales channels) and
`read_validations` (for checkout functions). Wasify is neither, and every extra
scope is one more thing the merchant sees at install time.

> Shopify refuses to register a webhook whose scope was not granted, and it
> does so **quietly at connect time**. The feature then simply never fires. A
> test in this repo pins every topic to the scope Shopify gates it on, so the
> two lists cannot drift.

### 4d. After changing scopes

Widening scopes does **not** apply to already-installed stores. Existing tokens
keep their old scopes until the merchant re-approves, so:

1. **Release** the new version in the Partner Dashboard.
2. In Wasify: **Integrations → Shopify → Reconnect**, and approve the new list.

The Catalog screen shows a reconnect banner when `write_discounts` is missing,
which is the usual symptom of a version released but never re-approved.

---

## Step 5 — Vercel

Import the repo, then **Settings → Environment Variables**. Add all of these to
**Production, Preview and Development**:

| Variable | Where it came from | Required? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Step 1d — Project URL | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Step 1d — anon / publishable | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Step 1d — service_role / secret | Yes |
| `ENCRYPTION_KEY` | Step 2 — `openssl rand -hex 32` | Yes |
| `CRON_SECRET` **or** `AUTOMATION_CRON_SECRET` | Step 2 — you invent it (`openssl rand -hex 24`). Set one; each uses a different header. | Yes |
| `META_APP_SECRET` | Step 3 — Meta App settings → Basic | Yes |
| `NEXT_PUBLIC_SITE_URL` | **This** project's Vercel domain — see the warning below | Yes |
| `SHOPIFY_CLIENT_ID` | Step 4 — Client ID | Only for Shopify |
| `SHOPIFY_CLIENT_SECRET` | Step 4 — Client secret | Only for Shopify |

**Four traps with `NEXT_PUBLIC_SITE_URL`:**

- **Never leave the example value.** `.env.example` ships
  `https://your-app.vercel.app`, and copying that file into Vercel wholesale
  carries the placeholder through as a real value. It looks fine — it *is* a
  valid URL — but it is not your domain, so Shopify replies *"The redirect_uri
  is not whitelisted"*, and the Integrations screen prints webhook URLs on a
  domain you do not own. The app now refuses to start OAuth in that state and
  says so, and `/api/health` marks the variable failed rather than present.
- **Use *this* project's domain.** Find it in Vercel under **Settings →
  Domains**, or on the deployment card as *Assigned domains*. If you also had
  an older Wasify project deployed, its domain is a different app — pointing
  this variable (or your cron jobs) at the old one means the new app never
  receives anything while everything still looks like it returns `200 OK`.
- **No trailing slash.** `https://your-project.vercel.app` — not `…app/`
- **Use the stable production domain**, not a per-deployment preview URL like
  `your-project-mcbp5vubg-you.vercel.app`. That changes on every build, and it
  builds the Shopify redirect and webhook callbacks — if it drifts, OAuth breaks.

Chicken-and-egg: you do not know the domain until the first deploy. Deploy
once, copy the domain, add the variable, then trigger a new build.

### Making a new build pick up changed variables

`NEXT_PUBLIC_*` values are baked in at build time, so changing them has no
effect until the app is rebuilt.

Vercel's **Deployments → ⋯ → Redeploy** sometimes refuses with:

> *This deployment can not be redeployed. Please try again from a fresh commit.*

That is expected for older deployments. Just push any new commit to the branch
Vercel treats as production and it will build automatically with the current
variables:

```bash
git commit --allow-empty -m "Rebuild with updated environment variables"
git push
```

Then confirm with `https://YOUR-APP.vercel.app/api/health`.

### Verify

Open `https://YOUR-APP.vercel.app/api/health`. It tells you exactly what is
missing:

```json
{
  "ok": true,
  "summary": "All environment variables are set.",
  "cron": {
    "tick": "https://your-app.vercel.app/api/cron/tick",
    "daily": "https://your-app.vercel.app/api/cron/daily",
    "authHeader": "x-cron-secret: <your AUTOMATION_CRON_SECRET>",
    "headerName": "x-cron-secret",
    "usingVariable": "AUTOMATION_CRON_SECRET"
  }
}
```

If `ok` is `false`, `missing.required` names each variable and what it breaks.
It reports presence only — it never shows a value.

---

## Step 6 — Scheduling with cron-job.org

Vercel Hobby only allows one cron run per day, which is far too coarse: the
first cart reminder fires 45 minutes after abandonment. So scheduling lives at
[cron-job.org](https://cron-job.org) instead, and this repo ships no
`vercel.json` — Next.js needs no configuration on Vercel.

Create **two** jobs.

### Job 1 — Wasify tick *(the important one)*

| Field | Value |
|---|---|
| Title | `Wasify tick` |
| URL | `https://YOUR-APP.vercel.app/api/cron/tick` |
| Schedule | **Every 15 minutes** — in the custom fields, minutes `0,15,30,45`, every hour, every day |
| Request method | `GET` |

Then open **Advanced** and add a header. **Which header depends on which
variable you set in Vercel:**

| If Vercel has… | Header key | Header value |
|---|---|---|
| `CRON_SECRET` | `Authorization` | `Bearer YOUR_SECRET` — the word `Bearer`, one space, then the secret |
| `AUTOMATION_CRON_SECRET` | `x-cron-secret` | `YOUR_SECRET` — the secret on its own, no prefix |

Not sure? `https://YOUR-APP.vercel.app/api/health` prints the exact line to use
under `cron.authHeader`.

Without the right header the endpoint returns `401` and nothing runs — but the
`401` body names the header it expected, so you are never guessing.

This job drives: COD reminders and no-reply cancellations, cart-recovery
reminders, automation waits, flow delays, queued broadcasts, snooze wake-ups.

### Job 2 — Wasify daily

| Field | Value |
|---|---|
| Title | `Wasify daily` |
| URL | `https://YOUR-APP.vercel.app/api/cron/daily` |
| Schedule | Once a day, `03:00` |
| Request method | `GET` |
| Header | the same header you used for Job 1 |

This one does the Shopify backfill, nightly RFM scoring, segment refresh and
log pruning. It never sends a message.

### Checking it works

A successful run returns `200` with a body like:

```json
{"ok":true,"duration_ms":812,"results":{"cod":{"reminders":0,"cancelled":0},
"recovery":{"sent":0,"stopped":0},"automations":0,"flows":0,
"broadcasts":{"started":0,"sent":0},"snooze":{"woken":0}}}
```

All zeros is correct when there is nothing due.

- `401` → wrong header for the variable you set, or the value does not match.
  The response body names the header this deployment expects.
- `503` → neither `CRON_SECRET` nor `AUTOMATION_CRON_SECRET` is set in Vercel

Or test it yourself:

```bash
# if you set CRON_SECRET
curl -i -H "Authorization: Bearer YOUR_SECRET" \
  https://YOUR-APP.vercel.app/api/cron/tick

# if you set AUTOMATION_CRON_SECRET
curl -i -H "x-cron-secret: YOUR_SECRET" \
  https://YOUR-APP.vercel.app/api/cron/tick
```

### ⚠️ Your existing cron jobs point at the old app

Your cron-job.org dashboard currently calls:

```
https://wasify-one.vercel.app/api/cod/cron           ← OLD app + OLD routes
https://wasify-one.vercel.app/api/shopify/cron/sync  ← OLD app + OLD routes
```

This rebuild consolidated those into `/api/cron/tick` and `/api/cron/daily`.
**Update both URLs**, or the new app's timers will never fire while the jobs
keep reporting `200 OK` from the old deployment.

Also: those jobs are currently running about **once a minute**. Every 15 minutes
is enough — the reminder stages are 45 min / 24 h / 48 h, so a minute-level
cadence just burns Vercel invocations for no benefit.

### Notes

- **Every 15 minutes is the recommended floor.** More often is harmless (every
  sweep is idempotent — running twice never double-sends) but pointless.
- cron-job.org times out long requests. If a run times out, the Vercel function
  usually finishes anyway, and if it does not the next tick resumes where it
  stopped. A red entry now and then is not data loss.
- Hobby has a monthly invocation allowance. Every 15 min ≈ 2,900 calls/month,
  comfortably inside it. Every minute ≈ 43,000.

---

## Step 7 — Connect WhatsApp

In the app: **Integrations → WhatsApp Cloud API → Connect**.

1. **Phone number ID** and **WhatsApp Business Account ID** — Meta App
   Dashboard → **WhatsApp → API Setup**. Both are shown on that page.
2. **Permanent access token** — same page. A temporary token expires in 24
   hours; for production create a System User token:
   Business Settings → Users → System Users → Add → assign your app with
   `whatsapp_business_messaging` and `whatsapp_business_management` →
   Generate token → choose **Never expire**.
3. Press **Generate** next to *Webhook verify token* and copy the value shown.
4. In Meta → **WhatsApp → Configuration → Edit**:
   - Callback URL: `https://YOUR-APP.vercel.app/api/whatsapp/webhook`
   - Verify token: the value from step 3
   - **Verify and save**, then **Manage** → subscribe to **messages**
5. Back in Wasify: **Run diagnostics**. It makes live Graph API calls and names
   whatever is wrong.
6. **Send test** — enter your own WhatsApp number.

> Message yourself from that number first. Outside the 24-hour window Meta only
> accepts template messages, so a free-text test will be refused until the
> customer has written to you.

---

## Step 8 — Connect Shopify

**Integrations → Shopify → Connect store** → enter `your-store.myshopify.com`
→ approve.

Webhooks are registered automatically on the way back. Then:

- **Integrations → COD order confirmation → Configure** — turn it on, pick your
  approved templates, set the reminder hours.
- **Integrations → Abandoned cart recovery → Configure** — turn it on, set the
  delays, pick templates and an optional discount.

Both stay off until you enable them, so nothing is sent by accident.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Deploy fails: *"Hobby accounts are limited to daily cron jobs"* | An old `vercel.json` with a `*/15` cron. Pull the latest — this repo declares none. |
| *"This deployment can not be redeployed. Please try again from a fresh commit."* | Vercel will not rebuild an older deployment. Push any commit (`git commit --allow-empty -m "rebuild"`) — the new build picks up your current environment variables. |
| Env var changed but the app behaves as before | `NEXT_PUBLIC_*` values are baked in at build time. A rebuild is required, not just saving the variable. |
| Everything looks fine but nothing reaches the app | The URL points at a different project. Check `NEXT_PUBLIC_SITE_URL` and your cron jobs against **Settings → Domains** for *this* project. |
| Deploy fails: *maxDuration must be between 1 and 60* | Same — pull the latest, all routes are 60s now. |
| Deploy fails: *`vercel.json` schema validation failed … should NOT have additional property* | Vercel rejects any key it does not recognise, including comment-style keys like `_note`. JSON has no comments. This repo ships **no `vercel.json`** at all — Next.js needs none. Delete the file or strip the offending key. |
| WhatsApp webhook returns `503` | `META_APP_SECRET` is not set. This is deliberate: an unverified webhook would let anyone who knows the URL inject messages into your inbox. |
| Webhook verification fails in Meta | The verify token does not match. Press **Generate** in Wasify again and re-paste. |
| Shopify OAuth: *"redirect_uri is not whitelisted"* | Read the `redirect_uri=` in the failing URL's address bar — it is exactly what Shopify was asked to accept. If it says `your-app.vercel.app`, `NEXT_PUBLIC_SITE_URL` is still the example value (Step 5). Otherwise **Redirect URLs** in the Partner Dashboard is empty or does not match it character-for-character — including the trailing slash. Both sides must agree. See Step 4b. |
| Shopify returns to `/api/shopify/callback` and the page shows **HTTP ERROR 500** | The OAuth handshake worked — the failure is storing the result. Almost always `ENCRYPTION_KEY` or `SUPABASE_SERVICE_ROLE_KEY` missing from Vercel. The callback now redirects back to Integrations with the variable named instead of a blank 500; `/api/health` reports the same thing. |
| Shopify connects, but no orders or carts arrive | A webhook could not be registered because its scope was missing. Check Step 4c — `checkouts/*` needs `read_orders`, `fulfillments/*` needs `read_fulfillments`. Then Release the version and **Reconnect**. |
| Cart reminders send with no discount code | `write_discounts` was not granted. Release the version, then Integrations → Shopify → Reconnect. |
| Shopify admin shows the app in a frame and login loops | **Embed app in Shopify admin** is ticked. Untick it — this app is not embedded, and its cookies are blocked inside that iframe. |
| Cron returns `401` | Usually the wrong header for the variable you set: `CRON_SECRET` needs `Authorization: Bearer <secret>`, `AUTOMATION_CRON_SECRET` needs `x-cron-secret: <secret>`. The `401` body names the right one. |
| Cart reminders never send | Recovery not enabled, no template set for that stage, or the cron job still points at the old app's URL. |
| Templates will not send | Only **Approved** templates can be sent. Press **Sync from Meta** on the Templates screen. |
| Login says *"Invalid login credentials"* right after signup | Email confirmation is on — check your inbox, or turn it off in Supabase → Authentication → Providers → Email. |

Whatever the symptom, `https://YOUR-APP.vercel.app/api/health` is the first
place to look.
