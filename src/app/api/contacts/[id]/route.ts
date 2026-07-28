import { withAuth, jsonBody, notFound } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** Full customer 360 for the inbox rail and the contact drawer. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase }) => {
    const [contactRes, tagsRes, notesRes, ordersRes, dealsRes, checkoutRes, consentRes, timelineRes] =
      await Promise.all([
        supabase.from('contacts').select('*').eq('id', id).maybeSingle(),
        supabase.from('contact_tags').select('tag_id, tags:tag_id (id, name, color)').eq('contact_id', id),
        supabase
          .from('contact_notes')
          .select('*')
          .eq('contact_id', id)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('shopify_orders')
          .select('id, shopify_order_id, order_number, total_price, currency, financial_status, fulfillment_status, is_cod, shopify_created_at')
          .eq('contact_id', id)
          .order('shopify_created_at', { ascending: false })
          .limit(10),
        supabase
          .from('deals')
          .select('id, title, value, currency, stage_id, pipeline_stages:stage_id (name)')
          .eq('contact_id', id)
          .is('closed_at', null)
          .limit(5),
        supabase
          .from('shopify_checkouts')
          .select('id, total_price, currency, abandoned_checkout_url, shopify_created_at, completed_at, recovered')
          .eq('contact_id', id)
          .is('completed_at', null)
          .order('shopify_created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('consent_events')
          .select('*')
          .eq('contact_id', id)
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('activity_events')
          .select('id, kind, title, detail, amount, created_at')
          .eq('contact_id', id)
          .order('created_at', { ascending: false })
          .limit(12),
      ])

    if (!contactRes.data) notFound('Contact not found')

    return {
      contact: contactRes.data,
      tags: (tagsRes.data ?? []).map((r: any) => r.tags).filter(Boolean),
      notes: notesRes.data ?? [],
      orders: ordersRes.data ?? [],
      deals: (dealsRes.data ?? []).map((d: any) => ({
        ...d,
        stage_name: d.pipeline_stages?.name ?? null,
      })),
      openCheckout: checkoutRes.data ?? null,
      consent: consentRes.data ?? [],
      timeline: timelineRes.data ?? [],
    }
  })
}

const EDITABLE = [
  'name', 'email', 'company', 'locale', 'country', 'city', 'postcode',
  'opt_in_status', 'accepts_marketing', 'is_blocked',
]

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody(request)
    const patch: Record<string, unknown> = {}
    for (const key of EDITABLE) if (key in body) patch[key] = body[key]

    if ('opt_in_status' in patch) {
      // Consent changes are auditable — log them and keep the timestamps honest.
      const now = new Date().toISOString()
      if (patch.opt_in_status === 'opted_in') patch.opt_in_at = now
      if (patch.opt_in_status === 'opted_out') patch.opt_out_at = now

      await supabase.from('consent_events').insert({
        user_id: userId,
        contact_id: id,
        event: patch.opt_in_status === 'opted_in' ? 'opt_in' : 'opt_out',
        source: 'manual',
        detail: 'Changed from the contact drawer',
      })
    }

    const { data, error } = await supabase
      .from('contacts')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw new Error(error.message)
    return { contact: data }
  })
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase }) => {
    const { error } = await supabase.from('contacts').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { ok: true }
  })
}
