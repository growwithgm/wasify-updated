import { withAuth, badRequest } from '@/lib/api'
import { createServiceClient } from '@/lib/supabase/server'
import { getShopifyConfig } from '@/lib/shopify/admin'
import { syncStore } from '@/lib/shopify/sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Manual "Sync now" from the Integrations / Catalog screens. */
export async function POST(request: Request) {
  return withAuth(async ({ userId }) => {
    const config = await getShopifyConfig(userId)
    if (!config) badRequest('Connect a Shopify store first')

    const url = new URL(request.url)
    const sinceDays = Math.min(365, Number(url.searchParams.get('days') ?? 90))

    const result = await syncStore(createServiceClient(), config, { sinceDays, maxPages: 8 })
    return { ok: result.errors.length === 0, ...result }
  })
}
