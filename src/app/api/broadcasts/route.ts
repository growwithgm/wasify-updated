import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { buildRecipients, broadcastShapeProblem } from '@/lib/engines/broadcasts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return withAuth(async ({ supabase }) => {
    const { data } = await supabase.from('broadcasts').select('*').order('created_at', { ascending: false })
    return { broadcasts: data ?? [] }
  })
}

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<any>(request)

    const name = (body.name ?? '').trim()
    if (!name) badRequest('Campaign name is required')
    if (!body.template_name) badRequest('Pick an approved template')

    // Refuse at creation, with the reason on screen — not per-recipient in a
    // delivery report. This re-pulls the template from Meta first, so a
    // template edited since the last sync is caught here too.
    const problem = await broadcastShapeProblem({
      user_id: userId,
      template_name: body.template_name,
      template_language: body.template_language ?? 'es',
      variable_map: body.variable_map ?? {},
    })
    if (problem) badRequest(problem)

    const { data, error } = await supabase
      .from('broadcasts')
      .insert({
        user_id: userId,
        name,
        template_id: body.template_id ?? null,
        template_name: body.template_name,
        template_language: body.template_language ?? 'es',
        audience: body.audience ?? { mode: 'all' },
        variable_map: body.variable_map ?? {},
        status: body.scheduled_at ? 'scheduled' : 'draft',
        scheduled_at: body.scheduled_at ?? null,
      })
      .select('*')
      .single()

    if (error) badRequest(error.message)

    // Materialise the audience now so the draft shows a real recipient count.
    const recipients = await buildRecipients(supabase, userId, data)
    if (recipients.length) {
      for (let i = 0; i < recipients.length; i += 500) {
        await supabase
          .from('broadcast_recipients')
          .upsert(recipients.slice(i, i + 500), { onConflict: 'broadcast_id,phone', ignoreDuplicates: true })
      }
    }

    return { broadcast: data, recipients: recipients.length }
  })
}
