import { withAuth } from '@/lib/api'
import { refreshSegment } from '@/lib/engines/segments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase, userId }) => {
    const count = await refreshSegment(supabase, userId, id)
    return { ok: true, member_count: count }
  })
}
