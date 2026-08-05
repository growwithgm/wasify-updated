import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidCode } from '@/lib/flow/order-confirmation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The order-confirmation button's destination: /o/<code> → 302 to the order
 * status page. Public — the customer clicking it has no session.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params

  // Shape-check before touching the database: the alphabet has no lookalikes,
  // so anything else is noise or probing, not a mistyped code.
  if (!isValidCode(code)) return new NextResponse('Not found', { status: 404 })

  const db = createServiceClient()
  const { data } = await db.from('order_links').select('status_url').eq('code', code).maybeSingle()

  if (!data?.status_url) return new NextResponse('Not found', { status: 404 })

  // Fire-and-forget on purpose: the customer is owed a redirect, not a wait
  // on analytics. `.then(noop)` starts the PostgREST request without await.
  void db
    .from('order_links')
    .update({ clicked_at: new Date().toISOString() })
    .eq('code', code)
    .is('clicked_at', null) // first click wins; repeat clicks keep the original
    .then(
      () => {},
      (e: unknown) => console.error('[order-link] click stamp failed', e)
    )

  return NextResponse.redirect(data.status_url, 302)
}
