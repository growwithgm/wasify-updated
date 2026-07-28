import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { refreshSegment, SEGMENT_FIELDS, SEGMENT_OPERATORS } from '@/lib/engines/segments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return withAuth(async ({ supabase }) => {
    const { data } = await supabase.from('segments').select('*').order('created_at', { ascending: false })
    return { segments: data ?? [], fields: SEGMENT_FIELDS, operators: SEGMENT_OPERATORS }
  })
}

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<{
      name: string
      description?: string
      definition: any
      is_dynamic?: boolean
      color?: string
    }>(request)

    const name = (body.name ?? '').trim()
    if (!name) badRequest('Segment name is required')

    const { data, error } = await supabase
      .from('segments')
      .insert({
        user_id: userId,
        name,
        description: body.description ?? null,
        definition: body.definition ?? { op: 'and', groups: [] },
        is_dynamic: body.is_dynamic ?? true,
        color: body.color ?? '#16A34A',
      })
      .select('*')
      .single()

    if (error) badRequest(error.code === '23505' ? 'A segment with that name already exists' : error.message)

    // Materialise immediately so the count is correct the moment it appears.
    const count = await refreshSegment(supabase, userId, data.id)
    return { segment: { ...data, member_count: count } }
  })
}
