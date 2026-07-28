import { withAuth, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase }) => {
    const { data: tpl } = await supabase
      .from('message_templates')
      .select('status')
      .eq('id', id)
      .maybeSingle()

    if (tpl?.status === 'APPROVED') {
      badRequest('Approved templates must be deleted in Meta Business Manager first, then re-synced')
    }

    const { error } = await supabase.from('message_templates').delete().eq('id', id)
    if (error) badRequest(error.message)
    return { ok: true }
  })
}
