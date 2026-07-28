import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { evaluateSegment, refreshSegment } from '@/lib/engines/segments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase, userId }) => {
    const { data: segment } = await supabase.from('segments').select('*').eq('id', id).maybeSingle()
    if (!segment) badRequest('Segment not found')
    const contacts = await evaluateSegment(supabase, userId, id)
    return { segment, contacts: contacts.slice(0, 100), total: contacts.length }
  })
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody(request)
    const patch: Record<string, unknown> = {}
    for (const key of ['name', 'description', 'definition', 'is_dynamic', 'color']) {
      if (key in body) patch[key] = body[key]
    }

    const { data, error } = await supabase.from('segments').update(patch).eq('id', id).select('*').single()
    if (error) badRequest(error.message)

    const count = await refreshSegment(supabase, userId, id)
    return { segment: { ...data, member_count: count } }
  })
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase }) => {
    const { error } = await supabase.from('segments').delete().eq('id', id)
    if (error) badRequest(error.message)
    return { ok: true }
  })
}
