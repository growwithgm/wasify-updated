import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isAuthorizedCron, cronUnauthorizedBody } from '@/lib/cron'
import { getShopifyConfig } from '@/lib/shopify/admin'
import { syncStore } from '@/lib/shopify/sync'
import { recomputeRfm, refreshSegment } from '@/lib/engines/segments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vercel Pro allows 300 seconds. Every sweep below is idempotent, so a
// timeout mid-run is safe — the next call simply picks up where this one
// stopped.
export const maxDuration = 300

/**
 * Nightly maintenance: Shopify backfill, RFM scoring, static segment refresh,
 * and log pruning. Messaging sweeps live in /api/cron/tick — nothing here
 * sends a message.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    // The body names the header this deployment expects, so a misconfigured
    // scheduler diagnoses itself instead of silently never running.
    return NextResponse.json(cronUnauthorizedBody(), { status: 401 })
  }

  const db = createServiceClient()
  const started = Date.now()
  const results: Record<string, unknown> = {}
  const errors: string[] = []

  const { data: tenants } = await db.from('shopify_config').select('user_id').eq('connection_status', 'connected')

  /* ---- Shopify backfill, per tenant ---- */
  let synced = 0
  for (const tenant of tenants ?? []) {
    try {
      const config = await getShopifyConfig(tenant.user_id)
      if (!config) continue
      // The daily run also does RFM, segments and pruning inside the same
      // function, so sync gets a slice, not the whole window. The hourly
      // /api/cron/sync is the one that owns deep history work.
      await syncStore(db, config, { maxPages: 4, sinceDays: 30, budgetMs: 90_000 })
      synced++
    } catch (e: any) {
      errors.push(`sync ${tenant.user_id}: ${e?.message ?? e}`)
    }
  }
  results.storesSynced = synced

  /* ---- RFM + static segments, per tenant ---- */
  const { data: profiles } = await db.from('profiles').select('id')
  let scored = 0
  let segmentsRefreshed = 0

  for (const profile of profiles ?? []) {
    try {
      scored += await recomputeRfm(db, profile.id)
      const { data: segments } = await db
        .from('segments')
        .select('id')
        .eq('user_id', profile.id)
        .eq('is_dynamic', false)
      for (const segment of segments ?? []) {
        await refreshSegment(db, profile.id, segment.id)
        segmentsRefreshed++
      }
    } catch (e: any) {
      errors.push(`rfm ${profile.id}: ${e?.message ?? e}`)
    }
  }
  results.contactsScored = scored
  results.segmentsRefreshed = segmentsRefreshed

  /* ---- prune webhook logs older than 30 days ---- */
  try {
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString()
    await db.from('whatsapp_webhook_events').delete().lt('created_at', cutoff)
    await db.from('shopify_webhook_events').delete().lt('created_at', cutoff)
    results.logsPruned = true
  } catch (e: any) {
    errors.push(`prune: ${e?.message ?? e}`)
  }

  return NextResponse.json({
    ok: errors.length === 0,
    duration_ms: Date.now() - started,
    results,
    ...(errors.length ? { errors } : {}),
  })
}

export const POST = GET
