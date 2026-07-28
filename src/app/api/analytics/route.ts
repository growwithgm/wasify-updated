import { withAuth } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Analytics is computed live from the source tables rather than from nightly
 * rollups. At a single tenant's data volume the queries are cheap, and it
 * removes a whole class of "the dashboard disagrees with the report" bugs
 * that pre-aggregated tables invite when a webhook arrives late.
 */
export async function GET(request: Request) {
  return withAuth(async ({ supabase }) => {
    const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get('days') ?? 30)))
    const from = new Date(Date.now() - days * 86400_000).toISOString()
    const prevFrom = new Date(Date.now() - days * 2 * 86400_000).toISOString()

    const [messagesRes, prevMessagesRes, ordersRes, contactsRes, codRes, recoveryRes, flowsRes, broadcastsRes, agentsRes, convRes] =
      await Promise.all([
        supabase.from('messages').select('id, sender_type, status, created_at, conversation_id, contact_id, pricing_cost').gte('created_at', from),
        supabase.from('messages').select('id, sender_type, status').gte('created_at', prevFrom).lt('created_at', from),
        supabase.from('shopify_orders').select('id, contact_id, total_price, currency, shopify_created_at, cancelled_at'),
        supabase.from('contacts').select('id, created_at, orders_count, lifetime_spent, rfm_segment, opt_in_status'),
        supabase.from('cod_confirmations').select('status, created_at').gte('created_at', from),
        supabase.from('checkout_recoveries').select('status, checkout_row_id, created_at').gte('created_at', from),
        supabase.from('flows').select('id, name, entered_count, completed_count, revenue, cost'),
        supabase.from('broadcasts').select('id, name, total_recipients, sent_count, delivered_count, read_count, replied_count, revenue, cost, created_at').gte('created_at', from),
        supabase.from('agents').select('id, name'),
        supabase.from('conversations').select('id, contact_id, assigned_to, status, created_at, last_inbound_at'),
      ])

    const messages = messagesRes.data ?? []
    const outbound = messages.filter((m: any) => m.sender_type !== 'customer')
    const inbound = messages.filter((m: any) => m.sender_type === 'customer')

    /* ------------------------- messaging funnel ------------------------ */
    const sent = outbound.filter((m: any) => m.status !== 'failed').length
    const delivered = outbound.filter((m: any) => ['delivered', 'read'].includes(m.status)).length
    const read = outbound.filter((m: any) => m.status === 'read').length
    const repliedConvs = new Set(inbound.map((m: any) => m.conversation_id)).size

    // Orders placed by a contact we messaged inside the window = attributed.
    const messagedContacts = new Set(outbound.map((m: any) => m.contact_id).filter(Boolean))
    const orders = ordersRes.data ?? []
    const windowOrders = orders.filter(
      (o: any) => o.shopify_created_at && o.shopify_created_at >= from && !o.cancelled_at
    )
    const attributedOrders = windowOrders.filter((o: any) => messagedContacts.has(o.contact_id))
    const attributedRevenue = attributedOrders.reduce((s: number, o: any) => s + Number(o.total_price ?? 0), 0)

    const funnel = [
      { name: 'Messages sent', n: sent },
      { name: 'Delivered', n: delivered, rate: sent ? `${((delivered / sent) * 100).toFixed(1)}%` : '—' },
      { name: 'Read', n: read, rate: delivered ? `${((read / delivered) * 100).toFixed(1)}%` : '—' },
      { name: 'Replied', n: repliedConvs, rate: read ? `${((repliedConvs / read) * 100).toFixed(1)}%` : '—' },
      { name: 'Ordered', n: attributedOrders.length, rate: repliedConvs ? `${((attributedOrders.length / repliedConvs) * 100).toFixed(1)}%` : '—' },
    ]

    /* ---------------------- messaged vs not-messaged -------------------- */
    // A real holdout needs a control group assigned up front. Until that
    // exists this is an observational comparison and is labelled as such.
    const contacts = contactsRes.data ?? []
    const messagedSet = messagedContacts
    const messagedRevenue = orders
      .filter((o: any) => messagedSet.has(o.contact_id) && !o.cancelled_at)
      .reduce((s: number, o: any) => s + Number(o.total_price ?? 0), 0)
    const notMessagedRevenue = orders
      .filter((o: any) => o.contact_id && !messagedSet.has(o.contact_id) && !o.cancelled_at)
      .reduce((s: number, o: any) => s + Number(o.total_price ?? 0), 0)

    const messagedCount = messagedSet.size
    const notMessagedCount = Math.max(0, contacts.length - messagedCount)

    const comparison = {
      messagedRpc: messagedCount ? messagedRevenue / messagedCount : 0,
      notMessagedRpc: notMessagedCount ? notMessagedRevenue / notMessagedCount : 0,
      messagedCount,
      notMessagedCount,
    }

    /* --------------------------- COD & recovery ------------------------- */
    const cod = codRes.data ?? []
    const codDecided = cod.filter((c: any) => c.status !== 'pending')
    const codRate = codDecided.length
      ? (cod.filter((c: any) => c.status === 'confirmed').length / codDecided.length) * 100
      : 0

    const recoveries = recoveryRes.data ?? []
    const recoveredIds = recoveries.filter((r: any) => r.status === 'completed_order').map((r: any) => r.checkout_row_id).filter(Boolean)

    let recoveredRevenue = 0
    if (recoveredIds.length) {
      const { data } = await supabase.from('shopify_checkouts').select('total_price').in('id', recoveredIds.slice(0, 500))
      recoveredRevenue = (data ?? []).reduce((s: number, c: any) => s + Number(c.total_price ?? 0), 0)
    }

    const recoveryStarted = recoveries.filter((r: any) => r.status !== 'skipped_no_phone' && r.status !== 'suppressed_cooldown').length
    const recoveryRate = recoveryStarted ? (recoveredIds.length / recoveryStarted) * 100 : 0

    /* --------------------------- cohort retention ----------------------- */
    // First-order month → share of that cohort ordering again in month N.
    const byContact = new Map<string, string[]>()
    for (const o of orders) {
      if (!o.contact_id || !o.shopify_created_at || o.cancelled_at) continue
      if (!byContact.has(o.contact_id)) byContact.set(o.contact_id, [])
      byContact.get(o.contact_id)!.push(o.shopify_created_at)
    }

    const cohorts = new Map<string, { size: number; months: number[] }>()
    for (const dates of byContact.values()) {
      dates.sort()
      const first = new Date(dates[0])
      const key = `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}`
      if (!cohorts.has(key)) cohorts.set(key, { size: 0, months: [0, 0, 0, 0, 0, 0] })
      const cohort = cohorts.get(key)!
      cohort.size++

      const seen = new Set<number>()
      for (const d of dates.slice(1)) {
        const later = new Date(d)
        const offset =
          (later.getUTCFullYear() - first.getUTCFullYear()) * 12 + (later.getUTCMonth() - first.getUTCMonth())
        if (offset >= 1 && offset <= 6) seen.add(offset)
      }
      for (const offset of seen) cohort.months[offset - 1]++
    }

    const retention = [...cohorts.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 6)
      .map(([month, c]) => ({
        month,
        size: c.size,
        rates: c.months.map((n) => (c.size ? (n / c.size) * 100 : 0)),
      }))

    /* ----------------------------- per agent ---------------------------- */
    const conversations = convRes.data ?? []
    const agentStats = (agentsRes.data ?? []).map((a: any) => {
      const owned = conversations.filter((c: any) => c.assigned_to === a.id)
      return {
        id: a.id,
        name: a.name,
        conversations: owned.length,
        open: owned.filter((c: any) => c.status === 'open').length,
        closed: owned.filter((c: any) => c.status === 'closed').length,
      }
    })

    /* ------------------------------ deltas ------------------------------ */
    const prevOutbound = (prevMessagesRes.data ?? []).filter((m: any) => m.sender_type !== 'customer')
    const prevSent = prevOutbound.filter((m: any) => m.status !== 'failed').length

    const totalCost = messages.reduce((s: number, m: any) => s + Number(m.pricing_cost ?? 0), 0)

    return {
      range: { days, from },
      kpis: {
        sent,
        prevSent,
        delivered,
        read,
        repliedConvs,
        attributedRevenue,
        attributedOrders: attributedOrders.length,
        codRate,
        recoveredRevenue,
        recoveryRate,
        totalCost,
        roi: totalCost > 0 ? attributedRevenue / totalCost : null,
      },
      funnel,
      comparison,
      retention,
      agentStats,
      flows: (flowsRes.data ?? []).map((f: any) => ({
        ...f,
        roi: Number(f.cost) > 0 ? Number(f.revenue) / Number(f.cost) : null,
      })),
      broadcasts: broadcastsRes.data ?? [],
      rfm: countBy(contacts, 'rfm_segment'),
      optIn: countBy(contacts, 'opt_in_status'),
    }
  })
}

function countBy(rows: any[], key: string): Array<{ label: string; count: number }> {
  const map = new Map<string, number>()
  for (const r of rows) {
    const k = r[key] ?? 'unknown'
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
}
