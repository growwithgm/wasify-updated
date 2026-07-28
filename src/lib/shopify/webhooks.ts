import { adminRest } from './admin'

/**
 * Webhook topics Wasify relies on.
 *
 * orders/*        → COD confirmation + order mirror
 * checkouts/*     → abandoned cart recovery intake
 * fulfillments/*  → delivery status in the contact drawer
 * app/uninstalled → mark the connection dead instead of failing silently
 * shop/redact     → GDPR erasure
 */
export const WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'checkouts/create',
  'checkouts/update',
  'fulfillments/create',
  'fulfillments/update',
  'app/uninstalled',
  'shop/redact',
] as const

export async function registerShopifyWebhooks(domain: string, token: string, siteUrl: string) {
  const address = `${siteUrl.replace(/\/$/, '')}/api/shopify/webhook`

  // Reconnects re-run this, so read what already exists and skip duplicates.
  const existing = await adminRest<{ webhooks: Array<{ id: number; topic: string; address: string }> }>(
    domain,
    token,
    'webhooks.json',
    { query: { limit: 250 } }
  )

  const already = new Set(
    existing.ok ? existing.data.webhooks.filter((w) => w.address === address).map((w) => w.topic) : []
  )

  const results: Array<{ topic: string; ok: boolean; error?: string }> = []

  for (const topic of WEBHOOK_TOPICS) {
    if (already.has(topic)) {
      results.push({ topic, ok: true })
      continue
    }

    const res = await adminRest(domain, token, 'webhooks.json', {
      method: 'POST',
      body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
    })

    results.push({ topic, ok: res.ok, error: res.ok ? undefined : res.error })
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    throw new Error(`Could not register: ${failed.map((f) => `${f.topic} (${f.error})`).join(', ')}`)
  }

  return results
}

export async function listShopifyWebhooks(domain: string, token: string) {
  const res = await adminRest<{ webhooks: Array<{ id: number; topic: string; address: string; created_at: string }> }>(
    domain,
    token,
    'webhooks.json',
    { query: { limit: 250 } }
  )
  return res.ok ? res.data.webhooks : []
}
