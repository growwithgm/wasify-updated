import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<any>(request)
    if (!body.question?.trim() || !body.answer?.trim()) {
      badRequest('Question and answer are both required')
    }

    const row = {
      user_id: userId,
      question: body.question,
      answer: body.answer,
      languages: body.languages?.length ? body.languages : ['es'],
      keywords: (body.keywords ?? []).map((k: string) => k.trim()).filter(Boolean),
      is_active: body.is_active ?? true,
    }

    const { data, error } = body.id
      ? await supabase.from('chatbot_faqs').update(row).eq('id', body.id).select('*').single()
      : await supabase.from('chatbot_faqs').insert(row).select('*').single()

    if (error) badRequest(error.message)
    return { faq: data }
  })
}

export async function DELETE(request: Request) {
  return withAuth(async ({ supabase }) => {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) badRequest('id is required')
    await supabase.from('chatbot_faqs').delete().eq('id', id)
    return { ok: true }
  })
}
