import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<any>(request)
    if (!body.label?.trim()) badRequest('Give the discount a label')

    const row = {
      user_id: userId,
      label: body.label,
      discount_type: body.discount_type ?? 'percentage',
      percentage: body.discount_type === 'fixed_amount' ? null : Number(body.percentage ?? 10),
      amount: body.discount_type === 'fixed_amount' ? Number(body.amount ?? 0) : null,
      expiry_days: Number(body.expiry_days ?? 7),
      min_order_amount: body.min_order_amount ? Number(body.min_order_amount) : null,
      enabled: body.enabled ?? true,
    }

    const { data, error } = body.id
      ? await supabase.from('discounts').update(row).eq('id', body.id).select('*').single()
      : await supabase.from('discounts').insert(row).select('*').single()

    if (error) badRequest(error.message)
    return { discount: data }
  })
}

export async function DELETE(request: Request) {
  return withAuth(async ({ supabase }) => {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) badRequest('id is required')
    await supabase.from('discounts').delete().eq('id', id)
    return { ok: true }
  })
}
