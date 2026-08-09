import { withAuth, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * Stop a campaign mid-flight.
 *
 * Queued recipients STAY queued — pausing is reversible, "Resume" is the
 * send route and picks up exactly where this left off. The cron only drains
 * status='sending', and the batch loop re-reads the status every few sends,
 * so the halt lands within seconds even while a batch is running.
 */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase }) => {
    const { data: bc } = await supabase.from('broadcasts').select('id, status').eq('id', id).maybeSingle()
    if (!bc) badRequest('Broadcast not found')
    if (bc.status !== 'sending' && bc.status !== 'scheduled') {
      badRequest(`Only a sending or scheduled campaign can be paused — this one is "${bc.status}"`)
    }

    const { error } = await supabase.from('broadcasts').update({ status: 'paused' }).eq('id', id)
    if (error) badRequest(error.message)
    return { ok: true }
  })
}
