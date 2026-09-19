import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { normalizeShopDomain } from '@/app/api/shopify/connect/route'
import { verifyProxySignature } from '@/lib/flow/stock-alerts'
import { popupBlockReason, popupPublicConfig, pageAllowed, deviceAllowed } from '@/lib/engines/popup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Popup config, fetched by the theme extension on page load through the
 * Shopify App Proxy (signed request — same verification as the BIS proxy).
 *
 * Targeting is decided HERE, all of it: page rules (with the locale-prefix
 * strip for multi-market stores), device (from this request's user-agent),
 * and — when Shopify tells us who is logged in — whether this customer
 * already opted in, in which case there is nothing to ask. The client's
 * only pre-condition is the Customer Privacy check, which by nature lives
 * in the browser.
 *
 * A popup that cannot run answers a bare {enabled:false} — the WHY is
 * admin-only (popupBlockReason), never leaked to the storefront.
 */
export async function GET(request: Request) {
  const secret = process.env.SHOPIFY_PROXY_SECRET || process.env.SHOPIFY_CLIENT_SECRET
  if (!secret) return new NextResponse('Proxy secret is not configured', { status: 503 })

  const url = new URL(request.url)
  if (!verifyProxySignature(url.searchParams, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const shop = normalizeShopDomain(url.searchParams.get('shop') ?? '')
  const path = url.searchParams.get('path') ?? '/'
  if (!shop) return NextResponse.json({ error: 'shop is required' }, { status: 400 })

  const db = createServiceClient()
  const { data: config } = await db
    .from('shopify_config')
    .select(
      'user_id, popup_enabled, popup_include_paths, popup_exclude_paths, popup_strip_locale, popup_heading, popup_subheading, popup_button_text, popup_success_text, popup_consent_text, popup_disclaimer, popup_trigger_exit, popup_trigger_delay, popup_trigger_delay_seconds, popup_trigger_scroll, popup_trigger_scroll_pct, popup_trigger_all, popup_dismiss_days, popup_teaser_enabled, popup_teaser_text, popup_teaser_position, popup_devices, popup_discount_id, popup_template'
    )
    .eq('store_domain', shop)
    .maybeSingle()

  if (!config || popupBlockReason(config)) {
    return NextResponse.json({ enabled: false, show: false })
  }

  if (
    !pageAllowed(path, config.popup_include_paths, config.popup_exclude_paths, {
      stripLocale: config.popup_strip_locale ?? true,
    })
  ) {
    return NextResponse.json({ enabled: true, show: false })
  }

  if (!deviceAllowed(config.popup_devices, request.headers.get('user-agent'))) {
    return NextResponse.json({ enabled: true, show: false })
  }

  // App Proxy appends logged_in_customer_id (signed) when the visitor has a
  // Shopify account session. If we KNOW this customer and they are already
  // opted in, there is nothing to ask. No id → no lookup, no guessing.
  const customerId = (url.searchParams.get('logged_in_customer_id') ?? '').trim()
  if (customerId) {
    const { data: contact } = await db
      .from('contacts')
      .select('opt_in_status')
      .eq('user_id', config.user_id)
      .eq('shopify_customer_id', customerId)
      .maybeSingle()
    if (contact?.opt_in_status === 'opted_in') {
      return NextResponse.json({ enabled: true, show: false })
    }
  }

  let discount: any = null
  if (config.popup_discount_id) {
    const { data } = await db
      .from('discounts')
      .select('discount_type, percentage, amount, currency, enabled')
      .eq('id', config.popup_discount_id)
      .eq('user_id', config.user_id)
      .maybeSingle()
    if (data?.enabled) discount = data
  }

  // Impression = the popup WILL auto-render on this page view. A dismissed
  // visitor's page loads come in as mode=teaser — only the little tab shows,
  // so they must not count as popup impressions.
  if (url.searchParams.get('mode') !== 'teaser') {
    const { error: statError } = await db
      .from('popup_events')
      .insert({ user_id: config.user_id, event: 'impression', path })
    if (statError) console.error('[popup] impression log failed', statError.message)
  }

  return NextResponse.json(
    { enabled: true, show: true, ...popupPublicConfig(config, discount) },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
