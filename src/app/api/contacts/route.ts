import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { findOrCreateContact } from '@/lib/contacts'
import { isValidPhone, sanitizePhone } from '@/lib/phone'
import { previewDefinition } from '@/lib/engines/segments'
import type { SegmentDefinition } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

/** An arbitrary sort param would reach PostgREST as a column name and 400. */
const SORTABLE = new Set([
  'created_at', 'name', 'phone', 'email', 'last_order_at',
  'lifetime_spent', 'orders_count', 'avg_order_value', 'rfm_segment',
])

export async function GET(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim()
    const page = Math.max(0, Number(url.searchParams.get('page') ?? 0))
    const segmentId = url.searchParams.get('segment')
    const tagId = url.searchParams.get('tag')
    const sortParam = url.searchParams.get('sort') ?? 'created_at'
    const sort = SORTABLE.has(sortParam) ? sortParam : 'created_at'
    const dir = url.searchParams.get('dir') === 'asc'

    // Filtering used to collect the matching contact ids first and pass them
    // back through .in('id', [...]) — a tag on 800 contacts made a ~30 KB
    // request URL, which the API rejects outright ("Bad Request"). Inner-join
    // embeds filter on the server instead, so the URL stays the same size no
    // matter how many contacts carry the tag.
    const embeds = ['contact_tags(tag_id, tags:tag_id (id, name, color))']
    if (tagId) embeds.push('tag_filter:contact_tags!inner(tag_id)')
    if (segmentId) embeds.push('seg_filter:segment_members!inner(segment_id)')

    let query = supabase
      .from('contacts')
      .select(`*, ${embeds.join(', ')}`, { count: 'exact' })
      .order(sort, { ascending: dir })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

    if (tagId) query = query.eq('tag_filter.tag_id', tagId)
    if (segmentId) query = query.eq('seg_filter.segment_id', segmentId)

    if (q) {
      const digits = sanitizePhone(q)
      const clauses = [`name.ilike.%${q}%`, `email.ilike.%${q}%`, `company.ilike.%${q}%`]
      if (digits.length >= 3) clauses.push(`phone.ilike.%${digits}%`)
      query = query.or(clauses.join(','))
    }

    const { data, error, count } = await query
    if (error) badRequest(error.message)

    return {
      // The filter embeds did their job in the WHERE clause — they are not
      // part of the contact the page renders.
      contacts: (data ?? []).map(({ tag_filter, seg_filter, ...c }: any) => ({
        ...c,
        tags: (c.contact_tags ?? []).map((l: any) => l.tags).filter(Boolean),
      })),
      total: count ?? 0,
      page,
      pageSize: PAGE_SIZE,
    }
  })
}

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<{
      phone: string
      name?: string
      email?: string
      company?: string
      country?: string
      city?: string
      locale?: string
      tag_ids?: string[]
    }>(request)

    const phone = sanitizePhone(body.phone)
    if (!isValidPhone(phone)) {
      badRequest('Enter a valid international phone number, e.g. +34 600 123 456')
    }

    // Same matcher the webhook uses — a "new" contact that already exists is merged.
    const contact = await findOrCreateContact(supabase, userId, phone, {
      name: body.name ?? null,
      email: body.email ?? null,
      country: body.country ?? null,
      city: body.city ?? null,
      locale: body.locale ?? null,
      source: 'manual',
    })

    if (!contact) badRequest('Could not save the contact')

    if (body.company) await supabase.from('contacts').update({ company: body.company }).eq('id', contact.id)

    for (const tagId of body.tag_ids ?? []) {
      await supabase
        .from('contact_tags')
        .upsert({ user_id: userId, contact_id: contact.id, tag_id: tagId }, { onConflict: 'contact_id,tag_id' })
    }

    const { data } = await supabase.from('contacts').select('*').eq('id', contact.id).single()
    return { contact: data, merged: !contact.created }
  })
}
