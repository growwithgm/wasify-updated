import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase, userId }) => {
    const { body } = await jsonBody<{ body: string }>(request)
    const text = (body ?? '').trim()
    if (!text) badRequest('The note is empty')

    const { data: agent } = await supabase.from('agents').select('name').eq('is_self', true).maybeSingle()

    const { data, error } = await supabase
      .from('contact_notes')
      .insert({ user_id: userId, contact_id: id, body: text, author_name: agent?.name ?? 'You' })
      .select('*')
      .single()

    if (error) badRequest(error.message)
    return { note: data }
  })
}
