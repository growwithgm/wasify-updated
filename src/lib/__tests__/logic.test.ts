import { describe, expect, it } from 'vitest'
import { sanitizePhone, isValidPhone, phonesMatch, phoneVariants, extractShopifyPhone, initialsOf } from '@/lib/phone'
import { sessionWindow, canSendFreeText, WINDOW_MS } from '@/lib/window'
import { normalize, matchesKeyword } from '@/lib/engines/types'
import { isCodOrder, buildOrderVars } from '@/lib/engines/cod'
import { urlSuffix } from '@/lib/engines/recovery'
import { matchesDefinition, rfmLabel } from '@/lib/engines/segments'
import { bestFaq } from '@/lib/engines/chatbot'
import { validateTemplate } from '@/app/api/templates/[id]/submit/route'
import { validateNodes } from '@/app/api/flows/[id]/route'
import { normalizeShopDomain } from '@/app/api/shopify/connect/route'

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
    expect(keys).toContain('CRON_SECRET')
    expect(r.missing.required.every((m: any) => m.breaks.length > 10)).toBe(true)
  })

  it('rejects an ENCRYPTION_KEY that is not 64 hex characters', async () => {
    const short = await health({ ...FULL, ENCRYPTION_KEY: 'too-short-not-hex' })
    expect(short.configured.ENCRYPTION_KEY).toBe(false)
    expect(short.missing.required.find((m: any) => m.key === 'ENCRYPTION_KEY').breaks).toMatch(/INVALID/)

    const wrongLength = await health({ ...FULL, ENCRYPTION_KEY: 'ab'.repeat(16) }) // 32 chars
    expect(wrongLength.configured.ENCRYPTION_KEY).toBe(false)
  })

  it('accepts AUTOMATION_CRON_SECRET as an alternative to CRON_SECRET', async () => {
    const r = await health({ ...FULL, CRON_SECRET: undefined, AUTOMATION_CRON_SECRET: 'x' })
    expect(r.configured.CRON_SECRET).toBe(true)
    expect(r.ok).toBe(true)
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
})
