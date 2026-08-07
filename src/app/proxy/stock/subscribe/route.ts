import { NextResponse } from 'next/server'
import { processSubscribe, type SubscribeBody } from '@/app/api/stock/subscribe/route'
import { verifyProxySignature } from '@/lib/flow/stock-alerts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Shopify App Proxy entry for the back-in-stock signup.
 *
 * With the proxy configured (subpath prefix `apps`, subpath `wasify`, proxy
 * URL `https://<app>/proxy`), the widget POSTs to
 * `https://ibban.com/apps/wasify/stock/subscribe` — same-origin, so the CORS
 * question disappears — and Shopify forwards it here as
 * `/proxy/stock/subscribe` with a `signature` query parameter.
 *
 * That signature is HMAC'd with the API secret of the app THE PROXY IS
 * CONFIGURED ON. If that is ibBan's own custom app rather than this one, set
 * SHOPIFY_PROXY_SECRET to that app's secret; otherwise SHOPIFY_CLIENT_SECRET
 * is used. Verification is fail-closed, like every other signed entry point.
 */
export async function POST(request: Request) {
  const secret = process.env.SHOPIFY_PROXY_SECRET || process.env.SHOPIFY_CLIENT_SECRET
  if (!secret) {
    console.error('[stock-proxy] no proxy secret configured — refusing all traffic')
    return new NextResponse('App proxy secret is not configured', { status: 503 })
  }

  const url = new URL(request.url)
  if (!verifyProxySignature(url.searchParams, secret)) {
    return NextResponse.json(
      {
        error: 'Invalid app proxy signature',
        hint: 'The proxy signature is HMAC-SHA256 with the API secret of the app the proxy is configured on — set SHOPIFY_PROXY_SECRET if that is not this app.',
      },
      { status: 401 }
    )
  }

  let body: SubscribeBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // The signed `shop` parameter outranks whatever the body claims — Shopify
  // put it there, the browser could have put anything in the body.
  const signedShop = url.searchParams.get('shop')
  if (signedShop) body.shop = signedShop

  // Shopify forwards the customer's IP in X-Forwarded-For.
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'

  const result = await processSubscribe(body, ip)
  return NextResponse.json(result.payload, { status: result.status })
}
