import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { SHOPIFY_SCOPES } from '@/lib/shopify/admin'
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
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  if (!clientId || !siteUrl) {
    return NextResponse.json(
      { error: 'SHOPIFY_CLIENT_ID and NEXT_PUBLIC_SITE_URL must be set' },
      { status: 500 }
    )
  }

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
