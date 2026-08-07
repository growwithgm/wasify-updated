import { safeEqual, hmacHex } from '@/lib/crypto'

/**
 * Back-in-stock alert helpers. Pure logic here, routes stay thin —
 * same split as order-confirmation.
 */

/**
 * What the message calls the thing that restocked. Shopify names a
 * one-variant product's only variant "Default Title", and nobody wants
 * "Bohemian Maxi Dress — Default Title" on WhatsApp.
 */
export function variantLabel(productTitle: string | null | undefined, variantTitle: string | null | undefined): string {
  const product = (productTitle ?? '').trim() || 'This product'
  const variant = (variantTitle ?? '').trim()
  if (!variant || variant.toLowerCase() === 'default title') return product
  return `${product} — ${variant}`
}

/**
 * How many subscribers one restock may message: three per unit that came in.
 *
 * The flood this prevents: 200 pending, 5 units restocked. Uncapped, 195
 * people land on a sold-out page, hit block/report, and the WhatsApp quality
 * rating drops the whole account a messaging tier. The unmessaged stay
 * `pending` — first in line for the next restock, FIFO.
 */
export function restockCap(pendingCount: number, available: number): number {
  const units = Math.max(0, Math.floor(available))
  return Math.min(pendingCount, units * 3)
}

/**
 * Is this browser origin allowed to call the subscribe endpoint?
 *
 * Matching is by HOSTNAME, case-insensitive, and treats `www.` and the apex
 * as the same site — `https://www.ibban.com` must not fail against an
 * allow-list entry of `https://ibban.com`. An empty list allows everything:
 * the endpoint is public by design and its real defences are the honeypot,
 * the rate limit and the unique constraint.
 */
export function originAllowed(origin: string | null | undefined, allowedCsv: string | undefined): boolean {
  const list = (allowedCsv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!list.length) return true
  if (!origin) return false

  const bare = (value: string): string | null => {
    try {
      const host = new URL(value.includes('://') ? value : `https://${value}`).hostname
      return host.toLowerCase().replace(/^www\./, '')
    } catch {
      return null
    }
  }

  const originHost = bare(origin)
  if (!originHost) return false
  return list.some((entry) => bare(entry) === originHost)
}

/**
 * The update a repeat form-fill applies to a row that was already notified.
 *
 * One message per signup: after a row goes `sent` (or `failed`), the next
 * restock must NOT include it again — only the customer filling the form
 * again re-arms it. That re-fill is a NEW request, so the row goes back to
 * `pending` at the BACK of the FIFO queue (fresh created_at), with fresh
 * consent and whatever name/email they typed this time. The short_code is
 * deliberately absent from the patch: the link in the message they already
 * received must keep working.
 */
export function rearmPatch(form: {
  name?: string | null
  email?: string | null
  locale?: string | null
  productTitle?: string | null
  variantTitle?: string | null
  productUrl: string
  ip?: string | null
  now?: Date
}): Record<string, unknown> {
  const at = (form.now ?? new Date()).toISOString()
  return {
    status: 'pending',
    notified_at: null,
    clicked_at: null,
    created_at: at,
    consent_at: at,
    consent_ip: form.ip ?? null,
    name: (form.name ?? '').trim() || null,
    email: (form.email ?? '').trim() || null,
    locale: (form.locale ?? 'es').slice(0, 8),
    product_title: form.productTitle ?? null,
    variant_title: form.variantTitle ?? null,
    product_url: form.productUrl,
  }
}

/** The tags a signup earns: the general marker plus one per variant. */
export function bisTags(variantIds: Array<string | number>): string[] {
  const tags = new Set<string>(['back-in-stock'])
  for (const id of variantIds) {
    const clean = String(id).trim()
    if (clean) tags.add(`bis-${clean}`)
  }
  return [...tags]
}

/**
 * Shopify App Proxy signature check.
 *
 * Shopify signs proxied requests with the app's shared secret: every query
 * parameter except `signature`, values of repeated keys joined by commas,
 * pairs sorted and concatenated WITHOUT separators, HMAC-SHA256 hex.
 */
export function verifyProxySignature(params: URLSearchParams, secret: string): boolean {
  const signature = params.get('signature') ?? ''
  if (!signature || !secret) return false

  const grouped = new Map<string, string[]>()
  for (const [key, value] of params.entries()) {
    if (key === 'signature') continue
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(value)
  }

  const message = [...grouped.keys()]
    .sort()
    .map((key) => `${key}=${grouped.get(key)!.join(',')}`)
    .join('')

  return safeEqual(hmacHex(secret, message), signature)
}

/**
 * Best-effort Klaviyo profile upsert so email can back WhatsApp up.
 *
 * The brief said "use the existing Klaviyo integration" — there is none in
 * this repo, so this is the smallest honest version: gated on
 * KLAVIYO_PRIVATE_KEY, silent no-op without it, and never allowed to fail the
 * signup that triggered it.
 */
export async function pushKlaviyoProfile(profile: {
  email?: string | null
  phone?: string | null
  name?: string | null
  variantLabel: string
}): Promise<void> {
  const key = process.env.KLAVIYO_PRIVATE_KEY
  if (!key || (!profile.email && !profile.phone)) return

  try {
    const res = await fetch('https://a.klaviyo.com/api/profile-import', {
      method: 'POST',
      headers: {
        Authorization: `Klaviyo-API-Key ${key}`,
        'Content-Type': 'application/vnd.api+json',
        revision: '2025-04-15',
      },
      body: JSON.stringify({
        data: {
          type: 'profile',
          attributes: {
            ...(profile.email ? { email: profile.email } : {}),
            ...(profile.phone ? { phone_number: `+${profile.phone}` } : {}),
            ...(profile.name ? { first_name: profile.name } : {}),
            properties: { back_in_stock_variant: profile.variantLabel },
          },
        },
      }),
      cache: 'no-store',
    })
    if (!res.ok) console.error('[stock-alerts] klaviyo upsert failed', res.status, await res.text())
  } catch (e) {
    console.error('[stock-alerts] klaviyo unreachable', e)
  }
}
