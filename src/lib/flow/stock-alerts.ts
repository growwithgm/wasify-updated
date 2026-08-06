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
