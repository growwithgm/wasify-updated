import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { findOrCreateContact } from '@/lib/contacts'
import { isValidPhone, sanitizePhone } from '@/lib/phone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Row = Record<string, string>

/**
 * CSV import.
 *
 * The old app inserted every row blind, so re-importing a list created a
 * duplicate contact for every phone. This routes through the SAME
 * findOrCreateContact matcher the webhook uses, so a re-import merges instead
 * — and the response reports created vs merged so the merchant can see it.
 */
export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<{
      rows: Row[]
      mapping: Record<string, string>
      tag_ids?: string[]
      filename?: string
    }>(request)

    const rows = body.rows ?? []
    if (!Array.isArray(rows) || rows.length === 0) badRequest('No rows to import')
    if (rows.length > 20000) badRequest('Import files are limited to 20,000 rows')

    const mapping = body.mapping ?? {}
    const phoneColumn = Object.entries(mapping).find(([, field]) => field === 'phone')?.[0]
    if (!phoneColumn) badRequest('Map one column to "phone" — it is the only required field')

    const { data: job } = await supabase
      .from('contact_imports')
      .insert({
        user_id: userId,
        filename: body.filename ?? 'contacts.csv',
        status: 'running',
        total_rows: rows.length,
        column_map: mapping,
        apply_tags: body.tag_ids ?? [],
      })
      .select('id')
      .single()

    let created = 0
    let merged = 0
    let skipped = 0
    const errors: Array<{ row: number; phone: string; reason: string }> = []

    // Tag names in the CSV are resolved once, not per row.
    const tagCache = new Map<string, string>()

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rawPhone = row[phoneColumn] ?? ''
      const phone = sanitizePhone(rawPhone)

      if (!isValidPhone(phone)) {
        skipped++
        if (errors.length < 100) {
          errors.push({
            row: i + 2, // +2: 1-indexed and the header line
            phone: rawPhone,
            reason: !phone
              ? 'Phone is empty'
              : phone[0] === '0'
                ? 'Missing country code (starts with 0)'
                : 'Not 7–15 digits',
          })
        }
        continue
      }

      const seed: Record<string, string | null> = {}
      for (const [column, field] of Object.entries(mapping)) {
        if (field === 'phone' || field === 'ignore' || field === 'tag') continue
        const value = (row[column] ?? '').trim()
        if (value) seed[field] = value
      }

      const contact = await findOrCreateContact(supabase, userId, phone, {
        ...seed,
        source: 'csv',
      } as any)

      if (!contact) {
        skipped++
        if (errors.length < 100) errors.push({ row: i + 2, phone: rawPhone, reason: 'Could not save' })
        continue
      }

      contact.created ? created++ : merged++

      /* ---- tags: the dialog's "tag all" plus any per-row tag column ---- */
      const tagIds = [...(body.tag_ids ?? [])]

      const tagColumn = Object.entries(mapping).find(([, field]) => field === 'tag')?.[0]
      const rowTag = tagColumn ? (row[tagColumn] ?? '').trim() : ''

      if (rowTag) {
        const key = rowTag.toLowerCase()
        if (!tagCache.has(key)) {
          const { data: existing } = await supabase
            .from('tags')
            .select('id')
            .eq('user_id', userId)
            .ilike('name', rowTag)
            .maybeSingle()

          if (existing) {
            tagCache.set(key, existing.id)
          } else {
            const { data: createdTag } = await supabase
              .from('tags')
              .insert({ user_id: userId, name: rowTag })
              .select('id')
              .single()
            if (createdTag) tagCache.set(key, createdTag.id)
          }
        }
        const id = tagCache.get(key)
        if (id) tagIds.push(id)
      }

      for (const tagId of tagIds) {
        await supabase
          .from('contact_tags')
          .upsert({ user_id: userId, contact_id: contact.id, tag_id: tagId }, { onConflict: 'contact_id,tag_id' })
      }
    }

    if (job) {
      await supabase
        .from('contact_imports')
        .update({
          status: 'done',
          imported_rows: created,
          merged_rows: merged,
          skipped_rows: skipped,
          errors,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)
    }

    return { ok: true, created, merged, skipped, errors, total: rows.length }
  })
}
