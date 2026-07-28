import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return withAuth(async ({ supabase }) => {
    const { data } = await supabase
      .from('message_templates')
      .select('*')
      .order('status')
      .order('name')
    return { templates: data ?? [] }
  })
}

/** Save a draft from the builder. Submitting to Meta is a separate call. */
export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<any>(request)

    const name = (body.name ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!name) badRequest('Template name is required')
    if (!body.body_text?.trim()) badRequest('The body text is required')

    const { data, error } = await supabase
      .from('message_templates')
      .upsert(
        {
          user_id: userId,
          name,
          language: body.language || 'es',
          category: body.category || 'MARKETING',
          status: 'DRAFT',
          header_type: body.header_type || 'none',
          header_text: body.header_text || null,
          header_media_url: body.header_media_url || null,
          body_text: body.body_text,
          footer_text: body.footer_text || null,
          buttons: body.buttons ?? [],
          sample_values: body.sample_values ?? {},
        },
        { onConflict: 'user_id,name,language' }
      )
      .select('*')
      .single()

    if (error) badRequest(error.message)
    return { template: data }
  })
}
