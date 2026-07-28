import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Bucket = { day: string; sent: number; delivered: number; read: number; failed: number }

function dayKey(iso: string) {
  return iso.slice(0, 10)
}

/** Everything the Dashboard screen needs, in one round trip. */
export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 30)))
  const now = new Date()
  const from = new Date(now.getTime() - days * 86400_000)
  const prevFrom = new Date(now.getTime() - days * 2 * 86400_000)

  const fromIso = from.toISOString()
  const prevFromIso = prevFrom.toISOString()

  const [messagesRes, prevMessagesRes, convRes, codRes, prevCodRes, flowsRes, broadcastsRes, recoveryRes, waRes, activityRes, contactsRes] =
    await Promise.all([
      supabase
        .from('messages')
        .select('id, status, sender_type, created_at, conversation_id, pricing_category, pricing_cost, contact_id')
        .gte('created_at', fromIso),
      supabase
        .from('messages')
        .select('id, status, sender_type, created_at')
        .gte('created_at', prevFromIso)
        .lt('created_at', fromIso),
      supabase.from('conversations').select('id, status, last_inbound_at, created_at'),
      supabase.from('cod_confirmations').select('status, created_at').gte('created_at', fromIso),
      supabase
        .from('cod_confirmations')
        .select('status, created_at')
        .gte('created_at', prevFromIso)
        .lt('created_at', fromIso),
      supabase
        .from('flows')
        .select('id, name, entered_count, completed_count, revenue, cost')
        .order('revenue', { ascending: false })
        .limit(6),
      supabase.from('broadcasts').select('revenue, cost, created_at').gte('created_at', fromIso),
      supabase
        .from('checkout_recoveries')
        .select('id, status, checkout_row_id, created_at')
        .gte('created_at', fromIso),
      supabase
        .from('whatsapp_config')
        .select('quality_rating, messaging_tier, messages_sent_24h, connection_status')
        .maybeSingle(),
      supabase
        .from('activity_events')
        .select('id, kind, title, detail, amount, created_at')
        .order('created_at', { ascending: false })
        .limit(8),
      supabase.from('contacts').select('id, country'),
    ])

  const messages = messagesRes.data ?? []
  const prevMessages = prevMessagesRes.data ?? []
  const conversations = convRes.data ?? []

  /* ---------------------------- message KPIs --------------------------- */

  const outbound = messages.filter((m: any) => m.sender_type !== 'customer' && !m.is_internal_note)
  const prevOutbound = prevMessages.filter((m: any) => m.sender_type !== 'customer')

  const rate = (rows: any[], statuses: string[]) => {
    const total = rows.filter((m) => m.status !== 'failed').length
    if (!total) return 0
    return (rows.filter((m) => statuses.includes(m.status)).length / total) * 100
  }

  const sentCount = outbound.length
  const deliveryRate = rate(outbound, ['delivered', 'read'])
  const readRate = rate(outbound, ['read'])
  const prevDeliveryRate = rate(prevOutbound, ['delivered', 'read'])
  const prevReadRate = rate(prevOutbound, ['read'])

  // Reply rate: share of conversations that got a customer message in the window.
  const inboundConvIds = new Set(
    messages.filter((m: any) => m.sender_type === 'customer').map((m: any) => m.conversation_id)
  )
  const outboundConvIds = new Set(outbound.map((m: any) => m.conversation_id))
  const replyRate = outboundConvIds.size
    ? ([...outboundConvIds].filter((id) => inboundConvIds.has(id)).length / outboundConvIds.size) * 100
    : 0

  /* ---------------------- message volume by day ------------------------ */

  const buckets = new Map<string, Bucket>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000)
    const key = d.toISOString().slice(0, 10)
    buckets.set(key, { day: key, sent: 0, delivered: 0, read: 0, failed: 0 })
  }
  for (const m of outbound as any[]) {
    const b = buckets.get(dayKey(m.created_at))
    if (!b) continue
    b.sent++
    if (m.status === 'delivered' || m.status === 'read') b.delivered++
    if (m.status === 'read') b.read++
    if (m.status === 'failed') b.failed++
  }
  const volume = [...buckets.values()]

  /* ------------------------------ COD ---------------------------------- */

  const cod = codRes.data ?? []
  const codDecided = cod.filter((c: any) => c.status !== 'pending')
  const codRate = codDecided.length
    ? (cod.filter((c: any) => c.status === 'confirmed').length / codDecided.length) * 100
    : 0
  const prevCod = prevCodRes.data ?? []
  const prevCodDecided = prevCod.filter((c: any) => c.status !== 'pending')
  const prevCodRate = prevCodDecided.length
    ? (prevCod.filter((c: any) => c.status === 'confirmed').length / prevCodDecided.length) * 100
    : 0

  /* -------------------------- attribution ------------------------------ */

  const flows = flowsRes.data ?? []
  const broadcasts = broadcastsRes.data ?? []
  const flowRevenue = flows.reduce((s: number, f: any) => s + Number(f.revenue ?? 0), 0)
  const broadcastRevenue = broadcasts.reduce((s: number, b: any) => s + Number(b.revenue ?? 0), 0)

  // Recovered-cart revenue comes from checkouts that a recovery sequence closed.
  const recoveredIds = (recoveryRes.data ?? [])
    .filter((r: any) => r.status === 'completed_order')
    .map((r: any) => r.checkout_row_id)
    .filter(Boolean)

  let recoveredRevenue = 0
  if (recoveredIds.length) {
    const { data } = await supabase
      .from('shopify_checkouts')
      .select('total_price')
      .in('id', recoveredIds.slice(0, 500))
    recoveredRevenue = (data ?? []).reduce((s: number, c: any) => s + Number(c.total_price ?? 0), 0)
  }

  // Anything not attributable to a flow or broadcast is manual inbox work.
  const manualRevenue = 0
  const totalRevenue = flowRevenue + broadcastRevenue + manualRevenue

  /* ---------------------- first response time -------------------------- */

  // Average gap between a customer message and the next agent reply, per conversation.
  const byConv = new Map<string, any[]>()
  for (const m of messages as any[]) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, [])
    byConv.get(m.conversation_id)!.push(m)
  }
  const gaps: number[] = []
  for (const list of byConv.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at))
    let waitingSince: number | null = null
    for (const m of list) {
      const t = new Date(m.created_at).getTime()
      if (m.sender_type === 'customer') {
        if (waitingSince === null) waitingSince = t
      } else if (waitingSince !== null) {
        gaps.push((t - waitingSince) / 1000)
        waitingSince = null
      }
    }
  }
  const avgFirstResponse = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0

  /* ------------------------- cost tracker ------------------------------ */

  const countryByContact = new Map<string, string>()
  for (const c of (contactsRes.data ?? []) as any[]) countryByContact.set(c.id, c.country || 'Unknown')

  const CATEGORIES = ['marketing', 'utility', 'authentication', 'service'] as const
  const byCategory: Record<string, { cost: number; conversations: number }> = {}
  for (const cat of CATEGORIES) byCategory[cat] = { cost: 0, conversations: 0 }

  const byCountry = new Map<string, Record<string, number>>()
  const emptyRow = (): Record<string, number> => ({
    marketing: 0,
    utility: 0,
    authentication: 0,
    service: 0,
    total: 0,
  })
  let totalCost = 0

  for (const m of messages as any[]) {
    const cat = (m.pricing_category || '').toLowerCase()
    if (!CATEGORIES.includes(cat as any)) continue
    const cost = Number(m.pricing_cost ?? 0)
    byCategory[cat].cost += cost
    byCategory[cat].conversations += 1
    totalCost += cost

    const country = countryByContact.get(m.contact_id) || 'Unknown'
    if (!byCountry.has(country)) byCountry.set(country, emptyRow())
    const row = byCountry.get(country)!
    row[cat] += cost
    row.total += cost
  }

  const countries = [...byCountry.entries()]
    .map(([country, v]) => ({ country, ...v }) as { country: string } & Record<string, number>)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)

  /* ------------------------------ done --------------------------------- */

  const wa = waRes.data
  const activeConversations = conversations.filter((c: any) => c.status !== 'closed').length

  return NextResponse.json({
    range: { days, from: fromIso, to: now.toISOString() },
    kpis: {
      totalRevenue,
      recoveredRevenue,
      messagesSent: sentCount,
      prevMessagesSent: prevOutbound.length,
      deliveryRate,
      prevDeliveryRate,
      readRate,
      prevReadRate,
      replyRate,
      codRate,
      prevCodRate,
      activeConversations,
      avgFirstResponse,
    },
    volume,
    attribution: [
      { label: 'Flows', value: flowRevenue, color: '#16A34A' },
      { label: 'Broadcasts', value: broadcastRevenue, color: '#2563EB' },
      { label: 'Manual (inbox)', value: manualRevenue, color: '#F59E0B' },
    ],
    numberHealth: {
      connected: wa?.connection_status === 'connected',
      quality: wa?.quality_rating ?? null,
      tier: wa?.messaging_tier ?? null,
      used: wa?.messages_sent_24h ?? 0,
    },
    topFlows: flows.map((f: any) => ({
      id: f.id,
      name: f.name,
      entered: f.entered_count,
      completed: f.completed_count,
      revenue: Number(f.revenue ?? 0),
      cost: Number(f.cost ?? 0),
      roi: Number(f.cost) > 0 ? Number(f.revenue) / Number(f.cost) : null,
    })),
    activity: activityRes.data ?? [],
    cost: {
      total: totalCost,
      byCategory: CATEGORIES.map((c) => ({ category: c, ...byCategory[c] })),
      countries,
    },
  })
}
