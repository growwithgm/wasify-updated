import { upsertShopifyCustomer } from './customers'

/**
 * Retry queue for the popup → Shopify customer push.
 *
 * The push runs INLINE at subscribe time (the merchant wanted the customer
 * in Shopify at that moment, not a week later); this queue only exists for
 * the failures — missing write_customers scope, Protected Customer Data
 * approval still pending, a network blip. The 15-minute tick drains a small
 * batch per run; five failed attempts park the row as `failed` with the
 * last error, visible in the table rather than silently gone. Wasify's own
 * contact is the source of truth throughout — Shopify is a copy.
 */
export const MAX_PUSH_ATTEMPTS = 5

export async function queueShopifyPush(
  db: any,
  row: { userId: string; shop: string; phone: string; name?: string | null; email?: string | null; tags: string[] }
): Promise<void> {
  const { error } = await db.from('shopify_push_queue').insert({
    user_id: row.userId,
    shop: row.shop,
    phone: row.phone,
    name: row.name ?? null,
    email: row.email ?? null,
    tags: row.tags,
  })
  if (error) console.error('[shopify-push] queue insert failed', error.message)
}

export async function retryShopifyPushQueue(db: any): Promise<{ pushed: number; failed: number }> {
  const { data: rows } = await db
    .from('shopify_push_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(10)

  let pushed = 0
  let failed = 0

  for (const row of rows ?? []) {
    const res = await upsertShopifyCustomer(row.shop, {
      email: row.email,
      phone: row.phone,
      name: row.name,
      tags: Array.isArray(row.tags) ? row.tags : [],
    })

    if (res.ok) {
      await db.from('shopify_push_queue').update({ status: 'done', last_error: null }).eq('id', row.id)
      pushed++
    } else {
      const attempts = (row.attempts ?? 0) + 1
      await db
        .from('shopify_push_queue')
        .update({
          attempts,
          last_error: res.error ?? 'unknown',
          status: attempts >= MAX_PUSH_ATTEMPTS ? 'failed' : 'pending',
        })
        .eq('id', row.id)
      failed++
    }
  }

  return { pushed, failed }
}
