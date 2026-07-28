import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<any>(request)
    const keywords = (body.keywords ?? []).map((k: string) => k.trim()).filter(Boolean)
    if (!keywords.length) badRequest('Add at least one keyword')
    if (!body.reply_text?.trim()) badRequest('The reply text is required')

    const row = {
      user_id: userId,
      keywords,
      match_type: body.match_type ?? 'contains',
      reply_text: body.reply_text,
      language: body.language ?? 'es',
      priority: Number(body.priority ?? 0),
      is_active: body.is_active ?? true,
    }

    const { data, error } = body.id
      ? await supabase.from('chatbot_rules').update(row).eq('id', body.id).select('*').single()
      : await supabase.from('chatbot_rules').insert(row).select('*').single()

    if (error) badRequest(error.message)
    return { rule: data }
  })
}

export async function DELETE(request: Request) {
  return withAuth(async ({ supabase }) => {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) badRequest('id is required')
    await supabase.from('chatbot_rules').delete().eq('id', id)
    return { ok: true }
  })
}
