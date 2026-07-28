import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return withAuth(async ({ supabase }) => {
    const [flows, events] = await Promise.all([
      supabase.from('flows').select('*').order('updated_at', { ascending: false }),
      supabase
        .from('flow_events')
        .select('id, flow_id, contact_id, node_key, status, detail, created_at, contacts:contact_id (name, phone)')
        .order('created_at', { ascending: false })
        .limit(40),
    ])
    return { flows: flows.data ?? [], events: events.data ?? [] }
  })
}

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<any>(request)
    const name = (body.name ?? '').trim()
    if (!name) badRequest('Flow name is required')

    const { data, error } = await supabase
      .from('flows')
      .insert({
        user_id: userId,
        name,
        description: body.description ?? null,
        trigger_type: body.trigger_type ?? 'keyword',
        trigger_config: body.trigger_config ?? {},
        status: 'draft',
      })
      .select('*')
      .single()

    if (error) badRequest(error.message)

    // Seed a first node so the editor is never empty.
    await supabase.from('flow_nodes').insert({
      user_id: userId,
      flow_id: data.id,
      node_key: 'node_1',
      position: 0,
      node_type: 'message',
      config: { body: '' },
    })

    return { flow: data }
  })
}
