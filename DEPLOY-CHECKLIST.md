# WASIFY — FINAL DEPLOY CHECKLIST (popup + consent gate release)

Tarteeb TOOTNI nahi chahiye: schema pehle, one-off uske baad, extension
sab se aakhir mein. Har step ke neeche "VERIFY" — woh pass hue baghair
agla step shuru na karein.

---

## 1. Supabase — schema.sql

Supabase → SQL Editor → poora `supabase/schema.sql` paste → Run.
(Idempotent hai — dobara chalana hamesha safe.)

Is run mein aata hai: popup ke saare columns (multi-trigger, teaser,
devices, locale-strip, default page rules `["/", "/products/*"]`),
`popup_events`, `shopify_push_queue`, consent_events ke proof columns
(consent_text/page_url/ip/phone), suppression `re_opted_in_at`, aur
naye defaults (delay2 2160 / cooldown 14 / expiry 2 — sirf NAYI rows
ke liye).

**VERIFY:**
```sql
select popup_enabled, popup_trigger_delay, popup_strip_locale,
       popup_include_paths from shopify_config limit 1;
select count(*) from shopify_push_queue;   -- 0, error nahi
```

## 2. Supabase — one-off-consent-gate.sql

Usi editor mein `supabase/one-off-consent-gate.sql` → Run. (Re-run safe.)

Yeh karta hai: mojooda non-consented `active` recovery rows foran
`skipped_no_consent`; aap ki store row per delay2=2160, cooldown=14;
saare discounts ki expiry=2.

**VERIFY:**
```sql
select status, count(*) from checkout_recoveries group by 1;
-- 'active' sirf opted-in contacts ke liye bacha ho (shuru mein 0 hoga)
select recovery_delay2_minutes, recovery_cooldown_days from shopify_config;
-- 2160, 14
```

## 3. Vercel — env + deploy

1. Vercel → Settings → Environment Variables: `NEXT_PUBLIC_SITE_URL`
   ke aakhir mein `/` NA ho. `CRON_SECRET`, `SUPABASE_*`,
   `SHOPIFY_CLIENT_ID/SECRET`, `ENCRYPTION_KEY`, `FLOW_SECRET` mojood hon.
   (`SHOPIFY_PROXY_SECRET` optional — na ho to client secret use hota hai.)
2. Branch `claude/new-feature-fresh-version-y0nc8l` ka production deploy.

**VERIFY:** App kholen → sidebar mein **Popup** entry dikhe aur page
khule. `/api/health` green ho.

## 4. Wasify Admin — template + popup config

1. **Templates:** welcome/code template Meta per Approved ho —
   contract: body mein `{{1}}` = discount code (ya 0 variables), aur/ya
   copy-code button. **Templates → Sync from Meta** chala lein.
2. **Popup page:**
   - **Consent checkbox text: APNA legal text** — brand ka naam + lafz
     "WhatsApp" dono ho. (English defaults ke sath go-live NAHI.)
   - Heading / subheading / button / success / disclaimer
   - Discount select + WhatsApp template select
   - Triggers (default: delay 5s ON), Devices, page rules (default
     home + products theek hai), teaser text
   - **Enable ON** → Save

**VERIFY:** Green banner "Live — visitors on matching pages…" dikhe
(amber ho to wajah wahi likhi hai). Path tester mein
`/en-es/products/summer-dress` ✓ green aur `/fr/collections/sale` ✗ red ho.

## 5. Shopify CLI — extension deploy

Repo clone mein, terminal:
```bash
npm install -g @shopify/cli@latest
shopify app config link    # org → "Wasify Super DC" — dashboard config toml mein utarti hai
shopify app deploy         # extension + config ki nayi version release
```
`config link` PEHLE — warna deploy dashboard settings mita sakta hai.

Sath Partner Dashboard → app → Configuration → **App proxy** check:
Prefix `apps`, Subpath `wasify`, URL `https://wasify-super-tan.vercel.app/proxy`.

**VERIFY:** Partner Dashboard → Versions → nayi version Active, usmein
"Wasify WhatsApp Popup" extension listed ho.

## 6. Theme — App embed ON

Store admin → Online Store → Themes → **Customize** → App embeds →
**Wasify WhatsApp Popup** → ON → Save.
(Agar proxy subpath `/apps/wasify` se mukhtalif hai to block ki setting
mein wahi likhein.)

**VERIFY:** Incognito mein storefront kholen — agle step ka smoke test.

## 7. SMOKE TEST — go-live se pehle, isi tarteeb se

1. **Popup dikhta hai:** incognito → home ya product page → (EU cookie
   banner ho to Accept) → 5s delay ke baad popup aaye.
2. **Locale test (16 markets):** kisi locale-prefixed product page per
   (`/de/products/...` ya `/en-es/products/...`) popup **aaye**; usi
   locale ke collections page per **na** aaye.
3. **Rules:** `/cart` aur koi collections page → popup na aaye.
4. **Teaser:** popup ✕ karein → kinare per teaser tab aa jaye → reload →
   popup nahi, sirf teaser → teaser click → popup khule.
5. **Consent + code:** apne number se submit → success + code screen
   per; WhatsApp per template + wohi code; Admin → Popup stats mein
   submit +1; Contacts mein contact `opted_in` (source popup);
   Supabase `consent_events` ki nayi row mein `consent_text` (aap ka
   poora text), `page_url`, `ip` bhare hon.
6. **Shopify push:** Shopify admin → Customers → woh number
   `wasify-popup` tag ke sath ho. (Protected Customer Data approval
   pending ho to row `shopify_push_queue` mein hogi — approval ke baad
   tick khud push kar dega; yeh fail nahi, intezar hai.)
7. **Gate ROKTA hai (sab se aham):** kisi DOOSRE number se (opted-in
   nahi) checkout shuru kar ke chhorein → Abandoned carts per row
   "No marketing opt-in" ke sath aaye, aur 45+ min tak koi message NA
   jaye.
8. **Gate KHOLTA hai:** step-5 wale opted-in number se checkout
   chhorein → 45 min baad reminder 1 aaye (button mein cart link +
   `?discount=CODE`).
9. **Logged-in skip:** jis number/account se subscribe kiya usi Shopify
   customer account se login ho kar (naye browser mein) store kholen →
   popup NA aaye.
10. **STOP re-consent:** test number se STOP bhejein, phir popup
    bharein → code AAYE, lekin Settings → Suppression list mein
    "Re-consented" badge ke sath raha aur recovery NA jaye — jab tak
    aap khud Remove na karein.

## 8. AGLE DIN — retention verify

Daily cron (03:00 UTC) ke baad Supabase mein:
```sql
select pg_size_pretty(sum(pg_column_size(payload))) from shopify_webhook_events;
-- pehle se numayan kam (24h+ purane processed payloads null ho chuke)
select count(*) from shopify_webhook_events where created_at < now() - interval '7 days';
-- 0 ki taraf (bara backlog batches mein kai dinon mein nikalta hai)
```
Yaad rahe: dashboard ka disk number aahista girta hai — jagah pehle
andar re-use hoti hai.

---

Kahin atkein → us step ka screenshot + error text kaafi hai.
