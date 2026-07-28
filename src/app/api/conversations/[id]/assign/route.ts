import { withAuth, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase }) => {
    const { agent_id } = await jsonBody<{ agent_id: string | null }>(request)
    const { error } = await supabase
      .from('conversations')
      .update({ assigned_to: agent_id || null })
      .eq('id', id)
    if (error) throw new Error(error.message)
    return { ok: true }
  })
}
