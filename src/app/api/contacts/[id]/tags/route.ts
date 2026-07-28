import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** Attach a tag by id, or find-or-create one by name. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase, userId }) => {
    const { tag_id, name } = await jsonBody<{ tag_id?: string; name?: string }>(request)

    let tagId = tag_id
    if (!tagId) {
      const label = (name ?? '').trim()
      if (!label) badRequest('Provide a tag name')

      const { data: existing } = await supabase
        .from('tags')
        .select('id')
        .eq('user_id', userId)
        .ilike('name', label)
        .maybeSingle()

      if (existing) {
        tagId = existing.id
      } else {
        const { data: created, error } = await supabase
          .from('tags')
          .insert({ user_id: userId, name: label })
          .select('id')
          .single()
        if (error) badRequest(error.message)
        tagId = created.id
      }
    }

    await supabase
      .from('contact_tags')
      .upsert({ user_id: userId, contact_id: id, tag_id: tagId }, { onConflict: 'contact_id,tag_id' })

    return { ok: true, tag_id: tagId }
  })
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase }) => {
    const tagId = new URL(request.url).searchParams.get('tag_id')
    if (!tagId) badRequest('tag_id is required')

    await supabase.from('contact_tags').delete().eq('contact_id', id).eq('tag_id', tagId)
    return { ok: true }
  })
}
