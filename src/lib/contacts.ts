import type { SupabaseClient } from '@supabase/supabase-js'
import { phonesMatch, sanitizePhone, isValidPhone } from '@/lib/phone'

/**
 * THE contact/conversation dedupe path.
 *
 * The webhook, new-chat, CSV import, COD replies and cart recovery all call
 * these two functions. If any caller rolls its own matching, threads split
 * and a customer ends up with two half-conversations — that was the single
 * most expensive bug in the previous app.
 */

type DB = SupabaseClient<any, any, any>

/**
 * Find a contact whose phone matches under phonesMatch(), or create one.
 * Narrows candidates with a last-8-digit index hit, then applies the full
 * matcher in JS so the two definitions can never disagree.
 */
export async function findOrCreateContact(
  db: DB,
  userId: string,
  phone: string,
  seed: {
    name?: string | null
    email?: string | null
    locale?: string | null
    country?: string | null
    city?: string | null
    source?: string | null
    shopify_customer_id?: string | null
  } = {}
): Promise<{ id: string; created: boolean; phone: string } | null> {
  const digits = sanitizePhone(phone)
  if (!isValidPhone(digits)) return null

  const tail = digits.slice(-8)
  const { data: candidates } = await db
    .from('contacts')
    .select('id, phone, name, email, locale, country, city, shopify_customer_id')
    .eq('user_id', userId)
    .like('phone', `%${tail}`)
    .limit(50)

  const hit = (candidates ?? []).find((c: any) => phonesMatch(c.phone, digits))

  if (hit) {
    // Backfill only the fields we still don't know — never overwrite good data.
    const patch: Record<string, unknown> = {}
    if (!hit.name && seed.name) patch.name = seed.name
    if (!hit.email && seed.email) patch.email = seed.email
    if (!hit.locale && seed.locale) patch.locale = seed.locale
    if (!hit.country && seed.country) patch.country = seed.country
    if (!hit.city && seed.city) patch.city = seed.city
    if (!hit.shopify_customer_id && seed.shopify_customer_id) {
      patch.shopify_customer_id = seed.shopify_customer_id
    }
    if (Object.keys(patch).length) await db.from('contacts').update(patch).eq('id', hit.id)
    return { id: hit.id, created: false, phone: hit.phone }
  }

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      user_id: userId,
      phone: digits,
      name: seed.name ?? null,
      email: seed.email ?? null,
      locale: seed.locale ?? null,
      country: seed.country ?? null,
      city: seed.city ?? null,
      source: seed.source ?? 'whatsapp',
      shopify_customer_id: seed.shopify_customer_id ?? null,
    })
    .select('id, phone')
    .single()

  if (error || !created) return null
  return { id: created.id, created: true, phone: created.phone }
}

/** One conversation per (tenant, contact) — enforced by a DB unique index too. */
export async function findOrCreateConversation(
  db: DB,
  userId: string,
  contactId: string
): Promise<string | null> {
  const { data: existing } = await db
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) return existing.id

  const { data: created, error } = await db
    .from('conversations')
    .insert({ user_id: userId, contact_id: contactId, status: 'open' })
    .select('id')
    .single()

  if (error) {
    // Lost a race with a concurrent webhook — re-read the winner's row.
    const { data: retry } = await db
      .from('conversations')
      .select('id')
      .eq('user_id', userId)
      .eq('contact_id', contactId)
      .maybeSingle()
    return retry?.id ?? null
  }

  return created?.id ?? null
}

/**
 * Update the conversation summary after a message lands.
 * last_inbound_at moves ONLY for inbound — that anchors the 24h window.
 */
export async function bumpConversation(
  db: DB,
  conversationId: string,
  opts: { text: string; at: string; inbound: boolean; incrementUnread?: boolean }
) {
  const patch: Record<string, unknown> = {
    last_message_text: opts.text.slice(0, 500),
    last_message_at: opts.at,
  }

  if (opts.inbound) {
    patch.last_inbound_at = opts.at
    if (opts.incrementUnread !== false) {
      const { data } = await db
        .from('conversations')
        .select('unread_count')
        .eq('id', conversationId)
        .maybeSingle()
      patch.unread_count = (data?.unread_count ?? 0) + 1
    }
    // A customer writing in re-opens a closed thread.
    patch.status = 'open'
  }

  await db.from('conversations').update(patch).eq('id', conversationId)
}

/** Is this number on the suppression list (hard opt-out)? */
export async function isSuppressed(db: DB, userId: string, phone: string): Promise<boolean> {
  const digits = sanitizePhone(phone)
  if (!digits) return false
  const { data } = await db
    .from('suppression_list')
    .select('phone')
    .eq('user_id', userId)
    .like('phone', `%${digits.slice(-8)}`)
    .limit(20)
  return (data ?? []).some((r: any) => phonesMatch(r.phone, digits))
}

/** Log an activity-feed entry. Never throws — the feed is not load-bearing. */
export async function logActivity(
  db: DB,
  userId: string,
  entry: { kind: string; title: string; detail?: string; contactId?: string; amount?: number }
) {
  try {
    await db.from('activity_events').insert({
      user_id: userId,
      kind: entry.kind,
      title: entry.title,
      detail: entry.detail ?? null,
      contact_id: entry.contactId ?? null,
      amount: entry.amount ?? null,
    })
  } catch {
    /* non-critical */
  }
}

/** Push a bell notification. Also non-critical. */
export async function notify(
  db: DB,
  userId: string,
  kind: 'info' | 'success' | 'warning' | 'error',
  text: string,
  link?: string
) {
  try {
    await db.from('notifications').insert({ user_id: userId, kind, text, link: link ?? null })
  } catch {
    /* non-critical */
  }
}
