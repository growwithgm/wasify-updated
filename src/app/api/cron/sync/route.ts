import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isAuthorizedCron, cronUnauthorizedBody } from '@/lib/cron'
import { getShopifyConfig } from '@/lib/shopify/admin'
import { syncStore } from '@/lib/shopify/sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Scheduled Shopify reconciliation — the cron-safe twin of the manual
 * "Sync now" button, which cannot be scheduled because it requires a
 * signed-in browser session.
 *
 * Webhooks are the real-time path; this sweep is the safety net that
 * re-reconciles anything a missed delivery dropped and keeps a fresh store's
 * history filling in without anyone pressing the button. Newest-first with
 * skip-unchanged, so a quiet store costs a handful of reads and a busy one
 * spends the budget exactly where the new rows are.
 *
 * The daily 03:00 job also syncs, but shares its 60 seconds with RFM and
 * pruning. Scheduling THIS route hourly gives sync the whole budget.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    // The body names the header this deployment expects, so a misconfigured
    // scheduler diagnoses itself instead of silently never running.
    return NextResponse.json(cronUnauthorizedBody(), { status: 401 })
  }

  const db = createServiceClient()
  const started = Date.now()

  const { data: tenants } = await db
    .from('shopify_config')
    .select('user_id')
    .eq('connection_status', 'connected')

  const perTenant: Array<Record<string, unknown>> = []
  const list = tenants ?? []

  for (let i = 0; i < list.length; i++) {
    try {
      const config = await getShopifyConfig(list[i].user_id)
      if (!config) continue

      // Split the remaining time across the tenants still waiting, so the
      // last store in the list is never starved by the first. 280s inside
      // Pro's 300-second cap, keeping headroom for the response itself.
      const remainingMs = 280_000 - (Date.now() - started)
      if (remainingMs < 5_000) break
      const budgetMs = Math.floor(remainingMs / (list.length - i))

      const result = await syncStore(db, config, { sinceDays: 90, maxPages: 8, budgetMs })
      perTenant.push({
        user: list[i].user_id,
        orders: result.orders,
        checkouts: result.checkouts,
        products: result.products,
        partial: result.partial,
        errors: result.errors,
      })
    } catch (e: any) {
      perTenant.push({ user: list[i].user_id, error: e?.message ?? String(e) })
    }
  }

  return NextResponse.json({
    ok: true,
    stores: perTenant.length,
    tookMs: Date.now() - started,
    results: perTenant,
  })
}
