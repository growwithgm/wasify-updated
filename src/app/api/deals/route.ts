import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<any>(request)
    if (!body.title?.trim()) badRequest('Deal title is required')
    if (!body.stage_id) badRequest('Pick a stage')

    const { data: stage } = await supabase
      .from('pipeline_stages')
      .select('pipeline_id')
      .eq('id', body.stage_id)
      .maybeSingle()
    if (!stage) badRequest('That stage no longer exists')

    const { data, error } = await supabase
      .from('deals')
      .insert({
        user_id: userId,
        pipeline_id: stage.pipeline_id,
        stage_id: body.stage_id,
        contact_id: body.contact_id ?? null,
        title: body.title,
        value: Number(body.value ?? 0),
        owner_id: body.owner_id ?? null,
        next_action: body.next_action ?? null,
      })
      .select('*')
      .single()

    if (error) badRequest(error.message)
    return { deal: data }
  })
}

/** Move a card between stages (drag and drop) or edit its fields. */
export async function PATCH(request: Request) {
  return withAuth(async ({ supabase }) => {
    const body = await jsonBody<any>(request)
    if (!body.id) badRequest('id is required')

    const patch: Record<string, unknown> = {}
    for (const k of ['title', 'value', 'owner_id', 'next_action', 'position', 'contact_id']) {
      if (k in body) patch[k] = body[k]
    }

    if (body.stage_id) {
      patch.stage_id = body.stage_id
      // Stage velocity is measured from this timestamp.
      patch.stage_entered_at = new Date().toISOString()

      const { data: stage } = await supabase
        .from('pipeline_stages')
        .select('is_won, is_lost')
        .eq('id', body.stage_id)
        .maybeSingle()
      if (stage?.is_won || stage?.is_lost) patch.closed_at = new Date().toISOString()
      else patch.closed_at = null
    }

    const { data, error } = await supabase.from('deals').update(patch).eq('id', body.id).select('*').single()
    if (error) badRequest(error.message)
    return { deal: data }
  })
}

export async function DELETE(request: Request) {
  return withAuth(async ({ supabase }) => {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) badRequest('id is required')
    await supabase.from('deals').delete().eq('id', id)
    return { ok: true }
  })
}
