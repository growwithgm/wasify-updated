/**
 * Data retention — batched, and hard-fenced.
 *
 * The measured reality (Sept 2026): shopify_webhook_events.payload was 21 MB
 * against 771 kB of checkout raw and 6 kB of WhatsApp payloads — every
 * webhook delivery stores its FULL payload and checkouts/update fires many
 * times per checkout. So retention is narrow: payloads go first (24h after
 * processing), log rows at 7 days, popup impressions at 30 — and nothing
 * else is touched.
 *
 * THE FENCE: consent_events, contacts and suppression_list can NEVER be
 * pruned. Consent proof, the opt-in state the recovery gate stands on, and
 * the STOP list — deleting any of them either blocks a consented customer
 * or, far worse, messages someone who said stop. The allow-list below is
 * the only door, and the tests pin it shut.
 */

/** The ONLY tables retention may delete from. */
const PRUNABLE = new Set(['shopify_webhook_events', 'whatsapp_webhook_events', 'popup_events'])

/**
 * Delete rows older than `cutoffIso`, in batches of `batch` ids per
 * statement (a .in() list of UUIDs rides in the request URL — 100 stays
 * well under every limit), at most `maxLoops` batches per run. A backlog
 * larger than batch×maxLoops simply drains over the following runs — one
 * giant DELETE on the free tier is exactly what this avoids.
 */
export async function pruneOldRows(
  db: any,
  table: string,
  cutoffIso: string,
  opts: { batch?: number; maxLoops?: number } = {}
): Promise<number> {
  if (!PRUNABLE.has(table)) {
    throw new Error(`Refusing to prune "${table}" — it is not on the retention allow-list`)
  }

  const batch = opts.batch ?? 100
  const maxLoops = opts.maxLoops ?? 50
  let removed = 0

  for (let i = 0; i < maxLoops; i++) {
    const { data: rows, error } = await db
      .from(table)
      .select('id')
      .lt('created_at', cutoffIso)
      .order('created_at', { ascending: true })
      .limit(batch)
    if (error) throw new Error(`${table} prune select: ${error.message}`)
    if (!rows?.length) break

    const { error: delError } = await db
      .from(table)
      .delete()
      .in('id', rows.map((r: any) => r.id))
    if (delError) throw new Error(`${table} prune delete: ${delError.message}`)

    removed += rows.length
    if (rows.length < batch) break
  }

  return removed
}

/**
 * The payload-first half for shopify_webhook_events: 24 hours after a
 * delivery is processed (or ignored), its payload — the heavy part — is
 * nulled while the log row itself lives on until the 7-day delete. Failed
 * deliveries KEEP their payload for the full week: it is the only evidence
 * for debugging them.
 */
export async function nullProcessedWebhookPayloads(
  db: any,
  cutoffIso: string,
  opts: { batch?: number; maxLoops?: number } = {}
): Promise<number> {
  const batch = opts.batch ?? 100
  const maxLoops = opts.maxLoops ?? 50
  let cleared = 0

  for (let i = 0; i < maxLoops; i++) {
    const { data: rows, error } = await db
      .from('shopify_webhook_events')
      .select('id')
      .lt('created_at', cutoffIso)
      .in('status', ['processed', 'ignored'])
      .not('payload', 'is', null)
      .order('created_at', { ascending: true })
      .limit(batch)
    if (error) throw new Error(`payload-null select: ${error.message}`)
    if (!rows?.length) break

    const { error: updError } = await db
      .from('shopify_webhook_events')
      .update({ payload: null })
      .in('id', rows.map((r: any) => r.id))
    if (updError) throw new Error(`payload-null update: ${updError.message}`)

    cleared += rows.length
    if (rows.length < batch) break
  }

  return cleared
}
