import { withAuth } from '@/lib/api'
import { createServiceClient } from '@/lib/supabase/server'
import { classifySend } from '@/lib/engines/timeline'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The send timeline: who got which template, from which system, and what
 * happened to it. Built ENTIRELY from data the engines already write —
 * no new tables:
 *
 *   - messages            popup / recovery / COD / flows / back-in-stock
 *                         mirror every send here; the WhatsApp status
 *                         webhook keeps status + error_message current.
 *   - broadcast_recipients broadcasts never mirror into messages — their
 *                         per-recipient rows carry the same fields.
 *
 * The system is classified from the stable content prefix each engine
 * stamps (see classifySend). The 3-day window is only the DEFAULT range —
 * the caller can page back as far as the data goes.
 */

const MAX_ROWS = 500

export async function GET(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const url = new URL(request.url)
    const now = Date.now()
    const from = url.searchParams.get('from') || new Date(now - 3 * 86400_000).toISOString()
    const to = url.searchParams.get('to') || new Date(now + 86400_000).toISOString()
    // Commas and parens would splice into PostgREST's or() filter syntax.
    const q = (url.searchParams.get('q') ?? '').trim().replace(/[,()]/g, '')
    const system = url.searchParams.get('system') ?? ''
    const status = url.searchParams.get('status') ?? ''
    const contactId = url.searchParams.get('contact_id') ?? ''
    const limit = Math.min(MAX_ROWS, Math.max(1, Number(url.searchParams.get('limit') ?? 300)))

    // A number/name search resolves to contact ids first, so BOTH sources
    // filter on the same set. 100 ids stay well under the URL limits that
    // bit the broadcast audience queries.
    let searchIds: string[] | null = null
    if (q && !contactId) {
      const { data } = await supabase
        .from('contacts')
        .select('id')
        .or(`phone.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(100)
      searchIds = (data ?? []).map((r: any) => r.id)
      if (!searchIds.length) return { rows: [], contact: null, shopify_push: null }
    }

    /* ---- source 1: engine sends mirrored into messages ---- */
    let mq = supabase
      .from('messages')
      .select(
        'id, contact_id, content, template_name, status, error_message, error_code, created_at, contacts(name, phone)'
      )
      .eq('sender_type', 'bot')
      .not('template_name', 'is', null)
      .gte('created_at', from)
      .lte('created_at', to)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (contactId) mq = mq.eq('contact_id', contactId)
    else if (searchIds) mq = mq.in('contact_id', searchIds)

    /* ---- source 2: broadcast recipients ---- */
    let bq = supabase
      .from('broadcast_recipients')
      .select(
        'id, contact_id, phone, name, status, error_message, error_code, sent_at, created_at, broadcasts(name, template_name)'
      )
      .gte('created_at', from)
      .lte('created_at', to)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (contactId) bq = bq.eq('contact_id', contactId)
    else if (searchIds) bq = bq.in('contact_id', searchIds)

    const [messages, recipients] = await Promise.all([mq, bq])
    if (messages.error) throw new Error(messages.error.message)
    if (recipients.error) throw new Error(recipients.error.message)

    const formatError = (message: string | null, code: unknown) =>
      message ? `${message}${code ? ` (#${code})` : ''}` : code ? `error #${code}` : null

    let rows = [
      ...(messages.data ?? []).map((m: any) => {
        const cls = classifySend(m.content)
        return {
          id: `m-${m.id}`,
          at: m.created_at,
          contact_id: m.contact_id,
          name: m.contacts?.name ?? null,
          phone: m.contacts?.phone ?? null,
          system: cls.system,
          detail: cls.detail,
          template: m.template_name,
          status: m.status,
          error: formatError(m.error_message, m.error_code),
        }
      }),
      ...(recipients.data ?? []).map((r: any) => ({
        id: `b-${r.id}`,
        at: r.sent_at ?? r.created_at,
        contact_id: r.contact_id,
        name: r.name ?? null,
        phone: r.phone ?? null,
        system: 'broadcast' as const,
        detail: r.broadcasts?.name ?? null,
        template: r.broadcasts?.template_name ?? null,
        status: r.status === 'queued' ? 'pending' : r.status,
        error: formatError(r.error_message, r.error_code),
      })),
    ]

    if (system) rows = rows.filter((r) => r.system === system)
    if (status) rows = rows.filter((r) => r.status === status)
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
    rows = rows.slice(0, limit)

    /* ---- contact drill-down: who they are + Shopify push state ---- */
    let contact: any = null
    let shopifyPush: any = null
    if (contactId) {
      const { data: c } = await supabase
        .from('contacts')
        .select('id, name, phone, opt_in_status, opt_in_source, created_at')
        .eq('id', contactId)
        .maybeSingle()
      contact = c ?? null
      if (c?.phone) {
        // Queue rows only exist for pushes that FAILED inline; no row means
        // the direct push reported ok (or the contact predates the popup).
        const service = createServiceClient()
        const { data: pushRow } = await service
          .from('shopify_push_queue')
          .select('status, last_error, updated_at')
          .eq('user_id', userId)
          .eq('phone', c.phone)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        shopifyPush = pushRow
          ? { status: pushRow.status, error: pushRow.last_error, at: pushRow.updated_at }
          : { status: 'direct', error: null, at: null }
      }
    }

    return { rows, contact, shopify_push: shopifyPush }
  })
}
