import { withAuth, badRequest } from '@/lib/api'
import { createServiceClient } from '@/lib/supabase/server'
import { getShopifyConfig } from '@/lib/shopify/admin'
import { registerShopifyWebhooks, listShopifyWebhooks, COMPLIANCE_TOPICS } from '@/lib/shopify/webhooks'
import { siteUrlStatus } from '@/lib/site-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Manual webhook re-registration.
 *
 * Registration at OAuth is best-effort — a scope that was not granted, or a
 * transient Shopify error, leaves a topic unsubscribed and the feature it
 * drives simply never fires. Without a retry the only remedy is to disconnect
 * and reconnect the store.
 */

/** What Shopify currently has, so a gap is visible rather than inferred. */
export async function GET() {
  return withAuth(async ({ userId }) => {
    const config = await getShopifyConfig(userId)
    if (!config) badRequest('Connect Shopify first')

    const live = await listShopifyWebhooks(config!.store_domain, config!.token)
    const site = siteUrlStatus()
    const address = site.ok ? `${site.url}/api/shopify/webhook` : null

    return {
      address,
      // Only subscriptions pointing at THIS deployment count. One left over
      // from another environment is not this app's webhook.
      registered: live.filter((w) => w.address === address).map((w) => w.topic),
      // Listed so the dashboard-only topics are not mistaken for a gap.
      complianceTopics: COMPLIANCE_TOPICS,
    }
  })
}

export async function POST() {
  return withAuth(async ({ userId }) => {
    const config = await getShopifyConfig(userId)
    if (!config) badRequest('Connect Shopify first')

    const site = siteUrlStatus()
    if (!site.ok) badRequest(site.message)

    const { results, failed } = await registerShopifyWebhooks(
      config!.store_domain,
      config!.token,
      site.url!
    )

    const db = createServiceClient()
    await db
      .from('shopify_config')
      .update({
        webhooks_registered: failed.length === 0,
        webhooks_registered_at: new Date().toISOString(),
        connection_error: failed.length
          ? `${results.length - failed.length} of ${results.length} webhooks registered. Failed: ` +
            failed.map((f) => `${f.topic} (${f.error})`).join(', ')
          : null,
      })
      .eq('user_id', userId)

    return {
      registered: results.filter((r) => r.ok).map((r) => r.topic),
      failed: failed.map((f) => ({ topic: f.topic, error: f.error })),
    }
  })
}
