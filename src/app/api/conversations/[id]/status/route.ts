import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }
const ALLOWED = ['open', 'pending', 'closed']

export async function POST(request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase }) => {
    const { status } = await jsonBody<{ status: string }>(request)
    if (!ALLOWED.includes(status)) badRequest(`status must be one of ${ALLOWED.join(', ')}`)

    const { error } = await supabase.from('conversations').update({ status }).eq('id', id)
    if (error) throw new Error(error.message)
    return { ok: true }
  })
}
