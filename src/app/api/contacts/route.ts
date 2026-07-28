import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { findOrCreateContact } from '@/lib/contacts'
import { isValidPhone, sanitizePhone } from '@/lib/phone'
import { previewDefinition } from '@/lib/engines/segments'
import type { SegmentDefinition } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

export async function GET(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim()
    const page = Math.max(0, Number(url.searchParams.get('page') ?? 0))
    const segmentId = url.searchParams.get('segment')
    const tagId = url.searchParams.get('tag')
    const sort = url.searchParams.get('sort') ?? 'created_at'
    const dir = url.searchParams.get('dir') === 'asc'

    let ids: string[] | null = null

    if (segmentId) {
      const { data } = await supabase
        .from('segment_members')
        .select('contact_id')
        .eq('segment_id', segmentId)
      ids = (data ?? []).map((r: any) => r.contact_id)
      if (!ids.length) return { contacts: [], total: 0, page, pageSize: PAGE_SIZE }
    }

    if (tagId) {
      const { data } = await supabase.from('contact_tags').select('contact_id').eq('tag_id', tagId)
      const tagged = (data ?? []).map((r: any) => r.contact_id)
      ids = ids ? ids.filter((id) => tagged.includes(id)) : tagged
      if (!ids.length) return { contacts: [], total: 0, page, pageSize: PAGE_SIZE }
    }

    let query = supabase
      .from('contacts')
      .select('*, contact_tags(tag_id, tags:tag_id (id, name, color))', { count: 'exact' })
      .order(sort, { ascending: dir })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

    if (ids) query = query.in('id', ids)

    if (q) {
      const digits = sanitizePhone(q)
      const clauses = [`name.ilike.%${q}%`, `email.ilike.%${q}%`, `company.ilike.%${q}%`]
      if (digits.length >= 3) clauses.push(`phone.ilike.%${digits}%`)
      query = query.or(clauses.join(','))
    }

    const { data, error, count } = await query
    if (error) badRequest(error.message)

    return {
      contacts: (data ?? []).map((c: any) => ({
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
