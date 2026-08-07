import { withAuth } from '@/lib/api'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The Stock alerts screen: who asked to be told, and what happened.
 *
 * stock_alerts is RLS-on-no-policy (public endpoints write it), so this reads
 * with the service client and MUST scope by user_id explicitly — the standing
 * rule for every service-role query in this repo.
 */
export async function GET(request: Request) {
  return withAuth(async ({ userId }) => {
    const url = new URL(request.url)
    const filter = url.searchParams.get('filter') ?? 'all'
    const page = Math.max(0, Number(url.searchParams.get('page') ?? 0))
    const size = 50

    const db = createServiceClient()

    const counted = async (status?: string) => {
      let q = db.from('stock_alerts').select('id', { count: 'exact', head: true }).eq('user_id', userId)
      if (status) q = q.eq('status', status)
      const { count } = await q
      return count ?? 0
    }

    let query = db
      .from('stock_alerts')
      .select(
        'id, product_title, variant_title, variant_id, product_url, name, phone, email, locale, status, clicked_at, notified_at, created_at',
        { count: 'exact' }
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (filter !== 'all') query = query.eq('status', filter)

    const [{ data: rows, count }, pending, sent, failed] = await Promise.all([
      query.range(page * size, page * size + size - 1),
      counted('pending'),
      counted('sent'),
      counted('failed'),
    ])

    return {
      total: count ?? 0,
      counts: { pending, sent, failed },
      alerts: rows ?? [],
    }
  })
}
