# Back-in-Stock — Go-Live Brief

Widget theme mein lag chuka hai ✅. Ab do taraf kaam bacha hai: **App side**
(Supabase + Vercel + Meta) aur **Shopify side** (Flow workflow). Is tarteeb
se karein — har step agle par depend karta hai. Aakhir mein end-to-end test.

---

## A. App side

### A1. Supabase — schema update *(2 min)*

Supabase → SQL Editor → repo ki latest `supabase/schema.sql` poori paste →
Run. Idempotent hai — sirf nayi cheezein add hongi (`stock_alerts` table).

**Verify:** `https://wasify-super.vercel.app/api/health` kholein →
`DATABASE_SCHEMA: true` hona chahiye.

### A2. Vercel — environment variables *(2 min)*

| Variable | Value | Status |
|---|---|---|
| `FLOW_SECRET` | order-confirmation wala hi | pehle se hai — **dobara na banayein** |
| `STOCK_ALERT_ORIGINS` | `https://ibban.com,https://xmkm1p-vh.myshopify.com` | **naya — add karein** |
| `KLAVIYO_PRIVATE_KEY` | Klaviyo private API key | optional — email backup chahiye to |

Add karne ke baad **redeploy** (env build par lagti hai).

### A3. Meta — do templates *(10 min + review wait)*

WhatsApp Manager → Message templates → dono **ek saath** submit karein taake
review parallel ho. Category **Utility**, Type of variable **Number**.

**`back_in_stock_en`** — Language: English

```
Body:
Hi {{1}}, good news!

{{2}} is available again.

Stock is limited, so we recommend ordering soon.

Samples:  {{1}} = Ana    {{2}} = Bohemian Maxi Dress — Ivory / M

Button:  Visit website · "Buy now" · URL type: DYNAMIC
Website URL:  https://wasify-super.vercel.app/s/{{1}}
Sample URL:   https://wasify-super.vercel.app/s/abc23456
```

**`back_in_stock_es`** — Language: Spanish

```
Body:
¡Hola {{1}}! Buenas noticias.

{{2}} ya está disponible de nuevo.

Las unidades son limitadas, te recomendamos no esperar.

Samples:  {{1}} = Ana    {{2}} = Vestido Bohemio — Marfil / M

Button:  Visit website · "Comprar ahora" · URL type: DYNAMIC
Website URL:  https://wasify-super.vercel.app/s/{{1}}
Sample URL:   https://wasify-super.vercel.app/s/abc23456
```

Teen ghaltiyan jo send fail kar dengi:
- Naam **bilkul** `back_in_stock_en` / `back_in_stock_es` — ek harf ka farq = fail
- Button **Dynamic** ho, Static nahi
- Base URL **app ka domain** (`wasify-super.vercel.app/s/`), store ka nahi

> ⚠️ Meta inhe aksar **Marketing** reclassify kar deta hai (active order nahi
> hai, product promote ho raha hai). Spain mein Marketing rate Utility se
> mehnga hai — budget usi hisaab se, reclassify ho to hairan na hon.

### A4. Approve hone ke baad *(1 min)*

Wasify → **Templates → Sync from Meta**. Dono templates `APPROVED` dikhne
chahiye. Ye step bhoolna = restock par `status: failed` rows.

---

## B. Shopify side

### B1. Flow workflow *(5 min)*

Shopify admin → **Flow → Create workflow**:

**Trigger:** `Product variant inventory quantity changed`

**Condition:** `productVariant.inventoryQuantity` **is greater than** `0`
*(0 ya kam par workflow ruk jaye — backend bhi `available <= 0` skip karta
hai, ye double guard hai)*

**Action:** `Send HTTP request`

| Field | Value |
|---|---|
| HTTP method | `POST` |
| URL | `https://wasify-super.vercel.app/api/flow/inventory-restock` |
| Header 1 | `Content-Type: application/json` |
| Header 2 | `Authorization: Bearer <FLOW_SECRET>` *(bare secret bhi chalega, Bearer behtar)* |
| On client error (4XX) | **stop** — 4XX config problem hai, retry kuch nahi badalta |
| On server error (5XX/429) | **retry** |

**Body:**

```json
{
  "variant_id": "{{ productVariant.legacyResourceId }}",
  "product_id": "{{ productVariant.product.legacyResourceId }}",
  "available": "{{ productVariant.inventoryQuantity }}",
  "shop": "{{ shop.myshopifyDomain }}"
}
```

Phir **Turn on** karein. (Test-simulate se HTTP action nahi chalta — "can't
be safely simulated" normal hai, order-confirmation jaisa.)

**Note:** ye trigger har inventory change par chalta hai — sale par bhi.
Koi harm nahi: jis variant ke pending subscribers nahi, endpoint turant
`{sent: 0}` de deta hai, aur har subscriber ko zindagi mein sirf ek message
jata hai (row `sent` ho jati hai). Iska ek faida bhi hai: cap ki wajah se
pending reh jane wale log stock maujood rehne par agle events par apni baari
par message pa lete hain — FIFO.

### B2. Widget already ✅

Kuch nahi karna. Agar `STOCK_ALERT_ORIGINS` mein storefront domain theek hai
to signup chalega.

---

## C. End-to-end test *(10 min)*

1. **Test product tayar karein:** kisi product ke ek variant ka inventory
   **0** kar dein (Products → variant → Inventory).
2. **Signup:** storefront par us product ka sold-out variant kholen →
   "Notify me" → **apna WhatsApp number** + consent → submit.
   Network tab: `200` + `{ ok: true, added: 1 }`.
3. **Row check (optional):** Supabase → Table Editor → `stock_alerts` →
   nayi row, `status = pending`, `short_code` bana hua.
4. **Duplicate guard:** wahi form dobara submit → `added: 0`, koi nayi row nahi.
5. **Restock:** Shopify admin mein usi variant ka inventory **2** kar dein.
   Flow fire hoga → kuch seconds mein WhatsApp aayega:
   *"Hi Ana, good news! … — Buy now"*.
6. **Button:** Buy now dabayein → product page khule; Supabase mein us row ka
   `clicked_at` set ho jaye, `status = sent`.
7. **Inbox check:** Wasify Inbox mein message bot ke taur par mirror hua ho.
8. **Cap test (optional):** 10 signups (alag numbers), inventory `2` karein →
   sirf **6** message jayen (`2 × 3`), 4 rows `pending` rahen.

## D. Agar kuch na chale — pehli nazar yahan

| Symptom | Wajah |
|---|---|
| Widget submit par CORS error | `STOCK_ALERT_ORIGINS` mein storefront domain nahi / redeploy nahi hua |
| Submit `400 Unknown shop` | body mein `shop` custom domain ja raha hai — `permanent_domain` hona chahiye (widget theek bhejta hai) |
| Flow run success, WhatsApp nahi aaya | `stock_alerts` row dekhen: `failed` = template sync/approve nahi (A4), `pending` hi hai = Flow body ka `variant_id` match nahi kar raha |
| Har message `failed` | Template naam ghalat ya Dynamic button nahi |
| Flow mein 401 | `FLOW_SECRET` header ghalat — 401 ka body khud batata hai kya bhejna hai |
| Message aya magar button 404 | Template ka base URL store domain par hai — `wasify-super.vercel.app/s/` hona chahiye |

Har jawab pehle `https://wasify-super.vercel.app/api/health` se shuru karein.
