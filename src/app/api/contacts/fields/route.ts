import { withAuth } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * How many contacts actually hold a value per personalisation field.
 *
 * The broadcast wizard offered Email, City, Country … regardless of whether a
 * single contact had them — pick one that's empty everywhere and every
 * recipient fails. These counts let the wizard offer only fields that exist.
 * Head-only count queries: no rows travel, just numbers.
 */
const TEXT_FIELDS = ['name', 'email', 'city', 'country'] as const

export async function GET() {
  return withAuth(async ({ supabase, userId }) => {
    const counts: Record<string, number> = {}

    await Promise.all([
      ...TEXT_FIELDS.map(async (field) => {
        const { count } = await supabase
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .not(field, 'is', null)
          .neq(field, '')
        counts[field] = count ?? 0
      }),
      (async () => {
        // Spend/order fields only mean something for contacts who have bought.
        const { count } = await supabase
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .gt('orders_count', 0)
        counts.orders_count = count ?? 0
        counts.lifetime_spent = count ?? 0
      })(),
    ])

    // First name is derived from name, so it exists exactly as often.
    counts.first_name = counts.name

    return { fields: counts }
  })
}
