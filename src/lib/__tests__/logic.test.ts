import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { sanitizePhone, isValidPhone, phonesMatch, phoneVariants, extractShopifyPhone, initialsOf } from '@/lib/phone'
import { sessionWindow, canSendFreeText, appendMessage, WINDOW_MS } from '@/lib/window'
import { normalize, matchesKeyword } from '@/lib/engines/types'
import { isCodOrder, buildOrderVars } from '@/lib/engines/cod'
import { urlSuffix, reminderPatch, MAX_SEND_ATTEMPTS, recoveryAnchor, tooOldToStart } from '@/lib/engines/recovery'
import { matchesDefinition, rfmLabel } from '@/lib/engines/segments'
import { bestFaq } from '@/lib/engines/chatbot'
import { validateTemplate } from '@/app/api/templates/[id]/submit/route'
import { validateNodes } from '@/app/api/flows/[id]/route'
import { normalizeShopDomain } from '@/app/api/shopify/connect/route'
import { rowTagNames } from '@/app/api/contacts/import/route'
import { recoveryLabel } from '@/app/(app)/carts/page'
import { numericId, orderNodeToPayload, checkoutNodeToPayload } from '@/lib/shopify/sync'
import { graphqlTopic, restTopic } from '@/lib/shopify/webhooks'
import { makeCode, isValidCode, toMetaPhone, formatOrderTotal, flowAuthOk } from '@/lib/flow/order-confirmation'
import { variantLabel, restockCap, originAllowed, bisTags, verifyProxySignature } from '@/lib/flow/stock-alerts'
import { isAuthorizedCron, cronAuthHint, cronUnauthorizedBody } from '@/lib/cron'
import { siteUrl, siteUrlStatus, PLACEHOLDER_SITE_HOSTS } from '@/lib/site-url'
import {
  countVariables,
  templateShape,
  paramMismatch,
  explainMetaError,
} from '@/lib/whatsapp/template-params'

/* ------------------------------------------------------------------ */
/* Phone rules — the dedupe path everything else depends on            */
/* ------------------------------------------------------------------ */

describe('phone', () => {
  it('strips everything that is not a digit', () => {
    expect(sanitizePhone('+34 600 123-456')).toBe('34600123456')
    expect(sanitizePhone('(0034) 600.123.456')).toBe('0034600123456')
    expect(sanitizePhone(null)).toBe('')
  })

  it('rejects numbers without a country code', () => {
    expect(isValidPhone('34600123456')).toBe(true)
    expect(isValidPhone('0600123456')).toBe(false) // leading trunk zero
    expect(isValidPhone('123456')).toBe(false) // too short
    expect(isValidPhone('1234567890123456')).toBe(false) // too long
  })

  it('matches the same person across formatting differences', () => {
    expect(phonesMatch('+34 600 123 456', '34600123456')).toBe(true)
    expect(phonesMatch('34600123456', '0034600123456')).toBe(true) // last 8 digits
    expect(phonesMatch('34600123456', '34600123457')).toBe(false)
    expect(phonesMatch('', '34600123456')).toBe(false)
  })

  it('does not match on fewer than 8 shared digits', () => {
    expect(phonesMatch('1234567', '9991234567')).toBe(false)
  })

  it('offers trunk-zero variants for Meta #131030 retries', () => {
    const variants = phoneVariants('340600123456')
    expect(variants).toContain('340600123456')
    expect(variants).toContain('34600123456') // trunk 0 removed after the 2-digit CC
  })

  it('finds a phone anywhere Shopify hides one', () => {
    expect(extractShopifyPhone({ phone: '+34600123456' })).toBe('34600123456')
    expect(extractShopifyPhone({ customer: { phone: '+34600123456' } })).toBe('34600123456')
    expect(extractShopifyPhone({ shipping_address: { phone: '+34600123456' } })).toBe('34600123456')
    expect(extractShopifyPhone({ phone: '0600123456' })).toBe('') // invalid, keep looking
    expect(extractShopifyPhone({})).toBe('')
  })

  it('builds readable initials', () => {
    expect(initialsOf('María García')).toBe('MG')
    expect(initialsOf('Lucía')).toBe('LU')
    expect(initialsOf(null, '34600123456')).toBe('56')
  })
})

/* ------------------------------------------------------------------ */
/* 24-hour window                                                      */
/* ------------------------------------------------------------------ */

describe('24h customer-service window', () => {
  it('is open just inside 24 hours', () => {
    const at = new Date(Date.now() - (WINDOW_MS - 60_000)).toISOString()
    expect(sessionWindow(at).open).toBe(true)
    expect(canSendFreeText(at)).toBe(true)
  })

  it('is closed just past 24 hours', () => {
    const at = new Date(Date.now() - (WINDOW_MS + 1000)).toISOString()
    expect(sessionWindow(at).open).toBe(false)
    expect(sessionWindow(at).label).toBe('expired')
    expect(canSendFreeText(at)).toBe(false)
  })

  it('is closed when the customer has never written', () => {
    expect(canSendFreeText(null)).toBe(false)
    expect(sessionWindow(null).label).toBe('no reply yet')
  })

  it('formats the remaining time', () => {
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString()
    expect(sessionWindow(at).label).toMatch(/^2[12]h \d+m$/)
  })
})

/* ------------------------------------------------------------------ */
/* Keyword matching — COD replies and STOP words                       */
/* ------------------------------------------------------------------ */

describe('keyword matching', () => {
  it('ignores accents and case', () => {
    expect(normalize('SÍ')).toBe('si')
    expect(matchesKeyword('Sí, confirmo', 'si')).toBe(true)
    expect(matchesKeyword('SI', 'sí')).toBe(true)
  })

  it('matches whole words only', () => {
    expect(matchesKeyword('quiero parar esto', 'parar')).toBe(true)
    expect(matchesKeyword('separar los pedidos', 'parar')).toBe(false)
  })

  it('survives surrounding punctuation', () => {
    expect(matchesKeyword('STOP.', 'stop')).toBe(true)
    expect(matchesKeyword('¡No!', 'no')).toBe(true)
  })

  it('does not match an empty needle or haystack', () => {
    expect(matchesKeyword('', 'stop')).toBe(false)
    expect(matchesKeyword('stop', '')).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* COD                                                                 */
/* ------------------------------------------------------------------ */

describe('COD detection', () => {
  const gateways = ['cash on delivery', 'contra reembolso', 'cod']

  it('detects a COD gateway by name', () => {
    expect(isCodOrder({ gateway: 'Cash on Delivery (COD)' }, gateways)).toBe(true)
    expect(isCodOrder({ payment_gateway_names: ['Contra reembolso'] }, gateways)).toBe(true)
  })

  it('treats a pending order with no gateway as COD', () => {
    expect(isCodOrder({ financial_status: 'pending', payment_gateway_names: [] }, gateways)).toBe(true)
  })

  it('does not flag a paid card order', () => {
    expect(isCodOrder({ gateway: 'shopify_payments', financial_status: 'paid' }, gateways)).toBe(false)
  })

  it('maps order fields into template variables', () => {
    const order = {
      customer_name: 'María García',
      order_number: '#ES-4821',
      total_price: 86.9,
      currency: 'EUR',
      items_count: 3,
      shipping_city: 'Valencia',
    }
    const vars = buildOrderVars(order, [
      { source: 'first_name' },
      { source: 'order_number' },
      { source: 'items_count' },
      { source: 'static', value: 'gracias' },
    ])
    expect(vars[0]).toBe('María')
    expect(vars[1]).toBe('#ES-4821')
    expect(vars[2]).toBe('3')
    expect(vars[3]).toBe('gracias')
  })

  it('falls back gracefully when the name is missing', () => {
    expect(buildOrderVars({ customer_name: null }, [{ source: 'first_name' }])[0]).toBe('cliente')
  })
})

/* ------------------------------------------------------------------ */
/* Recovery URL suffix — the Meta dynamic-button rule                  */
/* ------------------------------------------------------------------ */

describe('recovery URL suffix', () => {
  it('returns path and query only, never the domain', () => {
    const url = 'https://maison-vela.myshopify.com/cart/c/abc123?key=xyz'
    expect(urlSuffix(url)).toBe('cart/c/abc123?key=xyz')
  })

  it('injects the discount code into the query', () => {
    const out = urlSuffix('https://store.myshopify.com/cart/c/abc', 'VELA-MARIA-8F3K')
    expect(out).toBe('cart/c/abc?discount=VELA-MARIA-8F3K')
  })

  it('returns null for a missing or malformed URL', () => {
    expect(urlSuffix(null)).toBeNull()
    expect(urlSuffix('not a url')).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Segments                                                            */
/* ------------------------------------------------------------------ */

describe('thread append', () => {
  const m = (id: string) => ({ id, content: id })

  it('never adds the same message twice', () => {
    // A send delivers the row to the client TWICE — once over realtime, once
    // as the POST response. The template path appended both, so every
    // template showed twice in the inbox while WhatsApp had sent it once.
    const prev = [m('a'), m('b')]
    expect(appendMessage(prev, m('b'))).toEqual(prev)
    expect(appendMessage(prev, m('c'))).toEqual([m('a'), m('b'), m('c')])
  })

  it('swaps an optimistic placeholder for the saved row', () => {
    expect(appendMessage([m('a'), m('tmp-1')], m('real'), 'tmp-1')).toEqual([m('a'), m('real')])
  })

  it('drops the placeholder even when the row already arrived', () => {
    expect(appendMessage([m('tmp-1'), m('real')], m('real'), 'tmp-1')).toEqual([m('real')])
  })

  it('tolerates a missing message', () => {
    expect(appendMessage([m('a')], null)).toEqual([m('a')])
    expect(appendMessage([m('a'), m('tmp-1')], undefined, 'tmp-1')).toEqual([m('a')])
  })

  it('is the only appender in the inbox, so the paths cannot diverge again', () => {
    // The free-text path deduped and the template path did not — one helper
    // now serves both, and a raw spread would reintroduce the split.
    const client = readFileSync(join(process.cwd(), 'src/app/(app)/inbox/InboxClient.tsx'), 'utf8')
    const rawAppends = client.match(/setMessages\(\(prev\) => \[\s*\.\.\.prev,/g) ?? []
    // The one permitted raw append is the optimistic placeholder, which has no
    // server id yet and therefore nothing to dedupe against.
    expect(rawAppends.length, 'use appendMessage() instead of spreading into setMessages').toBeLessThanOrEqual(1)
  })
})

describe('carts page recovery label', () => {
  it('never claims a recovery from the tracking row', () => {
    // 'done' means three reminders were sent, NOT that the customer paid.
    // Conversion is the checkout's own recovered/completed_at, rendered as a
    // separate pill — reading it from here would invent revenue.
    const done = recoveryLabel({ status: 'done', remindersSent: 3 }, true)
    expect(done.text).toBe('Reminder 3 sent')
    expect(done.text).not.toMatch(/recovered/i)
  })

  it('distinguishes every terminal state', () => {
    expect(recoveryLabel({ status: 'opted_out', remindersSent: 1 }, true).text).toBe('Opted out')
    expect(recoveryLabel({ status: 'suppressed_cooldown', remindersSent: 0 }, true).text).toMatch(/cooldown/)
    expect(recoveryLabel({ status: 'skipped_no_phone', remindersSent: 0 }, false).text).toMatch(/number missing/)
    expect(recoveryLabel({ status: 'completed_order', remindersSent: 1 }, true).text).toMatch(/order placed/)
    expect(recoveryLabel({ status: 'active', remindersSent: 0 }, true).text).toBe('Recovery scheduled')
  })

  it('flags a missing number even before a tracking row exists', () => {
    expect(recoveryLabel(null, false).text).toMatch(/number missing/)
    expect(recoveryLabel(null, true).text).toBe('No recovery yet')
  })
})

describe('order confirmation flow', () => {
  it('formats the total in the currency\'s own convention', () => {
    expect(formatOrderTotal(48.9, 'EUR')).toBe('€48,90') // comma decimal
    expect(formatOrderTotal('48.9', 'eur')).toBe('€48,90')
    expect(formatOrderTotal(48.9, 'GBP')).toBe('£48.90')
    expect(formatOrderTotal(48.9, 'USD')).toBe('$48.90')
    expect(formatOrderTotal(48.9, 'AED')).toBe('48.90 AED') // unknown → suffix
    expect(formatOrderTotal(null, null)).toBe('€0,00')
  })

  it('normalises phones to digits-only E.164 with the order\'s country', () => {
    // Meta wants no plus sign.
    expect(toMetaPhone('+34 600 123 456')).toBe('34600123456')
    expect(toMetaPhone('600 123 456', 'ES')).toBe('34600123456') // national + region
    expect(toMetaPhone('07429 917026', 'GB')).toBe('447429917026') // trunk 0 dropped
    expect(toMetaPhone('600123456')).toBe('34600123456') // no region → ES fallback
  })

  it('returns null for an invalid phone instead of throwing', () => {
    // The route answers 200 { skipped } — an error would make Shopify Flow
    // retry a phone that will be exactly as invalid the fifth time.
    expect(toMetaPhone('12')).toBeNull()
    expect(toMetaPhone('')).toBeNull()
    expect(toMetaPhone(null)).toBeNull()
    expect(toMetaPhone('not a phone')).toBeNull()
  })

  it('mints 8-char codes with no lookalike characters', () => {
    for (let i = 0; i < 50; i++) {
      const code = makeCode()
      expect(code).toHaveLength(8)
      expect(code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]+$/) // no 0/o, 1/l/i
      expect(isValidCode(code)).toBe(true)
    }
    expect(isValidCode('has-0-l1')).toBe(false)
    expect(isValidCode('short')).toBe(false)
  })

  it('accepts the secret with or without the Bearer prefix', () => {
    // Shopify Flow's header field is free text; pasting the value without
    // typing "Bearer " is the most common mistake, and both shapes carry the
    // identical secret — rejecting one only manufactures 401 retry loops.
    expect(flowAuthOk('Bearer s3cret', 's3cret')).toBe(true)
    expect(flowAuthOk('s3cret', 's3cret')).toBe(true)
    expect(flowAuthOk(' s3cret ', 's3cret')).toBe(true) // stray whitespace
    expect(flowAuthOk('Bearer wrong', 's3cret')).toBe(false)
    expect(flowAuthOk('', 's3cret')).toBe(false)
    expect(flowAuthOk(null, 's3cret')).toBe(false)
  })

  it('keeps the endpoint fail-closed and the redirect public', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/flow/order-confirmation/route.ts'), 'utf8')
    expect(route).toContain('FLOW_SECRET')
    expect(route).toContain('flowAuthOk') // timing-safe via safeEqual inside
    expect(route).toContain("'23505'") // duplicate order → skipped, not error
    // The short-link redirect and the Flow endpoint must be reachable
    // without a session, or the button 302s to the login page.
    const middleware = readFileSync(join(process.cwd(), 'src/middleware.ts'), 'utf8')
    expect(middleware).toContain("'/o/'")
    expect(middleware).toContain("'/api/flow/'")
  })
})

describe('back-in-stock alerts', () => {
  it('drops "Default Title" from the message label', () => {
    // Shopify names a one-variant product's variant "Default Title" —
    // "Bohemian Maxi Dress — Default Title" must never reach a customer.
    expect(variantLabel('Bohemian Maxi Dress', 'Ivory / M')).toBe('Bohemian Maxi Dress — Ivory / M')
    expect(variantLabel('Bohemian Maxi Dress', 'Default Title')).toBe('Bohemian Maxi Dress')
    expect(variantLabel('Bohemian Maxi Dress', 'default title')).toBe('Bohemian Maxi Dress')
    expect(variantLabel('Bohemian Maxi Dress', null)).toBe('Bohemian Maxi Dress')
    expect(variantLabel(null, 'M')).toBe('This product — M')
  })

  it('caps the fan-out at three messages per restocked unit', () => {
    // 200 pending, 5 units in: uncapped, 195 people land on a sold-out page
    // and the block/report rate sinks the WhatsApp quality rating.
    expect(restockCap(200, 5)).toBe(15)
    expect(restockCap(10, 2)).toBe(6) // brief's own test case: 6 sent, 4 stay
    expect(restockCap(2, 5)).toBe(2) // never more than pending
    expect(restockCap(10, 0)).toBe(0)
    expect(restockCap(10, -3)).toBe(0)
    expect(restockCap(10, 2.9)).toBe(6) // fractional inventory floors, not rounds
  })

  it('matches origins by hostname, www-insensitively', () => {
    // "Failed to fetch" with no diagnosis was exactly this: the storefront on
    // www.ibban.com against an allow-list entry of ibban.com.
    const list = 'https://ibban.com,https://xmkm1p-vh.myshopify.com'
    expect(originAllowed('https://ibban.com', list)).toBe(true)
    expect(originAllowed('https://www.ibban.com', list)).toBe(true)
    expect(originAllowed('https://IBBAN.com', list)).toBe(true)
    expect(originAllowed('https://xmkm1p-vh.myshopify.com', list)).toBe(true)
    expect(originAllowed('https://evil.com', list)).toBe(false)
    expect(originAllowed(null, list)).toBe(false)
    expect(originAllowed('https://anything.com', '')).toBe(true) // no list = open
    expect(originAllowed('https://anything.com', undefined)).toBe(true)
  })

  it('builds the customer tags: one marker plus one per variant, deduped', () => {
    expect(bisTags(['456', 789])).toEqual(['back-in-stock', 'bis-456', 'bis-789'])
    expect(bisTags(['456', '456'])).toEqual(['back-in-stock', 'bis-456'])
    expect(bisTags([])).toEqual(['back-in-stock'])
  })

  it('verifies the Shopify app-proxy signature', () => {
    // Shopify's algorithm: params minus signature, repeated values joined by
    // commas, pairs sorted and concatenated with NO separators, HMAC hex.
    const secret = 'shpss_test'
    const params = new URLSearchParams({
      shop: 'xmkm1p-vh.myshopify.com',
      path_prefix: '/apps/wasify',
      timestamp: '1785275422',
    })
    const message = 'path_prefix=/apps/wasifyshop=xmkm1p-vh.myshopify.comtimestamp=1785275422'
    params.set('signature', createHmac('sha256', secret).update(message).digest('hex'))

    expect(verifyProxySignature(params, secret)).toBe(true)
    expect(verifyProxySignature(params, 'wrong-secret')).toBe(false)

    params.set('shop', 'evil.myshopify.com') // tampering breaks it
    expect(verifyProxySignature(params, secret)).toBe(false)
    expect(verifyProxySignature(new URLSearchParams(), secret)).toBe(false) // no signature at all
  })

  it('never touches marketing consent when mirroring the customer', () => {
    // The customer consented to ONE WhatsApp notification. Setting either
    // consent field routes them into Klaviyo's marketing lists — a GDPR
    // violation dressed as a convenience.
    const lib = readFileSync(join(process.cwd(), 'src/lib/shopify/customers.ts'), 'utf8')
    // As INPUT FIELDS — the doc comment naming the rule is allowed to.
    expect(lib).not.toMatch(/emailMarketingConsent\s*:/)
    expect(lib).not.toMatch(/smsMarketingConsent\s*:/)
    expect(lib).toContain('tagsAdd')
    // And the scope it needs is actually requested.
    const admin = readFileSync(join(process.cwd(), 'src/lib/shopify/admin.ts'), 'utf8')
    expect(admin).toContain("'write_customers'")
  })

  it('ships a widget that speaks the subscribe contract exactly', () => {
    // The payload shape is a contract; if the widget and the endpoint drift,
    // signups silently stop. Pin every field the endpoint reads.
    const widget = readFileSync(join(process.cwd(), 'storefront/back-in-stock.liquid'), 'utf8')
    for (const field of ['name', 'phone', 'email', 'hp', 'shop', 'locale', 'country_code', 'product_id', 'product_title', 'product_url', 'variants']) {
      expect(widget, `widget payload is missing "${field}"`).toContain(`${field}:`)
    }
    expect(widget).toContain('/api/stock/subscribe')
    expect(widget).toContain('wbis-hp') // honeypot stays invisible, not deleted
  })

  it('keeps the endpoints on the shared patterns', () => {
    const restock = readFileSync(join(process.cwd(), 'src/app/api/flow/inventory-restock/route.ts'), 'utf8')
    // Same auth as order-confirmation; the same shared sender — a second send
    // path would bypass template resolution and error handling.
    expect(restock).toContain('flowAuthOk')
    expect(restock).toContain('FLOW_SECRET')
    expect(restock).toContain('sendWhatsApp')
    expect(restock).toContain('restockCap')
    expect(restock).toMatch(/ascending: true/) // FIFO
    expect(restock).toContain('bis_enabled') // the merchant's master switch

    const subscribe = readFileSync(join(process.cwd(), 'src/app/api/stock/subscribe/route.ts'), 'utf8')
    expect(subscribe).toContain("'23505'") // duplicate signup: skip row, not fail request
    expect(subscribe).toContain('hp') // honeypot answers 200 with nothing inserted
    expect(subscribe).toContain('consent_ip') // GDPR record

    // Public paths — without these the widget gets a login redirect.
    const middleware = readFileSync(join(process.cwd(), 'src/middleware.ts'), 'utf8')
    expect(middleware).toContain("'/api/stock/'")
    expect(middleware).toContain("'/s/'")
  })
})

describe('recovery freshness window', () => {
  const now = Date.parse('2026-08-05T12:00:00Z')
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString()

  it('measures age from the CART, never from the tracking row', () => {
    // The bug this exists for: a backfill created the tracking row today for
    // a checkout abandoned in March, the sweep measured age from row
    // creation, and a five-month-old cart got "you left something behind".
    const checkout = { abandoned_at: '2026-03-01T10:00:00Z', shopify_created_at: '2026-03-01T10:00:00Z' }
    const row = { created_at: hoursAgo(0.05) } // inserted 3 minutes ago
    expect(recoveryAnchor(checkout, row)).toBe('2026-03-01T10:00:00Z')
    expect(tooOldToStart(recoveryAnchor(checkout, row), 0, 24, now)).toBe(true)
  })

  it('lets a fresh cart start, and blocks one just past the window', () => {
    expect(tooOldToStart(hoursAgo(2), 0, 24, now)).toBe(false)
    expect(tooOldToStart(hoursAgo(23.9), 0, 24, now)).toBe(false)
    expect(tooOldToStart(hoursAgo(24.1), 0, 24, now)).toBe(true)
  })

  it('never interrupts a sequence already in flight', () => {
    // Reminder 3 fires at 48h BY DESIGN — the window gates starting, not
    // finishing. A cart messaged at hour 2 still gets its full ladder.
    expect(tooOldToStart(hoursAgo(30), 1, 24, now)).toBe(false)
    expect(tooOldToStart(hoursAgo(50), 2, 24, now)).toBe(false)
  })

  it('refuses to guess when the age is unknowable', () => {
    expect(tooOldToStart(null, 0, 24, now)).toBe(true)
    expect(tooOldToStart(undefined, 0, 24, now)).toBe(true)
  })

  it('honours a merchant-configured window', () => {
    expect(tooOldToStart(hoursAgo(30), 0, 48, now)).toBe(false) // 48h configured
    expect(tooOldToStart(hoursAgo(5), 0, 4, now)).toBe(true) // 4h configured
  })
})

describe('recovery reminder retries', () => {
  const at = () => 'NOW'

  it('marks the stage sent and clears the error on success', () => {
    const p = reminderPatch(1, { ok: true }, 0, at)
    expect(p).toMatchObject({ reminders_sent: 1, reminder1_sent_at: 'NOW', last_error: null, send_attempts: 0 })
  })

  it('does NOT consume the reminder when the send failed', () => {
    // The bug this guards: a template with a static button failed, the stage
    // was marked sent anyway, and all three reminders were burned in silence.
    // Correcting the template then did nothing for carts already in flight.
    const p = reminderPatch(1, { ok: false, error: 'static button' }, 0, at)
    expect(p.reminders_sent).toBeUndefined()
    expect(p.reminder1_sent_at).toBeUndefined()
    expect(p).toMatchObject({ last_error: 'static button', send_attempts: 1 })
  })

  it('gives up after the cap so a broken setup cannot retry forever', () => {
    const last = reminderPatch(1, { ok: false, error: 'nope' }, MAX_SEND_ATTEMPTS - 1, at)
    expect(last).toMatchObject({ reminders_sent: 1, send_attempts: 0, last_error: 'nope' })
  })

  it('resets the counter for the next stage after a success', () => {
    expect(reminderPatch(2, { ok: true }, 3, at).send_attempts).toBe(0)
  })

  it('closes the sequence only on the third reminder', () => {
    expect(reminderPatch(2, { ok: true }, 0, at).status).toBeUndefined()
    expect(reminderPatch(3, { ok: true }, 0, at).status).toBe('done')
    // …and not while it is still retrying stage 3.
    expect(reminderPatch(3, { ok: false, error: 'x' }, 0, at).status).toBeUndefined()
  })

  it('keeps a minted discount code even when the send failed', () => {
    // The code was already created in Shopify — losing the reference would
    // leak a single-use discount nothing can reconcile.
    expect(reminderPatch(1, { ok: false, error: 'x', discountCode: 'SAVE10' }, 0, at).discount_code).toBe('SAVE10')
  })
})

describe('segment evaluation', () => {
  const snap = (contact: any, tagIds: string[] = []) => ({
    contact,
    tagIds: new Set(tagIds),
    tagNames: new Set<string>(),
    productTitles: new Set<string>(),
    lastInboundAt: null,
  })

  it('matches a numeric condition', () => {
    const s = snap({ lifetime_spent: 300, orders_count: 4 })
    expect(
      matchesDefinition(s as any, {
        op: 'and',
        groups: [{ op: 'and', conditions: [{ field: 'total_spent', operator: 'gte', value: '250' }] }],
      })
    ).toBe(true)
  })

  it('applies AND across conditions in a group', () => {
    const s = snap({ lifetime_spent: 300, orders_count: 1 })
    expect(
      matchesDefinition(s as any, {
        op: 'and',
        groups: [
          {
            op: 'and',
            conditions: [
              { field: 'total_spent', operator: 'gte', value: '250' },
              { field: 'orders_count', operator: 'gte', value: '3' },
            ],
          },
        ],
      })
    ).toBe(false)
  })

  it('applies OR inside a group', () => {
    const s = snap({ lifetime_spent: 300, orders_count: 1 })
    expect(
      matchesDefinition(s as any, {
        op: 'and',
        groups: [
          {
            op: 'or',
            conditions: [
              { field: 'total_spent', operator: 'gte', value: '250' },
              { field: 'orders_count', operator: 'gte', value: '3' },
            ],
          },
        ],
      })
    ).toBe(true)
  })

  it('handles tag membership both ways', () => {
    const s = snap({}, ['tag-1'])
    const has = { op: 'and' as const, groups: [{ op: 'and' as const, conditions: [{ field: 'has_tag', operator: 'eq' as const, value: 'tag-1' }] }] }
    const hasNot = { op: 'and' as const, groups: [{ op: 'and' as const, conditions: [{ field: 'not_has_tag', operator: 'eq' as const, value: 'tag-1' }] }] }
    expect(matchesDefinition(s as any, has)).toBe(true)
    expect(matchesDefinition(s as any, hasNot)).toBe(false)
  })

  it('matches everyone when there are no groups', () => {
    expect(matchesDefinition(snap({}) as any, { op: 'and', groups: [] })).toBe(true)
  })

  it('labels RFM tiers', () => {
    expect(rfmLabel(5, 5, 5)).toBe('champion')
    expect(rfmLabel(5, 1, 1)).toBe('new')
    expect(rfmLabel(1, 4, 4)).toBe('at_risk')
    expect(rfmLabel(1, 1, 1)).toBe('hibernating')
  })
})

/* ------------------------------------------------------------------ */
/* Chatbot FAQ matching                                                */
/* ------------------------------------------------------------------ */

describe('FAQ matching', () => {
  const faqs = [
    { id: '1', question: '¿Cuánto tarda el envío?', answer: '24-48h', keywords: ['entrega', 'plazo'] },
    { id: '2', question: '¿Cómo hago una devolución?', answer: '30 días', keywords: ['devolver'] },
  ]

  it('finds the right entry', () => {
    const hit = bestFaq(faqs, '¿cuanto tarda el envio a Madrid?')
    expect(hit?.faq.id).toBe('1')
  })

  it('matches through the extra keywords', () => {
    expect(bestFaq(faqs, 'quiero devolver un pedido')?.faq.id).toBe('2')
  })

  it('stays silent rather than guessing', () => {
    expect(bestFaq(faqs, 'hola')).toBeNull()
    expect(bestFaq(faqs, '¿tenéis tienda física en Bilbao?')).toBeNull()
  })

  it('handles an empty knowledge base', () => {
    expect(bestFaq([], 'envio')).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Template validation                                                 */
/* ------------------------------------------------------------------ */

describe('template validation', () => {
  const base = {
    name: 'winback_45d_es',
    body_text: 'Hola {{1}}, te echamos de menos.',
    sample_values: { body: ['María'] },
    buttons: [],
  }

  it('accepts a well-formed template', () => {
    expect(validateTemplate(base)).toEqual([])
  })

  it('rejects an invalid name', () => {
    expect(validateTemplate({ ...base, name: 'Winback 45d' })[0]).toMatch(/lowercase/)
  })

  it('requires a sample for every variable', () => {
    const issues = validateTemplate({ ...base, sample_values: { body: [] } })
    expect(issues.some((i) => i.includes('sample value'))).toBe(true)
  })

  it('rejects a body that starts or ends with a variable', () => {
    expect(validateTemplate({ ...base, body_text: '{{1}} hola', sample_values: { body: ['x'] } })).toContain(
      'Body cannot start with a variable'
    )
    expect(validateTemplate({ ...base, body_text: 'hola {{1}}', sample_values: { body: ['x'] } })).toContain(
      'Body cannot end with a variable'
    )
  })

  it('enforces Meta button limits', () => {
    const buttons = Array.from({ length: 4 }, (_, i) => ({ kind: 'quick_reply', text: `b${i}` }))
    expect(validateTemplate({ ...base, buttons }).some((i) => i.includes('3 quick-reply'))).toBe(true)
  })

  it('requires {{1}} in a dynamic URL button', () => {
    const buttons = [{ kind: 'url', text: 'Ver carrito', url: 'https://store.com/cart', dynamic: true }]
    expect(validateTemplate({ ...base, buttons }).some((i) => i.includes('{{1}}'))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* Flow validation                                                     */
/* ------------------------------------------------------------------ */

describe('flow validation', () => {
  it('accepts a wired-up flow', () => {
    const nodes = [
      { node_key: 'a', node_type: 'buttons', config: { body: '¿Qué tal?', buttons: [{ id: 'y', title: 'Bien', next: 'b' }] } },
      { node_key: 'b', node_type: 'message', config: { body: '¡Genial!' } },
    ]
    expect(validateNodes(nodes)).toEqual([])
  })

  it('flags a button pointing at a missing step', () => {
    const nodes = [
      { node_key: 'a', node_type: 'buttons', config: { body: 'Hola', buttons: [{ id: 'y', title: 'Sí', next: 'ghost' }] } },
    ]
    expect(validateNodes(nodes)[0].message).toMatch(/missing step/)
  })

  it('flags empty content', () => {
    expect(validateNodes([{ node_key: 'a', node_type: 'message', config: {} }])[0].message).toMatch(/no text/)
    expect(validateNodes([{ node_key: 'a', node_type: 'delay', config: {} }])[0].message).toMatch(/no duration/)
  })
})

/* ------------------------------------------------------------------ */
/* Shopify domain normalisation                                        */
/* ------------------------------------------------------------------ */

describe('shop domain', () => {
  it('normalises what a merchant might type', () => {
    expect(normalizeShopDomain('my-store')).toBe('my-store.myshopify.com')
    expect(normalizeShopDomain('MY-STORE.myshopify.com')).toBe('my-store.myshopify.com')
    expect(normalizeShopDomain('https://my-store.myshopify.com/admin')).toBe('my-store.myshopify.com')
  })

  it('rejects anything that is not a myshopify host', () => {
    expect(normalizeShopDomain('evil.com')).toBeNull()
    expect(normalizeShopDomain('')).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Config health check                                                 */
/* ------------------------------------------------------------------ */

describe('health check', () => {
  async function health(env: Record<string, string | undefined>) {
    // The route now probes the database for migration columns; unit tests
    // answer that probe with an empty PostgREST result (columns exist).
    // A fresh Response per call — a shared one is consumed by the first probe.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      )
    const saved = { ...process.env }
    // Clear every key the route inspects, then apply the case under test.
    for (const k of [
      'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
      'ENCRYPTION_KEY', 'NEXT_PUBLIC_SITE_URL', 'META_APP_SECRET', 'CRON_SECRET',
      'AUTOMATION_CRON_SECRET', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',
    ]) delete process.env[k]
    Object.assign(process.env, env)

    const { GET } = await import('@/app/api/health/route')
    const body = await (await GET()).json()

    process.env = saved
    fetchSpy.mockRestore()
    return body
  }

  const FULL = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x',
    SUPABASE_SERVICE_ROLE_KEY: 'x',
    ENCRYPTION_KEY: 'a'.repeat(64),
    NEXT_PUBLIC_SITE_URL: 'https://app.vercel.app',
    META_APP_SECRET: 'x',
    CRON_SECRET: 'x',
    SHOPIFY_CLIENT_ID: 'x',
    SHOPIFY_CLIENT_SECRET: 'x',
  }

  it('passes when everything is set', async () => {
    const r = await health(FULL)
    expect(r.ok).toBe(true)
    expect(r.missing.required).toEqual([])
  })

  it('names each missing required variable and what it breaks', async () => {
    const r = await health({ ...FULL, META_APP_SECRET: undefined, CRON_SECRET: undefined })
    expect(r.ok).toBe(false)
    const keys = r.missing.required.map((m: any) => m.key)
    expect(keys).toContain('META_APP_SECRET')
    expect(keys).toContain('CRON_SECRET or AUTOMATION_CRON_SECRET')
    expect(r.missing.required.every((m: any) => m.breaks.length > 10)).toBe(true)
  })

  it('rejects an ENCRYPTION_KEY that is not 64 hex characters', async () => {
    const short = await health({ ...FULL, ENCRYPTION_KEY: 'too-short-not-hex' })
    expect(short.configured.ENCRYPTION_KEY).toBe(false)
    const breaks = short.missing.required.find((m: any) => m.key === 'ENCRYPTION_KEY').breaks
    expect(breaks).toMatch(/invalid/i)
    expect(breaks).toMatch(/64 hex/)

    const wrongLength = await health({ ...FULL, ENCRYPTION_KEY: 'ab'.repeat(16) }) // 32 chars
    expect(wrongLength.configured.ENCRYPTION_KEY).toBe(false)
  })

  it('accepts AUTOMATION_CRON_SECRET as an alternative, and says which header to use', async () => {
    const r = await health({ ...FULL, CRON_SECRET: undefined, AUTOMATION_CRON_SECRET: 'x' })
    expect(r.ok).toBe(true)
    expect(r.configured['CRON_SECRET or AUTOMATION_CRON_SECRET']).toBe(true)
    // The whole point: it must tell you x-cron-secret, not Bearer.
    expect(r.cron.usingVariable).toBe('AUTOMATION_CRON_SECRET')
    expect(r.cron.headerName).toBe('x-cron-secret')
    expect(r.cron.authHeader).not.toContain('Bearer')
  })

  it('says Bearer when CRON_SECRET is the one that is set', async () => {
    const r = await health({ ...FULL, AUTOMATION_CRON_SECRET: undefined })
    expect(r.cron.usingVariable).toBe('CRON_SECRET')
    expect(r.cron.headerName).toBe('Authorization')
    expect(r.cron.authHeader).toContain('Bearer')
  })

  it('treats Shopify as optional, so the app is usable without it', async () => {
    const r = await health({ ...FULL, SHOPIFY_CLIENT_ID: undefined, SHOPIFY_CLIENT_SECRET: undefined })
    expect(r.ok).toBe(true)
    expect(r.missing.optional.map((m: any) => m.key)).toContain('SHOPIFY_CLIENT_ID')
  })

  it('echoes the webhook and cron URLs so they can be copied into Meta and cron-job.org', async () => {
    const r = await health(FULL)
    expect(r.webhooks.whatsapp).toBe('https://app.vercel.app/api/whatsapp/webhook')
    expect(r.cron.tick).toBe('https://app.vercel.app/api/cron/tick')
  })

  it('never returns a secret value', async () => {
    const raw = JSON.stringify(await health({ ...FULL, META_APP_SECRET: 'super-secret-value' }))
    expect(raw).not.toContain('super-secret-value')
  })

  it('fails NEXT_PUBLIC_SITE_URL when it is still the example placeholder', async () => {
    // The real incident: the placeholder was carried over from .env.example,
    // so /api/health said "all set" while Shopify rejected every redirect.
    const r = await health({ ...FULL, NEXT_PUBLIC_SITE_URL: 'https://your-app.vercel.app' })
    expect(r.ok).toBe(false)
    expect(r.configured.NEXT_PUBLIC_SITE_URL).toBe(false)
    const entry = r.missing.required.find((m: any) => m.key === 'NEXT_PUBLIC_SITE_URL')
    expect(entry.breaks).toMatch(/redirect_uri is not whitelisted/)
    // Still prints the URL it would have used — that is what makes it obvious.
    expect(r.shopify.redirectUrl).toBe('https://your-app.vercel.app/api/shopify/callback')
    expect(r.shopify.siteUrlValid).toBe(false)
  })

  it('prints the exact Redirect URL to paste into the Partner Dashboard', async () => {
    const r = await health(FULL)
    expect(r.shopify.redirectUrl).toBe('https://app.vercel.app/api/shopify/callback')
    expect(r.shopify.siteUrlValid).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* NEXT_PUBLIC_SITE_URL — a placeholder here surfaces as a Shopify     */
/* error that names no variable, so it is caught before we send it.    */
/* ------------------------------------------------------------------ */

describe('site URL', () => {
  it('accepts a real https origin and strips a trailing slash', () => {
    expect(siteUrlStatus('https://wasify-updated.vercel.app').ok).toBe(true)
    expect(siteUrl('https://wasify-updated.vercel.app/')).toBe('https://wasify-updated.vercel.app')
    expect(siteUrl('  https://crm.example-store.com  ')).toBe('https://crm.example-store.com')
  })

  it('rejects every placeholder that ships in .env.example or a doc', () => {
    for (const host of PLACEHOLDER_SITE_HOSTS) {
      const s = siteUrlStatus(`https://${host}`)
      expect(s.ok, host).toBe(false)
      expect(s.ok ? '' : s.problem).toBe('placeholder')
    }
    // .env.example must ship a value this check actually rejects — otherwise
    // the guard passes tests and still lets the real mistake through.
    const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8')
    const shipped = example.match(/^NEXT_PUBLIC_SITE_URL=(.*)$/m)?.[1]?.trim()
    expect(shipped, 'NEXT_PUBLIC_SITE_URL missing from .env.example').toBeTruthy()
    expect(siteUrlStatus(shipped).ok).toBe(false)
  })

  it('rejects missing, malformed and http origins', () => {
    expect(siteUrlStatus('').problem).toBe('missing')
    expect(siteUrlStatus(undefined).problem).toBe('missing')
    expect(siteUrlStatus('wasify-updated.vercel.app').problem).toBe('malformed') // no scheme
    expect(siteUrlStatus('http://wasify-updated.vercel.app').problem).toBe('malformed') // not https
  })

  it('still allows local development', () => {
    expect(siteUrlStatus('http://localhost:3000').ok).toBe(true)
  })

  it('explains what to do, including the redeploy that NEXT_PUBLIC_ needs', () => {
    const s = siteUrlStatus('https://your-app.vercel.app')
    const message = s.ok ? '' : s.message
    expect(message).toContain('NEXT_PUBLIC_SITE_URL')
    // Saving the variable in Vercel does nothing on its own: NEXT_PUBLIC_* is
    // inlined at build time. Anyone who skips this reports "I already set it".
    expect(message).toMatch(/redeploy/i)
    expect(message).toMatch(/build time/i)
  })
})

/* ------------------------------------------------------------------ */
/* Shopify OAuth callback                                              */
/*                                                                     */
/* This runs on Shopify's return trip, so an uncaught throw is a bare  */
/* "HTTP ERROR 500" in the merchant's browser naming no cause. Every   */
/* failure has to come back as a readable reason instead.              */
/* ------------------------------------------------------------------ */

describe('shopify callback', () => {
  // The parameters of a real return trip, signed for whichever secret the
  // case under test uses — otherwise the HMAC gate rejects before the step
  // being tested is ever reached.
  const PARAMS = {
    code: 'e6a759de39ccf16c12c7f0b0b950c868',
    host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZG9uY2FiZWxsb3Bybw',
    shop: 'doncabellopro.myshopify.com',
    state: 'c4de20e00e1c62ad9e7182427d13543d',
    timestamp: '1785275422',
  }

  function signedCallback(secret: string): string {
    const url = new URL('https://wasify-updated.vercel.app/api/shopify/callback')
    for (const [k, v] of Object.entries(PARAMS)) url.searchParams.set(k, v)
    const message = Object.entries(PARAMS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    url.searchParams.set('hmac', createHmac('sha256', secret).update(message).digest('hex'))
    return url.toString()
  }

  /** Run the route with a chosen cookie jar and environment. */
  async function callback(env: Record<string, string | undefined>, jar: Record<string, string> = {}) {
    vi.resetModules()
    vi.doMock('next/headers', () => ({
      cookies: async () => ({
        get: (name: string) => (jar[name] === undefined ? undefined : { name, value: jar[name] }),
        set: () => {},
        delete: () => {},
      }),
    }))

    const saved = { ...process.env }
    for (const k of [
      'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ENCRYPTION_KEY',
      'NEXT_PUBLIC_SITE_URL', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',
    ]) delete process.env[k]
    Object.assign(process.env, env)

    try {
      const { GET } = await import('@/app/api/shopify/callback/route')
      const res = await GET(new Request(signedCallback(env.SHOPIFY_CLIENT_SECRET ?? '')))
      const location = res.headers.get('location') ?? ''
      return { status: res.status, location, reason: new URL(location).searchParams.get('shopify_error') }
    } finally {
      process.env = saved
      vi.doUnmock('next/headers')
      vi.resetModules()
    }
  }

  const BASE = {
    NEXT_PUBLIC_SITE_URL: 'https://wasify-updated.vercel.app',
    SHOPIFY_CLIENT_ID: 'id',
    SHOPIFY_CLIENT_SECRET: 'secret',
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    ENCRYPTION_KEY: 'a'.repeat(64),
  }

  // The state cookie is what a real round trip carries back.
  const JAR = {
    shopify_oauth_state: 'c4de20e00e1c62ad9e7182427d13543d',
    shopify_oauth_user: '00000000-0000-0000-0000-000000000001',
  }

  it('redirects to Integrations with a reason instead of throwing a 500', async () => {
    // No state cookie — the browser dropped it or the attempt is forged.
    const r = await callback(BASE, {})
    expect(r.status).toBe(307)
    expect(r.location).toContain('/integrations?shopify_error=')
    expect(r.reason).toMatch(/state/i)
  })

  it('names ENCRYPTION_KEY rather than dying inside encrypt()', async () => {
    // Previously this threw on the happy path — after the handshake had
    // already succeeded — and surfaced as a bare HTTP ERROR 500.
    const r = await callback({ ...BASE, ENCRYPTION_KEY: undefined }, JAR)
    expect(r.status).toBe(307)
    expect(r.reason).toContain('ENCRYPTION_KEY')
    expect(r.reason).toMatch(/openssl rand -hex 32/)
  })

  it('names SUPABASE_SERVICE_ROLE_KEY rather than dying inside createServiceClient()', async () => {
    const r = await callback({ ...BASE, SUPABASE_SERVICE_ROLE_KEY: undefined }, JAR)
    expect(r.reason).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('rejects a key of the wrong length, not just a missing one', async () => {
    const r = await callback({ ...BASE, ENCRYPTION_KEY: 'abc123' }, JAR)
    expect(r.reason).toMatch(/64 hex/)
  })

  it('checks it can store the token BEFORE spending the single-use code', async () => {
    // If the config check ran after the exchange, the code would be burned and
    // the merchant would have to restart OAuth even once the variable is fixed.
    // A fetch here would mean the exchange was attempted.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await callback({ ...BASE, ENCRYPTION_KEY: undefined }, JAR)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('never leaks the client secret into the redirect', async () => {
    // Config is valid here, so the route reaches the token exchange — stub it
    // rather than letting a unit test call a real storefront.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 400 }))
    const r = await callback({ ...BASE, SHOPIFY_CLIENT_SECRET: 'shpss_do_not_leak' }, JAR)
    expect(fetchSpy).toHaveBeenCalled()
    expect(r.reason).toMatch(/Token exchange failed \(400\)/)
    expect(r.location).not.toContain('shpss_do_not_leak')
    fetchSpy.mockRestore()
  })
})

/* ------------------------------------------------------------------ */
/* Cron auth — CRON_SECRET and AUTOMATION_CRON_SECRET use DIFFERENT    */
/* headers, and mixing them is the usual cause of a silent 401.        */
/* ------------------------------------------------------------------ */

describe('cron auth', () => {
  const req = (headers: Record<string, string>) => new Request('https://x/api/cron/tick', { headers })

  function withEnv(env: Record<string, string | undefined>, run: () => void) {
    const saved = { ...process.env }
    delete process.env.CRON_SECRET
    delete process.env.AUTOMATION_CRON_SECRET
    Object.assign(process.env, env)
    try {
      run()
    } finally {
      process.env = saved
    }
  }

  it('accepts Bearer when CRON_SECRET is set', () => {
    withEnv({ CRON_SECRET: 's3cret' }, () => {
      expect(isAuthorizedCron(req({ authorization: 'Bearer s3cret' }))).toBe(true)
      expect(isAuthorizedCron(req({ authorization: 'Bearer wrong' }))).toBe(false)
      expect(isAuthorizedCron(req({ authorization: 's3cret' }))).toBe(false) // missing "Bearer "
    })
  })

  it('accepts x-cron-secret when AUTOMATION_CRON_SECRET is set', () => {
    withEnv({ AUTOMATION_CRON_SECRET: 's3cret' }, () => {
      expect(isAuthorizedCron(req({ 'x-cron-secret': 's3cret' }))).toBe(true)
      expect(isAuthorizedCron(req({ 'x-cron-secret': 'wrong' }))).toBe(false)
    })
  })

  it('does NOT accept Bearer when only AUTOMATION_CRON_SECRET is set', () => {
    // This is the exact trap: the value is right but the header is wrong.
    withEnv({ AUTOMATION_CRON_SECRET: 's3cret' }, () => {
      expect(isAuthorizedCron(req({ authorization: 'Bearer s3cret' }))).toBe(false)
    })
  })

  it('does NOT accept x-cron-secret when only CRON_SECRET is set', () => {
    withEnv({ CRON_SECRET: 's3cret' }, () => {
      expect(isAuthorizedCron(req({ 'x-cron-secret': 's3cret' }))).toBe(false)
    })
  })

  it('accepts either header when both variables are set', () => {
    withEnv({ CRON_SECRET: 'a', AUTOMATION_CRON_SECRET: 'b' }, () => {
      expect(isAuthorizedCron(req({ authorization: 'Bearer a' }))).toBe(true)
      expect(isAuthorizedCron(req({ 'x-cron-secret': 'b' }))).toBe(true)
    })
  })

  it('refuses everything when neither is configured', () => {
    withEnv({}, () => {
      expect(isAuthorizedCron(req({ authorization: 'Bearer anything' }))).toBe(false)
      expect(isAuthorizedCron(req({ 'x-cron-secret': 'anything' }))).toBe(false)
      expect(isAuthorizedCron(req({}))).toBe(false)
    })
  })

  it('reports the header that matches the configured variable', () => {
    withEnv({ CRON_SECRET: 'x' }, () => {
      expect(cronAuthHint().header).toBe('Authorization')
      expect(cronAuthHint().example).toContain('Bearer')
    })
    withEnv({ AUTOMATION_CRON_SECRET: 'x' }, () => {
      expect(cronAuthHint().header).toBe('x-cron-secret')
      expect(cronAuthHint().example).toContain('x-cron-secret')
    })
    withEnv({}, () => {
      expect(cronAuthHint().configured).toBe(false)
    })
  })

  it('explains the fix in the 401 body without leaking the secret', () => {
    withEnv({ AUTOMATION_CRON_SECRET: 'super-secret-value' }, () => {
      const body = cronUnauthorizedBody()
      expect(body.expectedHeader).toContain('x-cron-secret')
      expect(JSON.stringify(body)).not.toContain('super-secret-value')
    })
  })
})

/* ------------------------------------------------------------------ */
/* vercel.json                                                          */
/* ------------------------------------------------------------------ */

describe('vercel.json', () => {
  // Vercel validates this file against a strict schema and rejects ANY key it
  // does not recognise. A comment-style key ("_comment_crons") once slipped in
  // and every deployment failed schema validation before it could build, which
  // looked like an environment-variable problem for hours. If the file exists
  // at all, it must contain only real options.
  const ALLOWED = new Set([
    '$schema', 'buildCommand', 'devCommand', 'installCommand', 'ignoreCommand',
    'outputDirectory', 'framework', 'regions', 'functions', 'routes', 'rewrites',
    'redirects', 'headers', 'cleanUrls', 'trailingSlash', 'crons', 'images',
    'public', 'git', 'github',
  ])

  it('either does not exist, or contains only keys Vercel accepts', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const file = path.resolve(process.cwd(), 'vercel.json')

    if (!fs.existsSync(file)) return // valid on Hobby, where the crons cannot run

    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    const unknown = Object.keys(config).filter((k) => !ALLOWED.has(k))

    expect(
      unknown,
      `vercel.json has key(s) Vercel will reject: ${unknown.join(', ')}. ` +
        'JSON has no comments — put explanations in README.md instead.'
    ).toEqual([])
  })

  it('every cron path points at a route that exists and is cron-guarded', async () => {
    // A typo'd path in vercel.json fails silently: the Crons tab shows 404s
    // and nothing runs. And a cron route without the secret guard would be
    // openly callable by anyone who reads this public repo.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const file = path.resolve(process.cwd(), 'vercel.json')
    if (!fs.existsSync(file)) return

    for (const cron of JSON.parse(fs.readFileSync(file, 'utf8')).crons ?? []) {
      const route = path.resolve(process.cwd(), `src/app${cron.path}/route.ts`)
      expect(fs.existsSync(route), `${cron.path} has no route file`).toBe(true)
      expect(fs.readFileSync(route, 'utf8'), `${cron.path} is not cron-guarded`).toContain('isAuthorizedCron')
    }
  })
})

/* ------------------------------------------------------------------ */
/* Responsive layer                                                     */
/* ------------------------------------------------------------------ */

describe('responsive CSS', () => {
  // Components opt into responsive behaviour with data-r="…" attributes that
  // are INERT unless globals.css has a matching rule. They were used in eight
  // places with no CSS at all, so on a phone the sidebar never hid and the
  // menu button never appeared. This test ties the two files together.
  async function read(file: string) {
    const fs = await import('node:fs')
    const path = await import('node:path')
    return fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')
  }

  async function walk(dir: string): Promise<string[]> {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const out: string[] = []
    for (const entry of fs.readdirSync(path.resolve(process.cwd(), dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) out.push(...(await walk(rel)))
      else if (entry.name.endsWith('.tsx')) out.push(rel)
    }
    return out
  }

  it('defines a rule for every data-r value the components use', async () => {
    const css = await read('src/app/globals.css')

    const used = new Set<string>()
    for (const file of await walk('src')) {
      const source = await read(file)
      for (const m of source.matchAll(/data-r="([a-z0-9]+)"/g)) used.add(m[1])
    }

    expect(used.size, 'no data-r attributes found — did the markup change?').toBeGreaterThan(0)

    const undefinedInCss = [...used].filter((name) => !css.includes(`[data-r='${name}']`))

    expect(
      undefinedInCss,
      `data-r value(s) used in markup but with no rule in globals.css: ${undefinedInCss.join(', ')}. ` +
        'Without a rule the attribute does nothing and the layout will not collapse on mobile.'
    ).toEqual([])
  })

  it('hides the desktop sidebar and reveals the mobile menu on phones', async () => {
    const css = await read('src/app/globals.css')
    const phoneBlock = css.slice(css.indexOf('@media (max-width: 900px)'))

    expect(phoneBlock).toContain("[data-r='rail']")
    expect(phoneBlock).toMatch(/\[data-r='rail'\][\s\S]{0,60}display:\s*none/)
    expect(phoneBlock).toMatch(/\[data-r='mobileonly'\][\s\S]{0,60}display:\s*flex/)
  })
})

/* ------------------------------------------------------------------ */
/* Shopify scopes vs webhook topics                                     */
/* ------------------------------------------------------------------ */

describe('Shopify scopes', () => {
  // Shopify refuses to register a webhook whose scope was not granted, and it
  // does so quietly at connect time — the feature then just never fires. This
  // pins each topic to the scope Shopify actually gates it on. Note that the
  // checkouts/* topics are gated on read_orders, NOT read_checkouts, which is
  // easy to get wrong from the name alone.
  const TOPIC_SCOPE: Record<string, string | null> = {
    'orders/create': 'read_orders',
    'orders/updated': 'read_orders',
    'orders/cancelled': 'read_orders',
    'checkouts/create': 'read_orders',
    'checkouts/update': 'read_orders',
    'fulfillments/create': 'read_fulfillments',
    'fulfillments/update': 'read_fulfillments',
    'app/uninstalled': null, // no scope required
  }

  it('requests a scope for every webhook topic it registers', async () => {
    const { SHOPIFY_SCOPES } = await import('@/lib/shopify/admin')
    const { WEBHOOK_TOPICS } = await import('@/lib/shopify/webhooks')

    const granted = new Set<string>(SHOPIFY_SCOPES)
    const missing: string[] = []

    for (const topic of WEBHOOK_TOPICS) {
      const needed = TOPIC_SCOPE[topic]
      if (needed === undefined) {
        missing.push(`${topic} (no scope mapping — add one to this test)`)
      } else if (needed && !granted.has(needed)) {
        missing.push(`${topic} needs ${needed}`)
      }
    }

    expect(missing, `Webhook topics without their scope: ${missing.join('; ')}`).toEqual([])
  })

  it('does not request scopes nothing uses', async () => {
    const { SHOPIFY_SCOPES } = await import('@/lib/shopify/admin')
    // Merchants see this list at install time, so an unexplained scope costs
    // trust. These two are for sales channels and checkout functions.
    expect(SHOPIFY_SCOPES).not.toContain('read_product_listings')
    expect(SHOPIFY_SCOPES).not.toContain('read_validations')
  })

  it('keeps write_discounts, without which cart recovery silently drops codes', async () => {
    const { SHOPIFY_SCOPES } = await import('@/lib/shopify/admin')
    expect(SHOPIFY_SCOPES).toContain('write_discounts')
    expect(SHOPIFY_SCOPES).toContain('write_orders') // COD tagging
  })
})

/* ------------------------------------------------------------------ */
/* CSV import — per-row tags                                           */
/* ------------------------------------------------------------------ */

describe('CSV tag column', () => {
  it('applies the tag on each row', () => {
    expect(rowTagNames({ phone: '34600', Etiqueta: 'VIP' }, ['Etiqueta'])).toEqual(['VIP'])
  })

  it('splits several tags in one cell', () => {
    // "VIP, Madrid" in a spreadsheet means two tags, not one tag named
    // "VIP, Madrid" — which is what a naive trim would have created.
    expect(rowTagNames({ t: 'VIP, Madrid' }, ['t'])).toEqual(['VIP', 'Madrid'])
    expect(rowTagNames({ t: 'VIP;Madrid|Wholesale' }, ['t'])).toEqual(['VIP', 'Madrid', 'Wholesale'])
  })

  it('reads every column mapped to tag, not only the first', () => {
    expect(rowTagNames({ a: 'VIP', b: 'Madrid' }, ['a', 'b'])).toEqual(['VIP', 'Madrid'])
  })

  it('collapses duplicates case-insensitively and ignores blanks', () => {
    expect(rowTagNames({ a: 'VIP', b: 'vip' }, ['a', 'b'])).toEqual(['VIP'])
    expect(rowTagNames({ a: ' , ;; ', b: '' }, ['a', 'b'])).toEqual([])
    expect(rowTagNames({}, [])).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* Template parameters — Meta #132012                                  */
/* ------------------------------------------------------------------ */

describe('template parameters', () => {
  const body = (text: string) => [{ type: 'BODY', text }]

  it('counts by the highest {{n}}, not by how many times one appears', () => {
    expect(countVariables('Hi {{1}}, your order {{2}} ships today')).toBe(2)
    expect(countVariables('Hi {{1}}, bye {{1}}')).toBe(1)
    expect(countVariables('{{ 3 }} spaced')).toBe(3) // Meta tolerates the spaces
    expect(countVariables('no variables here')).toBe(0)
    expect(countVariables(null)).toBe(0)
  })

  it('reads header, body and dynamic buttons out of Meta components', () => {
    const shape = templateShape([
      { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' },
      { type: 'BODY', text: 'Hi {{1}}, total {{2}}' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'URL', text: 'Pay', url: 'https://x.com/{{1}}' }] },
    ])
    expect(shape).toEqual({ headerFormat: 'TEXT', headerVars: 1, bodyVars: 2, dynamicUrlButtons: [1] })
  })

  it('accepts a template whose parameters line up', () => {
    const shape = templateShape(body('Hi {{1}}'))
    expect(paramMismatch(shape, ['Ana'])).toBeNull()
    expect(paramMismatch(templateShape(body('No variables')), [])).toBeNull()
  })

  it('rejects a blank value — the reported failure', () => {
    // The broadcast wizard let you click past the Personalize step without
    // filling anything, so every recipient came back #132012.
    const shape = templateShape(body('Hi {{1}}, your code is {{2}}'))
    expect(paramMismatch(shape, ['Ana', '  '])).toMatch(/\{\{2\}\} is empty/)
  })

  it('rejects the wrong number of values', () => {
    expect(paramMismatch(templateShape(body('Hi {{1}}')), [])).toMatch(/expects 1 variable.*0 (was|were)/)
    expect(paramMismatch(templateShape(body('Hi')), ['x'])).toMatch(/expects 0 variables/)
  })

  it('refuses a header or button the sender cannot fill', () => {
    // Only body parameters are sent, so a template needing more than that can
    // never succeed — say so instead of letting Meta reject each recipient.
    const headerVar = templateShape([{ type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' }, ...body('x')])
    expect(paramMismatch(headerVar, [])).toMatch(/header/i)

    const image = templateShape([{ type: 'HEADER', format: 'IMAGE' }, ...body('x')])
    expect(paramMismatch(image, [])).toMatch(/image header/i)

    const dynamic = templateShape([...body('x'), { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.com/{{1}}' }] }])
    expect(paramMismatch(dynamic, [])).toMatch(/dynamic URL/i)
  })

  it('decides the cart-link button from the template, not from having a link', () => {
    // The recovery reminder always pushed a URL parameter when it had a cart
    // link. A template whose button is STATIC accepts none, so every send was
    // rejected #132012 — and a static button drops the customer on the home
    // page with an empty cart, which defeats the reminder anyway.
    const staticButton = templateShape([
      { type: 'BODY', text: 'Hi {{1}}' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Complete my order', url: 'https://ibban.com/' }] },
    ])
    expect(staticButton.dynamicUrlButtons).toEqual([])
    expect(paramMismatch(staticButton, ['Ana'], { urlSuffixes: 1 })).toMatch(/0 button\(s\) with a dynamic URL/)
    expect(paramMismatch(staticButton, ['Ana'], { urlSuffixes: 0 })).toBeNull()

    const dynamicButton = templateShape([
      { type: 'BODY', text: 'Hi {{1}}' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Complete my order', url: 'https://ibban.com/{{1}}' }] },
    ])
    expect(dynamicButton.dynamicUrlButtons).toEqual([0])
    expect(paramMismatch(dynamicButton, ['Ana'], { urlSuffixes: 1 })).toBeNull()
  })

  it('translates the Meta codes that otherwise send people in circles', () => {
    const raw = '(#132012) Parameter format does not match format in the created template'
    expect(explainMetaError(raw, 132012)).toContain('missing or blank value')
    expect(explainMetaError(raw, '132012')).toContain('missing or blank value') // code arrives as either
    expect(explainMetaError('boom', 999999)).toBe('boom') // unknown codes pass through untouched
    expect(explainMetaError(explainMetaError(raw, 132012), 132012)).toBe(explainMetaError(raw, 132012)) // idempotent
  })
})

/* ------------------------------------------------------------------ */
/* Webhook registration                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* GraphQL backfill                                                    */
/*                                                                     */
/* REST is closed to apps created after 1 April 2025, and the failure  */
/* was silent and partial: orders arrived (webhook) while products and */
/* abandoned carts stayed empty forever.                               */
/* ------------------------------------------------------------------ */

describe('shopify graphql backfill', () => {
  it('uses GraphQL, never the legacy REST endpoints', async () => {
    const sync = readFileSync(join(process.cwd(), 'src/lib/shopify/sync.ts'), 'utf8')
    for (const endpoint of ['products.json', 'checkouts.json', 'orders.json', 'webhooks.json']) {
      expect(sync, `${endpoint} is a REST endpoint this app may not call`).not.toContain(endpoint)
    }
    expect(sync).toContain('abandonedCheckouts')
  })

  it('strips the gid wrapper to the numeric id every table stores', () => {
    expect(numericId('gid://shopify/Order/1234567890')).toBe('1234567890')
    expect(numericId('gid://shopify/AbandonedCheckout/99?key=x')).toBe('99')
    expect(numericId('4455')).toBe('4455')
    expect(numericId(null)).toBe('')
  })

  it('reshapes an order into what the webhook mapper expects', () => {
    // Reusing the webhook mapper is deliberate — it owns the phone chain and
    // the source discipline, and a second mapper is how the paths drift.
    const payload = orderNodeToPayload({
      id: 'gid://shopify/Order/555',
      name: '#1982',
      createdAt: '2026-07-01T10:00:00Z',
      displayFinancialStatus: 'PENDING',
      paymentGatewayNames: ['Cash on Delivery (COD)'],
      tags: ['COD Pending', 'vip'],
      currentTotalPriceSet: { shopMoney: { amount: '86.90', currencyCode: 'EUR' } },
      customer: { id: 'gid://shopify/Customer/77', firstName: 'María', lastName: 'García', phone: '+34600123456' },
      shippingAddress: { name: 'María García', phone: '+34600123456', city: 'Valencia' },
      lineItems: { nodes: [{ title: 'Blusa', quantity: 2, sku: 'B-1', originalUnitPriceSet: { shopMoney: { amount: '43.45' } } }] },
    })

    expect(payload.id).toBe('555')
    expect(payload.financial_status).toBe('pending')
    expect(payload.tags).toBe('COD Pending, vip') // the mapper expects a string
    expect(payload.total_price).toBe('86.90')
    expect(payload.customer.id).toBe('77')
    expect(payload.line_items[0]).toMatchObject({ title: 'Blusa', quantity: 2, price: '43.45' })

    // The COD engine must still recognise it through the shared helpers.
    expect(isCodOrder(payload, ['cash on delivery', 'cod'])).toBe(true)
    expect(extractShopifyPhone(payload)).toBe('34600123456')
  })

  it('stays inside the serverless time budget and reports partial progress', () => {
    // Vercel Hobby kills a function at 60s. A long history must stop early,
    // say so, and make progress across runs — not die mid-request with
    // "Last sync: never" and a success spinner.
    const sync = readFileSync(join(process.cwd(), 'src/lib/shopify/sync.ts'), 'utf8')
    expect(sync).toContain('deadline')
    expect(sync).toMatch(/partial/)
    // Both UIs must tell the merchant to press Sync again rather than
    // presenting a partial import as the whole story.
    for (const file of ['src/app/(app)/integrations/page.tsx', 'src/app/(app)/catalog/page.tsx']) {
      expect(readFileSync(join(process.cwd(), file), 'utf8')).toContain('press Sync again')
    }
  })

  it('exposes a cron-safe sync route, guarded by the cron secret', () => {
    // The manual Sync button authenticates with a browser session, which a
    // scheduler does not have. The cron twin must gate on the cron secret —
    // an unguarded version would let anyone with the URL drain the Shopify
    // API quota on the merchant's behalf.
    const route = readFileSync(join(process.cwd(), 'src/app/api/cron/sync/route.ts'), 'utf8')
    expect(route).toContain('isAuthorizedCron')
    expect(route).toContain('cronUnauthorizedBody')
    expect(route).toContain('syncStore')
    expect(route).toContain('maxDuration = 300') // Vercel Pro cap
  })

  it('walks newest-first, so the first click lands the latest data', () => {
    // Oldest-first spent the whole budget on May while the merchant stared
    // at an empty "today". Newest-first + skip-unchanged means each run
    // races through what it already holds and spends its time on new rows.
    const sync = readFileSync(join(process.cwd(), 'src/lib/shopify/sync.ts'), 'utf8')
    expect(sync.match(/reverse: true/g)?.length).toBe(3) // orders, checkouts, products
    expect(sync).toContain('changedNodes')

    // Every checkout list must sort by when the cart was ABANDONED — insert
    // order put three-week-old backfill rows above this afternoon's carts,
    // first on the carts page, then again in the recovery test picker.
    for (const file of ['src/app/api/carts/route.ts', 'src/app/api/recovery/test/route.ts']) {
      expect(readFileSync(join(process.cwd(), file), 'utf8'), `${file} sorts by insert time`).toMatch(
        /order\('abandoned_at'/
      )
    }
  })

  it('reshapes an abandoned checkout, keeping the recovery link and locale', () => {
    const payload = checkoutNodeToPayload({
      id: 'gid://shopify/AbandonedCheckout/69328815489397',
      createdAt: '2026-07-28T16:10:00Z',
      completedAt: null,
      abandonedCheckoutUrl: 'https://ibban.com/cart/c/abc?key=xyz',
      totalPriceSet: { shopMoney: { amount: '64.95', currencyCode: 'EUR' } },
      customer: { id: 'gid://shopify/Customer/9', firstName: 'Archna', lastName: 'Parbhoe', locale: 'es', phone: '+34600123456' },
      lineItems: { nodes: [{ title: 'Vestido', quantity: 1 }] },
    })

    expect(payload.id).toBe('69328815489397')
    expect(payload.completed_at).toBeNull()
    expect(payload.abandoned_checkout_url).toBe('https://ibban.com/cart/c/abc?key=xyz')
    expect(payload.customer_locale).toBe('es') // drives which template language
    expect(extractShopifyPhone(payload)).toBe('34600123456')
    // The link the reminder button actually sends.
    expect(urlSuffix(payload.abandoned_checkout_url)).toBe('cart/c/abc?key=xyz')
  })
})

describe('shopify webhook registration', () => {
  it('converts topics between the REST and GraphQL spellings', () => {
    expect(graphqlTopic('orders/create')).toBe('ORDERS_CREATE')
    expect(graphqlTopic('app/uninstalled')).toBe('APP_UNINSTALLED')
    for (const topic of ['orders/create', 'checkouts/update', 'fulfillments/create', 'app/uninstalled']) {
      // Round-tripping must be lossless, or "already registered" never matches
      // and every reconnect re-creates every subscription.
      expect(restTopic(graphqlTopic(topic))).toBe(topic)
    }
  })

  it('never sends a GDPR compliance topic to the Admin API', async () => {
    // shopify.dev: the three compliance topics are created "via the Partner
    // Dashboard or by updating the app configuration TOML" — they are not in
    // the Admin API topic enum. Posting shop/redact to webhooks.json fails
    // with "Could not find the webhook topic shop/redact", and because the
    // loop treated that as fatal it reported every other topic unregistered.
    const { WEBHOOK_TOPICS, COMPLIANCE_TOPICS } = await import('@/lib/shopify/webhooks')
    for (const topic of COMPLIANCE_TOPICS) {
      expect(WEBHOOK_TOPICS, `${topic} cannot be registered through the Admin API`).not.toContain(topic)
    }
    expect(COMPLIANCE_TOPICS).toContain('shop/redact')
  })

  it('still handles every compliance topic it asks the dashboard to send', async () => {
    // The topics move to the Partner Dashboard, but they arrive at the same
    // endpoint — so dropping them from registration must not drop the handler.
    const { COMPLIANCE_TOPICS } = await import('@/lib/shopify/webhooks')
    const route = readFileSync(join(process.cwd(), 'src/app/api/shopify/webhook/route.ts'), 'utf8')
    for (const topic of COMPLIANCE_TOPICS) {
      if (topic === 'customers/data_request') continue // read-only request, nothing stored to return
      expect(route, `no handler for ${topic}`).toContain(`case '${topic}'`)
    }
  })

  it('deletes the rows a contact delete would orphan rather than remove', () => {
    // conversations/messages CASCADE from contacts, but shopify_orders and
    // shopify_checkouts are ON DELETE SET NULL — and they carry
    // customer_name/email/phone. Deleting only the contact would leave that
    // personal data behind under a null contact_id, which is exactly what
    // customers/redact exists to prevent.
    const schema = readFileSync(join(process.cwd(), 'supabase/schema.sql'), 'utf8')
    const route = readFileSync(join(process.cwd(), 'src/app/api/shopify/webhook/route.ts'), 'utf8')
    const redact = route.slice(route.indexOf("case 'customers/redact'"))

    for (const table of ['shopify_orders', 'shopify_checkouts']) {
      const ddl = schema.slice(schema.indexOf(`create table if not exists public.${table} (`))
      const fk = ddl.slice(0, ddl.indexOf('\n);')).match(/contact_id[^,]*references public\.contacts\(id\)([^,]*)/)
      expect(fk, `${table} has no contact_id FK`).toBeTruthy()
      if (/set null/i.test(fk![1])) {
        expect(redact, `${table} is SET NULL, so redaction must delete it explicitly`).toContain(
          `.from('${table}').delete()`
        )
      }
    }
  })

  it('reports a partial failure instead of discarding the successes', async () => {
    const { registerShopifyWebhooks } = await import('@/lib/shopify/webhooks')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init: any) => {
      const body = JSON.parse(init.body)

      // The existing-subscriptions read.
      if (body.query.includes('webhookSubscriptions(first')) {
        return new Response(JSON.stringify({ data: { webhookSubscriptions: { nodes: [] } } }), { status: 200 })
      }

      // Shopify reports a rejected topic in userErrors with HTTP 200, which is
      // exactly the shape that must not be mistaken for success.
      const failed = body.variables.topic === 'ORDERS_UPDATED'
      return new Response(
        JSON.stringify({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: failed ? null : { id: 'gid://shopify/WebhookSubscription/1' },
              userErrors: failed ? [{ message: 'nope' }] : [],
            },
          },
        }),
        { status: 200 }
      )
    })

    const { results, failed } = await registerShopifyWebhooks('x.myshopify.com', 't', 'https://app.test')

    // It must not throw, and the seven that worked must still be reported.
    expect(failed.map((f) => f.topic)).toEqual(['orders/updated'])
    expect(results.filter((r) => r.ok).length).toBe(results.length - 1)
    fetchSpy.mockRestore()
  })
})
