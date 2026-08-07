# Shopify Flow AI (Sidekick) — Prompts for the Wasify workflows

Shopify admin → **Flow → Create workflow → "Describe your workflow"** (ya
Sidekick se "create a Flow workflow" kehkar). Neeche wala prompt English mein
paste karein — Sidekick English par sab se theek chalta hai.

> ⚠️ AI builder HTTP-request action ke andar ke fields (URL, headers, body)
> aksar adhoore chhorta hai. Prompt ke baad **"Verify checklist"** zaroor
> chalayein — wahi asal kaam hai.

---

## Prompt 1 — Back-in-stock restock push

```
Create a workflow that notifies my external app when a product variant is
restocked.

Trigger: Product variant inventory quantity changed.

Condition: continue only if the variant's inventory quantity is greater
than 0.

Action: Send HTTP request with:
- HTTP method: POST
- URL: https://wasify-super.vercel.app/api/flow/inventory-restock
- Header 1: Content-Type = application/json
- Header 2: Authorization = Bearer MY_FLOW_SECRET
- Request body (JSON):
{
  "variant_id": "{{ productVariant.legacyResourceId }}",
  "product_id": "{{ productVariant.product.legacyResourceId }}",
  "available": "{{ productVariant.inventoryQuantity }}",
  "shop": "{{ shop.myshopifyDomain }}"
}
- On client error (4XX response): stop
- On server error (5XX or 429 response): retry

Name the workflow "Wasify — back in stock push".
```

Paste karne ke baad `MY_FLOW_SECRET` ko apne asli `FLOW_SECRET` se replace
karein (wahi jo Vercel mein hai).

### Verify checklist — Prompt 1

- [ ] Trigger exactly: **Product variant inventory quantity changed**
- [ ] Condition: `productVariant.inventoryQuantity` **>** `0`
- [ ] URL mein `/api/flow/inventory-restock` (typo nahi)
- [ ] `Authorization` header mein asli secret paste hua (placeholder nahi)
- [ ] Body ke charon fields mojood, Liquid variables **bilkul** upar jaise —
      khaas kar `legacyResourceId` (sirf `id` nahi, wo `gid://` deta hai;
      backend dono handle karta hai magar `legacyResourceId` saaf hai)
- [ ] 4XX = **stop**, 5XX = retry
- [ ] Workflow **Turn on** kiya (Test/simulate HTTP action nahi chala sakta —
      "can't be safely simulated" normal hai)

---

## Prompt 2 — Order confirmation push (agar dobara banana ho)

```
Create a workflow that sends new order data to my external app.

Trigger: Order created.

Condition: continue only if the order's customer phone number is not empty,
OR the shipping address phone is not empty, OR the billing address phone is
not empty.

Action: Send HTTP request with:
- HTTP method: POST
- URL: https://wasify-super.vercel.app/api/flow/order-confirmation
- Header 1: Content-Type = application/json
- Header 2: Authorization = Bearer MY_FLOW_SECRET
- Request body (JSON):
{
  "order_id": "{{ order.legacyResourceId }}",
  "order_name": "{{ order.name }}",
  "first_name": "{{ order.customer.firstName }}",
  "phone": "{{ order.customer.phone | default: order.shippingAddress.phone | default: order.billingAddress.phone }}",
  "total": "{{ order.totalPriceSet.shopMoney.amount }}",
  "currency": "{{ order.totalPriceSet.shopMoney.currencyCode }}",
  "status_url": "{{ order.statusPageUrl }}",
  "shop": "{{ shop.myshopifyDomain }}",
  "country_code": "{{ order.billingAddress.countryCode }}"
}
- On client error (4XX response): stop
- On server error (5XX or 429 response): retry

Name the workflow "Wasify — order confirmation push".
```

### Verify checklist — Prompt 2

- [ ] Trigger: **Order created**
- [ ] Phone condition teeno jagah check karti ho (customer / shipping / billing)
- [ ] `status_url` = `order.statusPageUrl` (custom string nahi)
- [ ] `shop` = `shop.myshopifyDomain` (custom domain nahi)
- [ ] 4XX = **stop**

---

## Common — dono ke liye

* Dono workflows **wahi ek `FLOW_SECRET`** use karte hain. Cron secrets
  (`CRON_SECRET` / `AUTOMATION_CRON_SECRET`) yahan kabhi nahi.
* Endpoint har us cheez par `200 { skipped: … }` deta hai jo retry se theek
  nahi ho sakti (invalid phone, duplicate, feature off) — is liye Flow ke
  run logs mein "success" ka matlab hamesha "message gaya" nahi hota; response
  body parhein.
* Test: workflow on karke asli event banayein (variant inventory 0 → 2, ya
  test order). Flow → workflow → **Runs** mein har run ka HTTP response
  dikhta hai — wahan `{"sent":1,...}` ya `{"skipped":...}` nazar aayega.
