import { adminGraphql } from './admin'

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
  const existing = await listShopifyWebhooks(domain, token)
  const already = new Set(existing.filter((w) => w.address === address).map((w) => w.topic))

  const results: WebhookResult[] = []

  for (const topic of WEBHOOK_TOPICS) {
    if (already.has(topic)) {
      results.push({ topic, ok: true })
      continue
    }

    const res = await adminGraphql<any>(
      domain,
      token,
      `mutation Subscribe($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }`,
      { topic: graphqlTopic(topic), sub: { callbackUrl: address, format: 'JSON' } }
    )

    const userErrors = res.ok ? (res.data?.webhookSubscriptionCreate?.userErrors ?? []) : []
    const message = res.ok ? userErrors.map((e: any) => e.message).join('; ') : res.error

    // "address has already been taken" means the subscription exists, which is
    // the outcome we wanted. Treating it as an error made every re-register
    // look like a failure.
    const alreadyExists = /already been taken|already exists/i.test(message ?? '')
    const ok = (res.ok && userErrors.length === 0) || alreadyExists

    results.push({ topic, ok, error: ok ? undefined : message })
  }

  // Deliberately NOT throwing on a partial failure. Registration is a loop of
  // independent calls: one rejected topic used to abort the whole thing and
  // report "Not registered", hiding the eight that had just succeeded.
  return { results, failed: results.filter((r) => !r.ok) }
}

/** `orders/create` → `ORDERS_CREATE`, the GraphQL enum spelling. */
export function graphqlTopic(topic: string): string {
  return topic.replace(/[\/-]/g, '_').toUpperCase()
}

/** `ORDERS_CREATE` → `orders/create`, so callers keep speaking REST topics. */
export function restTopic(topic: string): string {
  const lower = String(topic).toLowerCase()
  const cut = lower.lastIndexOf('_')
  return cut < 0 ? lower : `${lower.slice(0, cut).replace(/_/g, '/')}/${lower.slice(cut + 1)}`
}

export async function listShopifyWebhooks(
  domain: string,
  token: string
): Promise<Array<{ id: string; topic: string; address: string }>> {
  const res = await adminGraphql<any>(
    domain,
    token,
    `query { webhookSubscriptions(first: 100) { nodes {
      id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
    } } }`
  )
  if (!res.ok) return []

  return (res.data?.webhookSubscriptions?.nodes ?? []).map((w: any) => ({
    id: w.id,
    topic: restTopic(w.topic),
    address: w.endpoint?.callbackUrl ?? '',
  }))
}
