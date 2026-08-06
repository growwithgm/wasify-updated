# Back-in-Stock Widget — Theme Install Brief (for Claude Code)

Project: ibBan store theme · Backend: Wasify — `https://wasify-super.vercel.app`
Scope: **Sirf theme ka kaam.** Backend live hai aur test ho chuka hai — usay
chhuna nahi. Is brief ke saath ek file di gayi hai: `back-in-stock.liquid` —
widget ka poora code isi mein hai, likha hua aur ready. Tumhara kaam isay
theme mein sahi jagah install karna aur theme ke saath fit karna hai.

---

## 1. Kya ban chuka hai (context)

Product page par customer out-of-stock variant ke liye WhatsApp signup karta
hai. Restock par backend khud message bhejta hai. Backend ke teen hisse live
hain — tum sirf pehle wale se baat karo ge:

| Endpoint | Kaam | Tumhara wasta |
|---|---|---|
| `POST /api/stock/subscribe` | widget ka form yahan submit hota hai | **haan — widget isi ko call karta hai** |
| `POST /api/flow/inventory-restock` | Shopify Flow restock par ping karta hai | nahi |
| `GET /s/<code>` | WhatsApp button ka redirect | nahi |

`back-in-stock.liquid` snippet ye sab pehle se karta hai: sold-out detection,
button/link toggle, drawer, chips, consent, honeypot, fetch call. **Naya
widget mat likhna** — di hui file install karni hai.

## 2. Pehle theme dekh lo

Build shuru karne se pehle ye samajh lo:

* Product template kaunsa hai — OS 2.0 (`sections/main-product.liquid` +
  blocks) ya vintage (`templates/product.liquid`)
* Buy button / `product-form` kahan render hota hai — widget usi ke neeche aana hai
* Variant picker select hone par `form[action*="/cart/add"] [name="id"]` input
  update hota hai ya nahi — widget isi input se selected variant parhta hai
  (har standard theme — Dawn samet — ye karta hai)
* Theme variant-change par section ko AJAX se re-render karta hai ya nahi
  (Dawn karta hai) — agar karta hai to widget ka render call **usi section ke
  andar** hona chahiye taake wo bhi saath re-render ho

## 3. Install steps

1. `snippets/back-in-stock.liquid` banao — di hui file ka poora content paste karo
2. File ke top par check karo:
   ```liquid
   {%- assign wbis_app_url = 'https://wasify-super.vercel.app' -%}
   ```
   Yehi URL rehna hai. Store domains (`ibban.com`, `xmkm1p-vh.myshopify.com`)
   backend ke CORS allow-list mein already hain.
3. Product section mein, buy buttons ke **neeche** (size picker ke baad,
   aapke mockup ke mutabiq):
   ```liquid
   {% render 'back-in-stock', product: product %}
   ```
   OS 2.0 theme mein behtar: ek **custom liquid block** bana do jo ye render
   kare, taake merchant theme editor se position adjust kar sake.
4. Widget khud kuch render nahi karta jab product ka har variant available ho
   — conditional wrapping ki zaroorat nahi.

## 4. Theme ke saath fit karna (allowed changes)

* **CSS**: `.wbis-` classes ke colors/fonts theme ke design tokens se match
  kar sakte ho (button ka kala rang, border-radius, font-family). Layout aur
  behaviour mat badalna.
* **Text**: labels translate/adjust kar sakte ho (`Get notified`, `Notify me`,
  consent line) — Spanish store ke liye `locales` ke through ya seedha.
* Widget ki JS vanilla hai, koi dependency nahi — theme ke bundler mein daalne
  ki zaroorat nahi, snippet self-contained hai.

## 5. Test checklist

Test ke liye kisi product ke ek variant ka inventory 0 kar do (ya
`xmkm1p-vh.myshopify.com` dev store use karo).

* [ ] Sold-out variant select → bara **"Notify me about sold out items"** button dikhe
* [ ] Buyable variant select → chhota link dikhe count ke saath: `(1)`
* [ ] Variant switch karne par button/link theek toggle ho (Dawn ke AJAX re-render ke baad bhi)
* [ ] Drawer khule → jo variant customer ne select kiya tha wo chip pehle se ✓ ho
* [ ] Consent unchecked ya phone khali → submit disabled
* [ ] Submit → network tab mein `200` + `{ ok: true, added: n }`
* [ ] Wahi form dobara submit → `added` chhota aaye (duplicate rows nahi banti), UI phir bhi success dikhaye
* [ ] Ghalat phone (`123`) → drawer mein error message, form crash na ho
* [ ] Mobile viewport → drawer bottom-sheet ki tarah khule, page peeche scroll na ho
* [ ] Console mein koi error na ho

## 6. Do not

* `POST /api/stock/subscribe` ka **payload field names mat badalna** — backend
  isi contract par hai (`name, phone, email, hp, shop, locale, country_code,
  product_id, product_title, product_url, variants[]`). Kuch add/rename karna
  ho to pehle backend developer se baat karo.
* Honeypot field (`hp` / `.wbis-hp`) **mat hatana** — wo invisible hi theek
  hai, bot protection hai.
* Consent checkbox mat hatana aur na hi by-default checked karna — GDPR record
  isi par bana hai.
* Endpoint URL hardcode karke kahin aur mat le jana; `wbis_app_url` hi source
  of truth hai.
* Koi external JS/CSS library mat add karna — snippet self-contained hai.
* Backend endpoints ya Wasify repo ko chhuna nahi — sirf theme.

## 7. Agar masla aaye

* **CORS error console mein** → backend ke `STOCK_ALERT_ORIGINS` env mein
  storefront domain add karwana hoga — backend developer ko batao, khud
  workaround mat banao.
* **429 Too many requests** testing mein → rate limit hai (5/10min per IP) —
  10 minute ruk jao, bypass mat banao.
* **`400 Unknown shop`** → `shop` field `xmkm1p-vh.myshopify.com` hona chahiye
  (`shop.permanent_domain`), custom domain nahi.
