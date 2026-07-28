import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Bulk assign / close from the inbox selection bar. */
export async function POST(request: Request) {
  return withAuth(async ({ supabase }) => {
    const { ids, action, agent_id } = await jsonBody<{
      ids: string[]
      action: 'assign' | 'close' | 'open'
      agent_id?: string | null
    }>(request)

    if (!Array.isArray(ids) || ids.length === 0) badRequest('No conversations selected')

    const patch =
      action === 'assign'
        ? { assigned_to: agent_id || null }
        : { status: action === 'close' ? 'closed' : 'open' }

    const { error } = await supabase.from('conversations').update(patch).in('id', ids)
    if (error) badRequest(error.message)

    return { ok: true, count: ids.length }
  })
}
