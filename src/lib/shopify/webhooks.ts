import { adminRest } from './admin'

/**
 * Webhook topics Wasify registers through the Admin API.
 *
 * orders/*        → COD confirmation + order mirror
 * checkouts/*     → abandoned cart recovery intake
 * fulfillments/*  → delivery status in the contact drawer
 * app/uninstalled → mark the connection dead instead of failing silently
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
] as const

/**
 * The three GDPR topics. They are NOT in the Admin API's topic enum — posting
 * one to webhooks.json is rejected with "Could not find the webhook topic
 * shop/redact". Shopify only accepts them from the Partner Dashboard's
 * Compliance webhooks section (or shopify.app.toml `compliance_topics`), which
 * is why they are listed here but never registered.
 *
 * The handlers exist in /api/shopify/webhook, so pointing all three at that
 * same URL in the Partner Dashboard is all that is needed. See SETUP.md 4e.
 */
export const COMPLIANCE_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'] as const

export type WebhookResult = { topic: string; ok: boolean; error?: string }

export async function registerShopifyWebhooks(
  domain: string,
  token: string,
  siteUrl: string
): Promise<{ results: WebhookResult[]; failed: WebhookResult[] }> {
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

  const results: WebhookResult[] = []

  for (const topic of WEBHOOK_TOPICS) {
    if (already.has(topic)) {
      results.push({ topic, ok: true })
      continue
    }

    const res = await adminRest(domain, token, 'webhooks.json', {
      method: 'POST',
      body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
    })

    // "address has already been taken" means the subscription exists, which is
    // the outcome we wanted. Treating it as an error made every re-register
    // look like a failure.
    const alreadyExists = !res.ok && /already been taken|already exists/i.test(res.error ?? '')

    results.push({ topic, ok: res.ok || alreadyExists, error: res.ok || alreadyExists ? undefined : res.error })
  }

  // Deliberately NOT throwing on a partial failure. Registration is a loop of
  // independent calls: one rejected topic used to abort the whole thing and
  // report "Not registered", hiding the eight that had just succeeded.
  return { results, failed: results.filter((r) => !r.ok) }
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
