import { withAuth, badRequest } from '@/lib/api'
import { createServiceClient } from '@/lib/supabase/server'
import { buildRecipients, sendBroadcastBatch, broadcastShapeProblem } from '@/lib/engines/broadcasts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Params = { params: Promise<{ id: string }> }

/**
 * Start (or resume) a send. The first batch runs inline so the merchant sees
 * immediate movement; the 15-minute cron drains the rest.
 */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase, userId }) => {
    const { data: broadcast } = await supabase.from('broadcasts').select('*').eq('id', id).maybeSingle()
    if (!broadcast) badRequest('Broadcast not found')
    if (broadcast.status === 'sent') badRequest('This campaign has already finished')

    // Same fresh-from-Meta shape gate the cron applies — a draft created
    // before the template was edited must not slip through "Send now".
    const problem = await broadcastShapeProblem(broadcast)
    if (problem) badRequest(problem)

    const recipients = await buildRecipients(supabase, userId, broadcast)
    if (!recipients.length) badRequest('The selected audience is empty')

    for (let i = 0; i < recipients.length; i += 500) {
      await supabase
        .from('broadcast_recipients')
        .upsert(recipients.slice(i, i + 500), { onConflict: 'broadcast_id,phone', ignoreDuplicates: true })
    }

    await supabase
      .from('broadcasts')
      .update({ status: 'sending', started_at: new Date().toISOString() })
      .eq('id', id)

    const sent = await sendBroadcastBatch(createServiceClient(), { ...broadcast, status: 'sending' })

    return { ok: true, queued: recipients.length, sentInThisBatch: sent }
  })
}
