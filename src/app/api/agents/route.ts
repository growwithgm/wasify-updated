import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return withAuth(async ({ supabase }) => {
    const { data } = await supabase.from('agents').select('*').order('is_self', { ascending: false }).order('name')
    return { agents: data ?? [] }
  })
}

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<{ name: string; email?: string; role?: string; languages?: string[] }>(request)
    const name = (body.name ?? '').trim()
    if (!name) badRequest('Agent name is required')

    const { data, error } = await supabase
      .from('agents')
      .insert({
        user_id: userId,
        name,
        email: body.email || null,
        role: body.role || 'agent',
        languages: body.languages?.length ? body.languages : ['es'],
      })
      .select('*')
      .single()

    if (error) badRequest(error.message)
    return { agent: data }
  })
}

export async function DELETE(request: Request) {
  return withAuth(async ({ supabase }) => {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) badRequest('id is required')

    const { data: agent } = await supabase.from('agents').select('is_self').eq('id', id).maybeSingle()
    if (agent?.is_self) badRequest('You cannot remove your own agent record')

    // Unassign their work rather than orphaning it behind a dangling id.
    await supabase.from('conversations').update({ assigned_to: null }).eq('assigned_to', id)
    await supabase.from('deals').update({ owner_id: null }).eq('owner_id', id)
    await supabase.from('agents').delete().eq('id', id)

    return { ok: true }
  })
}
