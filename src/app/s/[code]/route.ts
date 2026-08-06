import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidCode } from '@/lib/flow/order-confirmation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Back-in-stock button destination: /s/<code> → 302 to the product page.
 * Public, and the /o/[code] pattern exactly — the customer is owed a
 * redirect, not a wait on analytics.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params

  if (!isValidCode(code)) return new NextResponse('Not found', { status: 404 })

  const db = createServiceClient()
  const { data } = await db.from('stock_alerts').select('product_url').eq('short_code', code).maybeSingle()

  if (!data?.product_url) return new NextResponse('Not found', { status: 404 })

  void db
    .from('stock_alerts')
    .update({ clicked_at: new Date().toISOString() })
    .eq('short_code', code)
    .is('clicked_at', null) // first click wins
    .then(
      () => {},
      (e: unknown) => console.error('[stock-link] click stamp failed', e)
    )

  return NextResponse.redirect(data.product_url, 302)
}
