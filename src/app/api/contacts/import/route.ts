import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { findOrCreateContact } from '@/lib/contacts'
import { isValidPhone, sanitizePhone } from '@/lib/phone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Row = Record<string, string>

/** A mis-mapped column would otherwise mint one tag per row. */
const MAX_NEW_TAGS = 200

/**
 * Tag names for one row.
 *
 * Every column mapped to "tag" is read, not just the first, and a cell may
 * hold several names separated by a comma, semicolon or pipe — "VIP, Madrid"
 * is two tags, which is what anyone writing it meant. Duplicates within a row
 * collapse case-insensitively.
 */
export function rowTagNames(row: Row, tagColumns: string[]): string[] {
  const seen = new Map<string, string>()
  for (const column of tagColumns) {
    for (const part of (row[column] ?? '').split(/[,;|]/)) {
      const name = part.trim()
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name)
    }
  }
  return [...seen.values()]
}

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
    const tagColumns = Object.entries(mapping)
      .filter(([, field]) => field === 'tag')
      .map(([column]) => column)
    let tagOverflow = false

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

      for (const name of rowTagNames(row, tagColumns)) {
        const key = name.toLowerCase()

        if (!tagCache.has(key)) {
          // A cap, because a column mapped to "tag" by mistake — an order id,
          // a timestamp — would otherwise mint one tag per row. Better to
          // import the contacts and report the truncation than to bury the
          // real tags under 20,000 junk ones.
          if (tagCache.size >= MAX_NEW_TAGS) {
            tagOverflow = true
            break
          }

          // Not maybeSingle(): (user_id, name) is case-SENSITIVE unique, so
          // "vip" and "VIP" can both exist and an ilike would match two rows.
          const { data: existing } = await supabase
            .from('tags')
            .select('id')
            .eq('user_id', userId)
            .ilike('name', name)
            .limit(1)

          if (existing?.length) {
            tagCache.set(key, existing[0].id)
          } else {
            const { data: createdTag } = await supabase
              .from('tags')
              .insert({ user_id: userId, name })
              .select('id')
              .single()
            if (createdTag) tagCache.set(key, createdTag.id)
          }
        }

        const id = tagCache.get(key)
        if (id) tagIds.push(id)
      }

      for (const tagId of new Set(tagIds)) {
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

    return {
      ok: true,
      created,
      merged,
      skipped,
      errors,
      total: rows.length,
      tagsCreated: tagCache.size,
      // Never let a cap look like success — say it out loud.
      tagWarning: tagOverflow
        ? `Stopped after ${MAX_NEW_TAGS} distinct tags. Later rows were imported without their tag — ` +
          'check that the column you mapped to "Tag" really holds tag names.'
        : null,
    }
  })
}
