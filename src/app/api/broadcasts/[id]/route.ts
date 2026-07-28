import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase }) => {
    const [bc, recipients, optOuts] = await Promise.all([
      supabase.from('broadcasts').select('*').eq('id', id).maybeSingle(),
      supabase
        .from('broadcast_recipients')
        .select('*')
        .eq('broadcast_id', id)
        .order('status')
        .limit(500),
      supabase
        .from('consent_events')
        .select('id, contact_id, keyword, created_at, contacts:contact_id (name, phone)')
        .eq('event', 'opt_out')
        .order('created_at', { ascending: false })
        .limit(50),
    ])

    if (!bc.data) badRequest('Broadcast not found')
    return { broadcast: bc.data, recipients: recipients.data ?? [], optOuts: optOuts.data ?? [] }
  })
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase }) => {
    const body = await jsonBody(request)
    const patch: Record<string, unknown> = {}
    for (const k of ['name', 'scheduled_at', 'status', 'variable_map', 'audience']) {
      if (k in body) patch[k] = body[k]
    }
    const { data, error } = await supabase.from('broadcasts').update(patch).eq('id', id).select('*').single()
    if (error) badRequest(error.message)
    return { broadcast: data }
  })
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase }) => {
    const { data: bc } = await supabase.from('broadcasts').select('status').eq('id', id).maybeSingle()
    if (bc?.status === 'sending') badRequest('Pause the campaign before deleting it')
    const { error } = await supabase.from('broadcasts').delete().eq('id', id)
    if (error) badRequest(error.message)
    return { ok: true }
  })
}
