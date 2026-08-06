import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { normalizeShopDomain } from '@/app/api/shopify/connect/route'
import { makeCode, toMetaPhone } from '@/lib/flow/order-confirmation'
import { variantLabel, pushKlaviyoProfile } from '@/lib/flow/stock-alerts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Back-in-stock signup, called by the theme widget on the product page.
 *
 * PUBLIC — no auth, so its defences are layered: a honeypot field that
 * swallows bots with a lying 200, an IP rate limit, phone validation, and a
 * per-(shop, variant, phone) unique constraint that makes replays no-ops.
 *
 * The payload shape is a contract with the theme developer's widget —
 * do not change it without telling them.
 */

/** Storefront origins allowed to call this from the browser. */
function corsOrigin(request: Request): string {
  const origin = request.headers.get('origin') ?? ''
  const allowed = (process.env.STOCK_ALERT_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // No list configured → any storefront may call. There are no cookies or
  // credentials in play; the endpoint's real defences are above.
  if (!allowed.length) return '*'
  return allowed.includes(origin) ? origin : allowed[0]
}

function withCors(request: Request, res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', corsOrigin(request))
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type')
  return res
}

export async function OPTIONS(request: Request) {
  return withCors(request, new NextResponse(null, { status: 204 }))
}

/**
 * 5 submits per IP per 10 minutes.
 *
 * In-memory, so each serverless instance counts separately and a cold start
 * resets it — acceptable, because it only needs to blunt bursts. The durable
 * guards are the honeypot and the unique constraint; a patient attacker
 * gains nothing but duplicate-key errors.
 */
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX = 5
const hits = new Map<string, number[]>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent)
    return true
  }
  recent.push(now)
  hits.set(ip, recent)
  // Bound the map so a wide botnet cannot balloon instance memory.
  if (hits.size > 10_000) hits.clear()
  return false
}

export async function POST(request: Request) {
  let body: {
    name?: string
    phone?: string
    email?: string
    hp?: string
    shop?: string
    locale?: string
    country_code?: string
    product_id?: string | number
    product_title?: string
    product_url?: string
    variants?: Array<{ id: string | number; title?: string }>
  }
  try {
    body = await request.json()
  } catch {
    return withCors(request, NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }))
  }

  // Honeypot: a human never fills the invisible field. Answer exactly like
  // success so the bot learns nothing.
  if ((body.hp ?? '').trim()) {
    return withCors(request, NextResponse.json({ ok: true, added: 0 }))
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'

  if (rateLimited(ip)) {
    return withCors(request, NextResponse.json({ error: 'Too many requests' }, { status: 429 }))
  }

  const shop = normalizeShopDomain(body.shop ?? '')
  const productId = body.product_id != null ? String(body.product_id) : ''
  const variants = (body.variants ?? []).filter((v) => v?.id != null).slice(0, 20)

  if (!shop || !productId || !body.product_url || !variants.length) {
    return withCors(
      request,
      NextResponse.json({ error: 'shop, product_id, product_url and variants are required' }, { status: 400 })
    )
  }

  const phone = toMetaPhone(body.phone, body.country_code)
  if (!phone) {
    return withCors(request, NextResponse.json({ error: 'Invalid phone number' }, { status: 400 }))
  }

  const db = createServiceClient()

  // Tenant linkage, same key as everything else. Unknown shop → nothing to
  // attach the signup to.
  const { data: config } = await db
    .from('shopify_config')
    .select('user_id')
    .eq('store_domain', shop)
    .maybeSingle()
  if (!config) {
    return withCors(request, NextResponse.json({ error: 'Unknown shop' }, { status: 400 }))
  }

  let added = 0

  for (const variant of variants) {
    const { error } = await db.from('stock_alerts').insert({
      user_id: config.user_id,
      shop,
      product_id: productId,
      variant_id: String(variant.id),
      product_title: body.product_title ?? null,
      variant_title: variant.title ?? null,
      product_url: body.product_url,
      name: (body.name ?? '').trim() || null,
      phone,
      email: (body.email ?? '').trim() || null,
      locale: (body.locale ?? 'es').slice(0, 8),
      consent_ip: ip,
      short_code: makeCode(),
    })

    if (!error) {
      added++
    } else if (String(error.code) !== '23505') {
      // 23505 = already signed up for this variant — a no-op, not a failure.
      // Anything else is real (schema drift, say) and must not be silent.
      return withCors(request, NextResponse.json({ error: error.message }, { status: 500 }))
    }
  }

  // Email backup for when WhatsApp fails or the customer blocks the number.
  // Best-effort and env-gated — never allowed to fail the signup.
  if (added > 0) {
    await pushKlaviyoProfile({
      email: body.email,
      phone,
      name: body.name,
      variantLabel: variantLabel(body.product_title, variants[0]?.title),
    })
  }

  return withCors(request, NextResponse.json({ ok: true, added }))
}
