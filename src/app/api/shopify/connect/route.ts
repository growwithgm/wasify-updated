import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { SHOPIFY_SCOPES } from '@/lib/shopify/admin'
import { siteUrlStatus } from '@/lib/site-url'
import { randomToken } from '@/lib/crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Normalise whatever the merchant typed into a canonical *.myshopify.com host. */
export function normalizeShopDomain(input: string): string | null {
  let shop = (input ?? '').trim().toLowerCase()
  shop = shop.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!shop) return null
  if (!shop.includes('.')) shop = `${shop}.myshopify.com`
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null
}

/** Kick off the OAuth grant. Redirects the merchant to Shopify's consent screen. */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const shop = normalizeShopDomain(url.searchParams.get('shop') ?? '')

  if (!shop) {
    return NextResponse.json(
      { error: 'Provide a valid store, e.g. ?shop=my-store.myshopify.com' },
      { status: 400 }
    )
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID
  if (!clientId) {
    return NextResponse.json(
      { error: 'SHOPIFY_CLIENT_ID is not set. Copy it from your Shopify app’s Client credentials.' },
      { status: 500 }
    )
  }

  // Refuse to build a redirect_uri we already know Shopify will reject.
  // Sending it anyway produces "The redirect_uri is not whitelisted" on
  // Shopify's domain, which says nothing about which variable is wrong.
  const site = siteUrlStatus()
  if (!site.ok) {
    return NextResponse.json(
      {
        error: site.message,
        variable: 'NEXT_PUBLIC_SITE_URL',
        problem: site.problem,
        redirectUriShopifyWouldHaveSeen: site.value ? `${site.value}/api/shopify/callback` : null,
        alsoAdd:
          'Whatever you set here, the matching /api/shopify/callback URL must also be listed under ' +
          'Redirect URLs in the Shopify Partner Dashboard, and the version released.',
      },
      { status: 500 }
    )
  }
  const siteUrl = site.url

  // The merchant must already be signed in — the callback binds the store to them.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login?next=/integrations', siteUrl))

  const state = randomToken(16)
  const jar = await cookies()

  // CSRF: the callback must see the same state we issued, for the same user.
  jar.set('shopify_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })
  jar.set('shopify_oauth_user', user.id, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })

  const authorize = new URL(`https://${shop}/admin/oauth/authorize`)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('scope', SHOPIFY_SCOPES.join(','))
  authorize.searchParams.set('redirect_uri', `${siteUrl}/api/shopify/callback`)
  authorize.searchParams.set('state', state)

  return NextResponse.redirect(authorize.toString())
}
