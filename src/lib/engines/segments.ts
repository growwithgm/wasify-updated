import type { SegmentCondition, SegmentDefinition, SegmentGroup } from '@/lib/types'
import { normalize } from './types'

/**
 * Segment evaluation.
 *
 * Conditions are evaluated in JS rather than compiled to SQL. Reason: several
 * fields (tags, bought_product, replied_within_hours) live in child tables and
 * a generated SQL tree would need joins whose shape depends on the rule set.
 * A tenant's contact list is bounded (tens of thousands), so one pass over a
 * pre-joined snapshot is both simpler and easier to keep correct.
 */

export const SEGMENT_FIELDS = [
  { key: 'total_spent', label: 'Total spent', type: 'number' },
  { key: 'orders_count', label: 'Order count', type: 'number' },
  { key: 'avg_order_value', label: 'Average order value', type: 'number' },
  { key: 'days_since_last_order', label: 'Days since last order', type: 'number' },
  { key: 'has_tag', label: 'Has tag', type: 'tag' },
  { key: 'not_has_tag', label: "Doesn't have tag", type: 'tag' },
  { key: 'accepts_marketing', label: 'Accepts marketing', type: 'boolean' },
  { key: 'opt_in_status', label: 'Opt-in status', type: 'enum' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'postcode', label: 'Postcode', type: 'text' },
  { key: 'locale', label: 'Language', type: 'text' },
  { key: 'rfm_segment', label: 'RFM tier', type: 'enum' },
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'source', label: 'Source', type: 'enum' },
  { key: 'bought_product', label: 'Bought product / SKU', type: 'text' },
  { key: 'days_since_created', label: 'Days since added', type: 'number' },
  { key: 'replied_within_hours', label: 'Replied within X hours', type: 'number' },
] as const

export const SEGMENT_OPERATORS = [
  { key: 'eq', label: 'is' },
  { key: 'neq', label: 'is not' },
  { key: 'gt', label: '>' },
  { key: 'gte', label: '≥' },
  { key: 'lt', label: '<' },
  { key: 'lte', label: '≤' },
  { key: 'contains', label: 'contains' },
  { key: 'not_contains', label: 'does not contain' },
  { key: 'is_set', label: 'is set' },
  { key: 'is_not_set', label: 'is empty' },
] as const

type Snapshot = {
  contact: any
  tagIds: Set<string>
  tagNames: Set<string>
  productTitles: Set<string>
  lastInboundAt: string | null
}

/** Load every contact plus the joined data the rules can reference. */
async function loadSnapshot(db: any, userId: string, needs: Set<string>): Promise<Snapshot[]> {
  const { data: contacts } = await db.from('contacts').select('*').eq('user_id', userId)
  if (!contacts?.length) return []

  const byId = new Map<string, Snapshot>(
    contacts.map((c: any) => [
      c.id,
      {
        contact: c,
        tagIds: new Set<string>(),
        tagNames: new Set<string>(),
        productTitles: new Set<string>(),
        lastInboundAt: null,
      },
    ])
  )

  if (needs.has('has_tag') || needs.has('not_has_tag')) {
    const { data: links } = await db
      .from('contact_tags')
      .select('contact_id, tag_id, tags:tag_id (name)')
      .eq('user_id', userId)

    for (const link of links ?? []) {
      const snap = byId.get(link.contact_id)
      if (!snap) continue
      snap.tagIds.add(link.tag_id)
      const name = (link as any).tags?.name
      if (name) snap.tagNames.add(normalize(name))
    }
  }

  if (needs.has('bought_product')) {
    const { data: orders } = await db
      .from('shopify_orders')
      .select('contact_id, line_items')
      .eq('user_id', userId)
      .not('contact_id', 'is', null)

    for (const order of orders ?? []) {
      const snap = byId.get(order.contact_id)
      if (!snap) continue
      for (const item of order.line_items ?? []) {
        if (item.title) snap.productTitles.add(normalize(item.title))
        if (item.sku) snap.productTitles.add(normalize(item.sku))
      }
    }
  }

  if (needs.has('replied_within_hours')) {
    const { data: conversations } = await db
      .from('conversations')
      .select('contact_id, last_inbound_at')
      .eq('user_id', userId)

    for (const conv of conversations ?? []) {
      const snap = byId.get(conv.contact_id)
      if (snap) snap.lastInboundAt = conv.last_inbound_at
    }
  }

  return [...byId.values()]
}

function fieldsUsed(definition: SegmentDefinition): Set<string> {
  const set = new Set<string>()
  for (const group of definition.groups ?? []) {
    for (const condition of group.conditions ?? []) set.add(condition.field)
  }
  return set
}

/** Evaluate a definition against a snapshot row. */
export function matchesDefinition(snap: Snapshot, definition: SegmentDefinition): boolean {
  const groups = definition.groups ?? []
  if (groups.length === 0) return true

  const results = groups.map((g) => matchesGroup(snap, g))
  return definition.op === 'or' ? results.some(Boolean) : results.every(Boolean)
}

function matchesGroup(snap: Snapshot, group: SegmentGroup): boolean {
  const conditions = group.conditions ?? []
  if (conditions.length === 0) return true

  const results = conditions.map((c) => matchesCondition(snap, c))
  return group.op === 'or' ? results.some(Boolean) : results.every(Boolean)
}

function matchesCondition(snap: Snapshot, condition: SegmentCondition): boolean {
  const { field, operator, value } = condition
  const c = snap.contact

  /* --- fields that are not plain columns --- */
  if (field === 'has_tag') return snap.tagIds.has(value) || snap.tagNames.has(normalize(value))
  if (field === 'not_has_tag') return !(snap.tagIds.has(value) || snap.tagNames.has(normalize(value)))

  if (field === 'bought_product') {
    const needle = normalize(value)
    return [...snap.productTitles].some((t) => t.includes(needle))
  }

  if (field === 'replied_within_hours') {
    if (!snap.lastInboundAt) return false
    const hours = (Date.now() - new Date(snap.lastInboundAt).getTime()) / 3_600_000
    return compareNumber(hours, operator, Number(value))
  }

  if (field === 'days_since_last_order') {
    if (!c.last_order_at) return operator === 'is_not_set'
    const days = (Date.now() - new Date(c.last_order_at).getTime()) / 86400_000
    return compareNumber(days, operator, Number(value))
  }

  if (field === 'days_since_created') {
    const days = (Date.now() - new Date(c.created_at).getTime()) / 86400_000
    return compareNumber(days, operator, Number(value))
  }

  /* --- plain columns --- */
  const column =
    field === 'total_spent'
      ? c.lifetime_spent
      : field === 'orders_count'
        ? c.orders_count
        : field === 'avg_order_value'
          ? c.avg_order_value
          : c[field]

  if (operator === 'is_set') return column != null && column !== '' && column !== false
  if (operator === 'is_not_set') return column == null || column === '' || column === false

  if (typeof column === 'number') return compareNumber(column, operator, Number(value))

  if (typeof column === 'boolean') {
    const wanted = value === 'true' || value === '1' || value === 'yes'
    return operator === 'neq' ? column !== wanted : column === wanted
  }

  const text = normalize(String(column ?? ''))
  const needle = normalize(value)

  switch (operator) {
    case 'eq':
      return text === needle
    case 'neq':
      return text !== needle
    case 'contains':
      return text.includes(needle)
    case 'not_contains':
      return !text.includes(needle)
    default:
      return false
  }
}

function compareNumber(actual: number, operator: string, expected: number): boolean {
  if (Number.isNaN(expected)) return false
  switch (operator) {
    case 'eq':
      return actual === expected
    case 'neq':
      return actual !== expected
    case 'gt':
      return actual > expected
    case 'gte':
      return actual >= expected
    case 'lt':
      return actual < expected
    case 'lte':
      return actual <= expected
    default:
      return false
  }
}

/** Contacts matching an ad-hoc definition — used by the live preview count. */
export async function previewDefinition(
  db: any,
  userId: string,
  definition: SegmentDefinition
): Promise<any[]> {
  const snapshot = await loadSnapshot(db, userId, fieldsUsed(definition))
  return snapshot.filter((s) => matchesDefinition(s, definition)).map((s) => s.contact)
}

/** Contacts matching a saved segment. */
export async function evaluateSegment(db: any, userId: string, segmentId: string): Promise<any[]> {
  const { data: segment } = await db
    .from('segments')
    .select('id, definition, is_dynamic')
    .eq('user_id', userId)
    .eq('id', segmentId)
    .maybeSingle()

  if (!segment) return []

  if (!segment.is_dynamic) {
    const { data: members } = await db
      .from('segment_members')
      .select('contacts:contact_id (*)')
      .eq('segment_id', segmentId)
    return (members ?? []).map((m: any) => m.contacts).filter(Boolean)
  }

  return previewDefinition(db, userId, segment.definition)
}

/** Recompute and cache membership. Called on save and by the daily cron. */
export async function refreshSegment(db: any, userId: string, segmentId: string): Promise<number> {
  const contacts = await evaluateSegment(db, userId, segmentId)

  await db.from('segment_members').delete().eq('segment_id', segmentId)

  if (contacts.length) {
    const rows = contacts.map((c) => ({ user_id: userId, segment_id: segmentId, contact_id: c.id }))
    for (let i = 0; i < rows.length; i += 500) {
      await db.from('segment_members').insert(rows.slice(i, i + 500))
    }
  }

  await db
    .from('segments')
    .update({ member_count: contacts.length, last_computed_at: new Date().toISOString() })
    .eq('id', segmentId)

  return contacts.length
}

/* ------------------------------------------------------------------ */
/* RFM                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Nightly RFM scoring. Quintiles per tenant, then a coarse tier label —
 * the same buckets the Contacts and Analytics screens display.
 */
export async function recomputeRfm(db: any, userId: string): Promise<number> {
  const { data: contacts } = await db
    .from('contacts')
    .select('id, lifetime_spent, orders_count, last_order_at')
    .eq('user_id', userId)

  const buyers = (contacts ?? []).filter((c: any) => (c.orders_count ?? 0) > 0)
  if (!buyers.length) return 0

  const now = Date.now()
  const recency = buyers.map((c: any) =>
    c.last_order_at ? (now - new Date(c.last_order_at).getTime()) / 86400_000 : 99999
  )
  const frequency = buyers.map((c: any) => c.orders_count ?? 0)
  const monetary = buyers.map((c: any) => Number(c.lifetime_spent ?? 0))

  const quintile = (values: number[], value: number, invert = false) => {
    const sorted = [...values].sort((a, b) => a - b)
    const rank = sorted.findIndex((v) => v >= value)
    const pct = rank < 0 ? 1 : rank / Math.max(1, sorted.length - 1)
    const score = Math.min(5, Math.max(1, Math.ceil(pct * 5) || 1))
    return invert ? 6 - score : score
  }

  const now_ = new Date().toISOString()

  for (let i = 0; i < buyers.length; i++) {
    const c = buyers[i]
    // Recency is inverted: recent (small number of days) should score high.
    const r = quintile(recency, recency[i], true)
    const f = quintile(frequency, frequency[i])
    const m = quintile(monetary, monetary[i])

    await db
      .from('contacts')
      .update({
        rfm_recency: r,
        rfm_frequency: f,
        rfm_monetary: m,
        rfm_segment: rfmLabel(r, f, m),
        rfm_computed_at: now_,
      })
      .eq('id', c.id)
  }

  return buyers.length
}

export function rfmLabel(r: number, f: number, m: number): string {
  if (r >= 4 && f >= 4 && m >= 4) return 'champion'
  if (r >= 4 && f >= 3) return 'loyal'
  if (r >= 4 && f <= 2) return 'new'
  if (r === 3 && f >= 3) return 'potential'
  if (r <= 2 && f >= 3 && m >= 3) return 'at_risk'
  if (r <= 2 && f >= 4) return 'cant_lose'
  if (r <= 2) return 'hibernating'
  return 'needs_attention'
}
