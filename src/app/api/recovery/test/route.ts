import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { createServiceClient } from '@/lib/supabase/server'
import { getShopifyConfig } from '@/lib/shopify/admin'
import { sendReminder } from '@/lib/engines/recovery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Manual test bench for cart recovery.
 *
 * Waiting 45 minutes to find out a template is wrong is not a workflow. This
 * lists the recent abandoned checkouts and fires a chosen reminder at one of
 * them immediately.
 *
 * It sends exactly what the timer sends — same template resolution, same
 * variables, same cart link, same discount minting — so a pass here means the
 * real thing works. Two deliberate differences:
 *
 *   · the recovery row's counters are NOT advanced, so a test does not consume
 *     a reminder the customer should still receive
 *   · `recovery_enabled` is not required, so the setup can be proven before
 *     the switch is turned on
 *
 * What it does NOT bypass: a real WhatsApp message goes to a real customer.
 */

/** Recent checkouts worth testing against, newest first. */
export async function GET() {
  return withAuth(async ({ supabase }) => {
    const { data: checkouts } = await supabase
      .from('shopify_checkouts')
      .select(
        'id, shopify_checkout_id, customer_name, customer_phone, customer_locale, total_price, currency, items_count, completed_at, recovered, abandoned_checkout_url, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(25)

    const ids = (checkouts ?? []).map((c: any) => c.shopify_checkout_id)
    const { data: rows } = ids.length
      ? await supabase
          .from('checkout_recoveries')
          .select('shopify_checkout_id, status, reminders_sent, last_error, phone')
          .in('shopify_checkout_id', ids)
      : { data: [] as any[] }

    const byCheckout = new Map((rows ?? []).map((r: any) => [r.shopify_checkout_id, r]))

    return {
      checkouts: (checkouts ?? []).map((c: any) => {
        const row = byCheckout.get(c.shopify_checkout_id)
        const paid = !!(c.completed_at || c.recovered)
        return {
          id: c.shopify_checkout_id,
          name: c.customer_name,
          phone: c.customer_phone ?? row?.phone ?? null,
          locale: c.customer_locale,
          total: c.total_price,
          currency: c.currency,
          items: c.items_count,
          createdAt: c.created_at,
          hasCartLink: !!c.abandoned_checkout_url,
          recoveryStatus: row?.status ?? null,
          remindersSent: row?.reminders_sent ?? 0,
          lastError: row?.last_error ?? null,
          // Why this one cannot be tested, or null if it can.
          blocked: paid
            ? 'This checkout was completed — recovery never messages a paying customer'
            : !(c.customer_phone ?? row?.phone)
              ? 'No phone number on this checkout'
              : null,
        }
      }),
    }
  })
}

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const { checkout_id, stage } = await jsonBody<{ checkout_id: string; stage: number }>(request)

    if (!checkout_id) badRequest('Pick a checkout to test against')
    if (![1, 2, 3].includes(Number(stage))) badRequest('Reminder must be 1, 2 or 3')

    const config = await getShopifyConfig(userId)
    if (!config) badRequest('Connect Shopify first')

    const { data: checkout } = await supabase
      .from('shopify_checkouts')
      .select('*')
      .eq('shopify_checkout_id', checkout_id)
      .maybeSingle()

    if (!checkout) badRequest('That checkout is no longer in the mirror')

    // The one rule a test must not break: never message someone who paid.
    if (checkout!.completed_at || checkout!.recovered) {
      badRequest('That checkout was completed — recovery never messages a paying customer')
    }

    const { data: row } = await supabase
      .from('checkout_recoveries')
      .select('*')
      .eq('shopify_checkout_id', checkout_id)
      .maybeSingle()

    const phone = checkout!.customer_phone ?? row?.phone
    if (!phone) badRequest('This checkout has no phone number, so there is nobody to message')

    if (row?.status === 'opted_out') badRequest('That customer opted out of marketing')

    // Service role: sendReminder writes the mirrored thread message.
    const db = createServiceClient()
    const result = await sendReminder(
      db,
      userId,
      config,
      { ...(row ?? {}), contact_id: row?.contact_id ?? checkout!.contact_id, phone },
      checkout,
      Number(stage)
    )

    // Counters are deliberately left alone — see the note at the top.
    return {
      ok: result.ok,
      stage: Number(stage),
      phone,
      discountCode: result.discountCode ?? null,
      error: result.ok ? null : result.error,
    }
  })
}
