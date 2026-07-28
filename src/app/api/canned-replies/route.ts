import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return withAuth(async ({ supabase }) => {
    const { data } = await supabase.from('canned_replies').select('*').order('shortcut')
    return { cannedReplies: data ?? [] }
  })
}

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<{ shortcut: string; body: string; language?: string }>(request)
    const shortcut = (body.shortcut ?? '').trim().replace(/^\//, '')
    const text = (body.body ?? '').trim()
    if (!shortcut || !text) badRequest('Shortcut and message text are both required')

    const { data, error } = await supabase
      .from('canned_replies')
      .upsert(
        { user_id: userId, shortcut, body: text, language: body.language || 'es' },
        { onConflict: 'user_id,shortcut' }
      )
      .select('*')
      .single()

    if (error) badRequest(error.message)
    return { cannedReply: data }
  })
}
