import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { normalizeShopDomain } from '@/app/api/shopify/connect/route'
import { makeCode, toMetaPhone } from '@/lib/flow/order-confirmation'
import { variantLabel, pushKlaviyoProfile, originAllowed } from '@/lib/flow/stock-alerts'
import { upsertBisCustomer } from '@/lib/shopify/customers'

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

/**
 * CORS: echo the caller's origin (no cookies are in play, so this is safe)
 * and enforce the allow-list with a READABLE 403 instead of a header
 * mismatch. A mismatch surfaces in the browser as a bare "Failed to fetch",
 * which is exactly the undiagnosable state the theme developer reported.
 */
function withCors(request: Request, res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', request.headers.get('origin') || '*')
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type')
  res.headers.set('Vary', 'Origin')
  return res
}

export async function OPTIONS(request: Request) {
  // Preflight always succeeds — the allow-list verdict comes on the POST,
  // where the body can carry a reason the widget can actually display.
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

export type SubscribeBody = {
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

/**
 * The whole signup, transport-agnostic — shared by the direct CORS route
 * below and the App Proxy route, so the two paths can never drift.
 */
export async function processSubscribe(
  body: SubscribeBody,
  ip: string
): Promise<{ status: number; payload: Record<string, unknown> }> {
  // Honeypot: a human never fills the invisible field. Answer exactly like
  // success so the bot learns nothing.
  if ((body.hp ?? '').trim()) {
    return { status: 200, payload: { ok: true, added: 0 } }
  }

  if (rateLimited(ip)) {
    return { status: 429, payload: { error: 'Too many requests' } }
  }

  const shop = normalizeShopDomain(body.shop ?? '')
  const productId = body.product_id != null ? String(body.product_id) : ''
  const variants = (body.variants ?? []).filter((v) => v?.id != null).slice(0, 20)

  if (!shop || !productId || !body.product_url || !variants.length) {
    return { status: 400, payload: { error: 'shop, product_id, product_url and variants are required' } }
  }

  const phone = toMetaPhone(body.phone, body.country_code)
  if (!phone) {
    return { status: 400, payload: { error: 'Invalid phone number' } }
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
    return { status: 400, payload: { error: 'Unknown shop' } }
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
      return { status: 500, payload: { error: error.message } }
    }
  }

  if (added > 0) {
    // Email backup for when WhatsApp fails or the customer blocks the number.
    // Best-effort and env-gated — never allowed to fail the signup.
    await pushKlaviyoProfile({
      email: body.email,
      phone,
      name: body.name,
      variantLabel: variantLabel(body.product_title, variants[0]?.title),
    })

    // Mirror into Shopify as customer + bis-* tags so Flow's "Customer tags
    // added" trigger can pick it up. Also best-effort: a missing scope or a
    // pending Protected Customer Data approval logs, and the signup succeeds.
    await upsertBisCustomer(shop, {
      email: body.email,
      phone,
      name: body.name,
      variantIds: variants.map((v) => v.id),
    })
  }

  return { status: 200, payload: { ok: true, added } }
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin')
  if (!originAllowed(origin, process.env.STOCK_ALERT_ORIGINS)) {
    // Readable on purpose: the preflight passed, so the widget can show this
    // instead of the browser's opaque "Failed to fetch".
    return withCors(
      request,
      NextResponse.json(
        { error: `Origin ${origin ?? '(none)'} is not in STOCK_ALERT_ORIGINS` },
        { status: 403 }
      )
    )
  }

  let body: SubscribeBody
  try {
    body = await request.json()
  } catch {
    return withCors(request, NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }))
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'

  const result = await processSubscribe(body, ip)
  return withCors(request, NextResponse.json(result.payload, { status: result.status }))
}
