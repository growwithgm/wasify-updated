import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isAuthorizedCron, cronUnauthorizedBody } from '@/lib/cron'
import { runCodTimers } from '@/lib/engines/cod'
import { runRecoveryTimers } from '@/lib/engines/recovery'
import { runDueAutomations } from '@/lib/engines/automations'
import { resumeDueFlowRuns } from '@/lib/engines/flows'
import { sendDueBroadcasts } from '@/lib/engines/broadcasts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vercel's Hobby plan caps serverless functions at 60 seconds. Every sweep
// below is idempotent, so a timeout mid-run is safe — the next call simply
// picks up where this one stopped.
export const maxDuration = 60

/**
 * The 15-minute tick. Everything here is idempotent — running it twice in a
 * row never double-sends, because each sweep gates on a counter or a stage
 * timestamp. 15 minutes is the granularity the 45-minute first cart reminder
 * needs; the old app's daily cron was far too coarse for that.
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

  // Each sweep is independent: one failing must not stop the others.
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['cod', () => runCodTimers(db)],
    ['recovery', () => runRecoveryTimers(db)],
    ['automations', () => runDueAutomations(db)],
    ['flows', () => resumeDueFlowRuns(db)],
    ['broadcasts', () => sendDueBroadcasts(db)],
    ['snooze', () => wakeSnoozedConversations(db)],
  ]

  for (const [name, run] of steps) {
    try {
      results[name] = await run()
    } catch (e: any) {
      errors.push(`${name}: ${e?.message ?? e}`)
      results[name] = { error: String(e?.message ?? e) }
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    duration_ms: Date.now() - started,
    results,
    ...(errors.length ? { errors } : {}),
  })
}

export const POST = GET

/** Flip snoozed conversations back to open once their timer passes. */
async function wakeSnoozedConversations(db: any) {
  const { data } = await db
    .from('conversations')
    .update({ status: 'open', snoozed_until: null })
    .lte('snoozed_until', new Date().toISOString())
    .not('snoozed_until', 'is', null)
    .select('id')

  return { woken: data?.length ?? 0 }
}
