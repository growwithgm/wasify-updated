import { withAuth, jsonBody, badRequest } from '@/lib/api'
import {
  prepareRows,
  phoneIndex,
  phoneKey,
  backfillPatch,
  chunk,
  type ImportRow,
  type RowError,
  type PreparedRow,
} from '@/lib/contacts-import'
import { sanitizePhone } from '@/lib/phone'

export { rowTagNames } from '@/lib/contacts-import'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** A mis-mapped column would otherwise mint one tag per row. */
const MAX_NEW_TAGS = 200

/** Rows per set-based database statement. */
const DB_BATCH = 500

/**
 * CSV import, one request per slice of the file.
 *
 * The browser sends the file in slices (job_id ties them together; the last
 * one carries final=true) and each slice is processed in BULK: one indexed
 * lookup for existing phones, one insert for all new contacts, one upsert
 * for all tag links. The old version paid three sequential round trips per
 * row and died mid-file past ~4,000 rows; this pays a handful per 500.
 *
 * Merging still routes through the same identity rule the webhook uses
 * (exact digits, or matching last-8), so a re-import merges instead of
 * duplicating — and the response reports created vs merged so the merchant
 * can see it.
 */
export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<{
      rows: ImportRow[]
      mapping: Record<string, string>
      tag_ids?: string[]
      filename?: string
      job_id?: string
      row_offset?: number
      total_rows?: number
      final?: boolean
    }>(request)

    const rows = body.rows ?? []
    if (!Array.isArray(rows) || rows.length === 0) badRequest('No rows to import')
    if (rows.length > 5000) badRequest('Send the file in slices of at most 5,000 rows')

    const mapping = body.mapping ?? {}
    if (!Object.values(mapping).includes('phone')) {
      badRequest('Map one column to "phone" — it is the only required field')
    }

    const rowOffset = Math.max(0, Number(body.row_offset ?? 0))
    const final = body.final !== false

    /* ---- the import job row: created by the first slice, shared after ---- */
    let jobId = body.job_id ?? null
    if (!jobId) {
      const { data: job } = await supabase
        .from('contact_imports')
        .insert({
          user_id: userId,
          filename: body.filename ?? 'contacts.csv',
          status: 'running',
          total_rows: body.total_rows ?? rows.length,
          column_map: mapping,
          apply_tags: body.tag_ids ?? [],
        })
        .select('id')
        .single()
      jobId = job?.id ?? null
    }

    /* ---- validate + collapse in memory before the database sees anything ---- */
    const { prepared, errors, duplicates } = prepareRows(rows, mapping, rowOffset)

    let created = 0
    let merged = duplicates // rows that collapsed into another row of the same file
    let skipped = errors.length

    /* ---- resolve the file's tag names once per slice, not per row ---- */
    const dialogTagIds = (body.tag_ids ?? []).filter(Boolean)
    const distinctNames = new Map<string, string>()
    for (const p of prepared) {
      for (const name of p.tagNames) {
        if (!distinctNames.has(name.toLowerCase())) distinctNames.set(name.toLowerCase(), name)
      }
    }

    let tagOverflow = false
    let tagsCreated = 0
    const tagIdByName = new Map<string, string>()

    if (distinctNames.size) {
      // The tags table is merchant-scale small — read it whole in one query
      // rather than probing per name.
      const { data: existingTags, error: tagReadError } = await supabase
        .from('tags')
        .select('id, name')
        .eq('user_id', userId)
      if (tagReadError) badRequest(`Could not read tags: ${tagReadError.message}`)
      for (const t of existingTags ?? []) tagIdByName.set(String(t.name).toLowerCase(), t.id)

      let toCreate = [...distinctNames.values()].filter((n) => !tagIdByName.has(n.toLowerCase()))
      if (toCreate.length > MAX_NEW_TAGS) {
        // A cap, because a column mapped to "tag" by mistake — an order id,
        // a timestamp — would otherwise mint one tag per row. Better to
        // import the contacts and report the truncation than to bury the
        // real tags under thousands of junk ones.
        tagOverflow = true
        toCreate = toCreate.slice(0, MAX_NEW_TAGS)
      }

      for (const batch of chunk(toCreate, DB_BATCH)) {
        const { data: createdTags, error } = await supabase
          .from('tags')
          .insert(batch.map((name) => ({ user_id: userId, name })))
          .select('id, name')
        if (error) {
          // Likely a name landed concurrently; re-read and carry on with
          // whatever exists rather than failing the slice over labels.
          const { data: again } = await supabase.from('tags').select('id, name').eq('user_id', userId)
          for (const t of again ?? []) tagIdByName.set(String(t.name).toLowerCase(), t.id)
          continue
        }
        for (const t of createdTags ?? []) {
          tagIdByName.set(String(t.name).toLowerCase(), t.id)
          tagsCreated++
        }
      }
    }

    /* ---- contacts, in set-based batches ---- */
    const contactIdByKey = new Map<string, string>()

    for (const batch of prepared.length ? chunk(prepared, DB_BATCH) : []) {
      const candidates: Array<{ id: string; phone: string } & Record<string, any>> = []

      // Pass 1 — exact phone matches, a few hundred per indexed query.
      for (const part of chunk(batch.map((p) => p.digits), 200)) {
        const { data, error } = await supabase
          .from('contacts')
          .select('id, phone, name, email, company, locale, country, city, postcode')
          .eq('user_id', userId)
          .in('phone', part)
        if (error) badRequest(`Lookup failed: ${error.message}`)
        candidates.push(...(data ?? []))
      }

      // Pass 2 — last-8 matches for what pass 1 missed, so "600111222" still
      // finds the stored "34600111222". Same rule as phonesMatch.
      let index = phoneIndex(candidates)
      const unmatchedTails = [
        ...new Set(
          batch
            .filter((p) => !index.has(p.key) && p.digits.length >= 8)
            .map((p) => p.digits.slice(-8))
        ),
      ]
      for (const part of chunk(unmatchedTails, 50)) {
        const { data, error } = await supabase
          .from('contacts')
          .select('id, phone, name, email, company, locale, country, city, postcode')
          .eq('user_id', userId)
          .or(part.map((tail) => `phone.like.%${tail}`).join(','))
          .limit(1000)
        if (error) badRequest(`Lookup failed: ${error.message}`)
        candidates.push(...(data ?? []))
      }
      index = phoneIndex(candidates)

      const toInsert: PreparedRow[] = []
      const toMerge: Array<{ p: PreparedRow; hit: Record<string, any> }> = []
      for (const p of batch) {
        const hit = index.get(p.key)
        hit ? toMerge.push({ p, hit }) : toInsert.push(p)
      }

      // New contacts: one insert per batch. If the whole statement fails,
      // bisect so a single bad row costs itself, not its 499 neighbours.
      const insertFailures = await bulkInsert(supabase, userId, toInsert, contactIdByKey)
      created += toInsert.length - insertFailures.length
      skipped += insertFailures.length
      errors.push(...insertFailures)

      // Existing contacts: backfill only missing fields — usually nothing on
      // a re-import, so this loop mostly issues zero statements.
      const patches = toMerge
        .map(({ p, hit }) => ({ id: hit.id as string, patch: backfillPatch(hit, p.seed) }))
        .filter((u) => Object.keys(u.patch).length > 0)
      for (const wave of chunk(patches, 20)) {
        await Promise.all(
          wave.map((u) => supabase.from('contacts').update(u.patch).eq('id', u.id))
        )
      }
      for (const { p, hit } of toMerge) {
        contactIdByKey.set(p.key, hit.id)
        merged++
      }
    }

    /* ---- tag links: one upsert for the whole slice ---- */
    const links: Array<{ user_id: string; contact_id: string; tag_id: string }> = []
    const linkSeen = new Set<string>()
    for (const p of prepared) {
      const contactId = contactIdByKey.get(p.key)
      if (!contactId) continue
      const tagIds = [
        ...dialogTagIds,
        ...p.tagNames
          .map((name) => tagIdByName.get(name.toLowerCase()))
          .filter((id): id is string => Boolean(id)),
      ]
      for (const tagId of tagIds) {
        const dedupe = `${contactId}:${tagId}`
        if (linkSeen.has(dedupe)) continue
        linkSeen.add(dedupe)
        links.push({ user_id: userId, contact_id: contactId, tag_id: tagId })
      }
    }
    for (const batch of chunk(links, 1000)) {
      const { error } = await supabase
        .from('contact_tags')
        .upsert(batch, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
      if (error) console.error('[import] tag links failed', error.message)
    }

    /* ---- roll this slice's counts into the job row ---- */
    if (jobId) {
      const { data: job } = await supabase
        .from('contact_imports')
        .select('imported_rows, merged_rows, skipped_rows, errors')
        .eq('id', jobId)
        .maybeSingle()
      const priorErrors = Array.isArray(job?.errors) ? job.errors : []
      await supabase
        .from('contact_imports')
        .update({
          imported_rows: (job?.imported_rows ?? 0) + created,
          merged_rows: (job?.merged_rows ?? 0) + merged,
          skipped_rows: (job?.skipped_rows ?? 0) + skipped,
          errors: [...priorErrors, ...errors].slice(0, 100),
          ...(final ? { status: 'done', completed_at: new Date().toISOString() } : {}),
        })
        .eq('id', jobId)
    }

    return {
      ok: true,
      job_id: jobId,
      created,
      merged,
      skipped,
      errors: errors.slice(0, 100),
      total: rows.length,
      tagsCreated,
      // Never let a cap look like success — say it out loud.
      tagWarning: tagOverflow
        ? `Stopped after ${MAX_NEW_TAGS} new tags. Later rows were imported without their tag — ` +
          'check that the column you mapped to "Tag" really holds tag names.'
        : null,
    }
  })
}

/**
 * Insert a batch of new contacts in one statement, recording ids by phone
 * key. PostgREST inserts are all-or-nothing, so on failure the batch splits
 * in half and recurses — log2(500) levels at worst — until the bad row is
 * alone and only it is reported.
 */
async function bulkInsert(
  supabase: any,
  userId: string,
  batch: PreparedRow[],
  contactIdByKey: Map<string, string>
): Promise<RowError[]> {
  if (!batch.length) return []

  const { data, error } = await supabase
    .from('contacts')
    .insert(
      batch.map((p) => ({
        user_id: userId,
        phone: p.digits,
        source: 'csv',
        ...p.seed,
      }))
    )
    .select('id, phone')

  if (!error) {
    for (const c of data ?? []) contactIdByKey.set(phoneKey(sanitizePhone(c.phone)), c.id)
    return []
  }

  if (batch.length === 1) {
    return [{ row: batch[0].rowNumber, phone: batch[0].digits, reason: error.message ?? 'Could not save' }]
  }

  const mid = Math.ceil(batch.length / 2)
  return [
    ...(await bulkInsert(supabase, userId, batch.slice(0, mid), contactIdByKey)),
    ...(await bulkInsert(supabase, userId, batch.slice(mid), contactIdByKey)),
  ]
}
