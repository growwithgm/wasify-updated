import { withAuth } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The Abandoned Carts screen.
 *
 * Two tables answer two different questions and must not be confused:
 *
 *   shopify_checkouts   — what SHOPIFY says. Conversion truth lives here.
 *   checkout_recoveries — what WE did about it. Progress, never conversion.
 *
 * So `recovered` is read strictly from the checkout. A tracking row that says
 * "done" only means three reminders went out; treating that as a recovery
 * would invent revenue that never happened.
 */
export async function GET(request: Request) {
  return withAuth(async ({ supabase }) => {
    const url = new URL(request.url)
    const filter = url.searchParams.get('filter') ?? 'all'
    const page = Math.max(0, Number(url.searchParams.get('page') ?? 0))
    const size = 50

    let query = supabase
      .from('shopify_checkouts')
      .select(
        'id, shopify_checkout_id, customer_name, customer_phone, customer_email, total_price, currency, items_count, line_items, abandoned_checkout_url, completed_at, recovered, abandoned_at, created_at, contact_id',
        { count: 'exact' }
      )
      // When the CART was abandoned, not when the row was inserted — a
      // backfill writes old carts last, and insert-order put three-week-old
      // carts above ones from this afternoon.
      .order('abandoned_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })

    if (filter === 'open') query = query.is('completed_at', null).eq('recovered', false)
    if (filter === 'recovered') query = query.not('completed_at', 'is', null)

    const { data: checkouts, count } = await query.range(page * size, page * size + size - 1)

    const ids = (checkouts ?? []).map((c: any) => c.shopify_checkout_id)
    const { data: rows } = ids.length
      ? await supabase
          .from('checkout_recoveries')
          .select(
            'shopify_checkout_id, status, reminders_sent, reminder1_sent_at, reminder2_sent_at, reminder3_sent_at, discount_code, last_error, contact_id, conversation_id'
          )
          .in('shopify_checkout_id', ids)
      : { data: [] as any[] }

    const byCheckout = new Map((rows ?? []).map((r: any) => [r.shopify_checkout_id, r]))

    return {
      total: count ?? 0,
      carts: (checkouts ?? []).map((c: any) => {
        const row = byCheckout.get(c.shopify_checkout_id)
        return {
          ...c,
          // Conversion: the checkout's own truth, never the tracking row.
          isRecovered: !!(c.completed_at || c.recovered),
          recovery: row
            ? {
                status: row.status,
                remindersSent: row.reminders_sent ?? 0,
                lastSentAt: row.reminder3_sent_at ?? row.reminder2_sent_at ?? row.reminder1_sent_at ?? null,
                discountCode: row.discount_code,
                lastError: row.last_error,
                conversationId: row.conversation_id,
                contactId: row.contact_id,
              }
            : null,
        }
      }),
    }
  })
}
