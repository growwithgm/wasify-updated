import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { encrypt, safeEqual } from '@/lib/crypto'
import { adminGraphql, SHOPIFY_SCOPES } from '@/lib/shopify/admin'
import { normalizeShopDomain } from '../connect/route'
import { registerShopifyWebhooks } from '@/lib/shopify/webhooks'
import { canPersistTokens } from '@/lib/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * OAuth callback. Order matters:
 *   1. state cookie (CSRF)
 *   2. HMAC over the query string (proves Shopify sent it)
 *   3. token exchange
 *   4. live shop query (proves the token actually works)
 *   5. persist encrypted + register webhooks
 */
export async function GET(request: Request) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin
  const fail = (reason: string) =>
    NextResponse.redirect(`${siteUrl}/integrations?shopify_error=${encodeURIComponent(reason)}`)

  try {
    return await handle(request, siteUrl, fail)
  } catch (e: any) {
    // Anything unhandled here used to surface as a bare "HTTP ERROR 500" on
    // Shopify's return trip, with no clue which step died. Every failure must
    // land back on Integrations with a reason attached.
    console.error('[shopify-callback] unhandled', e)
    return fail(`Unexpected error: ${e?.message ?? e}`)
  }
}

async function handle(request: Request, siteUrl: string, fail: (reason: string) => NextResponse) {
  const url = new URL(request.url)
  const shop = normalizeShopDomain(url.searchParams.get('shop') ?? '')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const hmac = url.searchParams.get('hmac')

  if (!shop || !code || !state || !hmac) return fail('Missing OAuth parameters')

  const jar = await cookies()
  const expectedState = jar.get('shopify_oauth_state')?.value
  const userId = jar.get('shopify_oauth_user')?.value

  if (!expectedState || !safeEqual(state, expectedState)) return fail('Invalid state — please retry')
  if (!userId) return fail('Session expired — sign in and retry')

  /* ---------------------------- HMAC check ---------------------------- */
  const secret = process.env.SHOPIFY_CLIENT_SECRET
  if (!secret) return fail('SHOPIFY_CLIENT_SECRET is not configured')

  const message = [...url.searchParams.entries()]
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex')
  if (!safeEqual(digest, hmac)) return fail('HMAC verification failed')

  /* --------------------- can we even store the result? ---------------- */
  // Deliberately before the exchange: `code` is single-use, so discovering a
  // missing ENCRYPTION_KEY *after* spending it would force a pointless retry.
  const persist = canPersistTokens()
  if (!persist.ok) return fail(persist.message)

  /* -------------------------- token exchange -------------------------- */
  let tokenJson: { access_token: string; scope?: string; expires_in?: number; refresh_token?: string }
  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: secret,
        code,
      }),
      cache: 'no-store',
    })
    if (!res.ok) return fail(`Token exchange failed (${res.status})`)
    tokenJson = await res.json()
  } catch (e: any) {
    return fail(`Token exchange error: ${e?.message ?? e}`)
  }

  /* ----------------------- validate against Shopify ------------------- */
  const shopInfo = await adminGraphql<{ shop: { name: string; id: string; currencyCode: string; ianaTimezone: string } }>(
    shop,
    tokenJson.access_token,
    `{ shop { name id currencyCode ianaTimezone } }`
  )

  if (!shopInfo.ok) return fail('Could not read the store with the new token')

  /* ------------------------------ persist ----------------------------- */
  const db = createServiceClient()

  // store_domain is UNIQUE: refuse to steal a store already bound elsewhere.
  const { data: owner } = await db
    .from('shopify_config')
    .select('user_id')
    .eq('store_domain', shop)
    .maybeSingle()

  if (owner && owner.user_id !== userId) {
    return fail('That store is already connected to a different Wasify account')
  }

  const { error } = await db.from('shopify_config').upsert(
    {
      user_id: userId,
      store_domain: shop,
      store_name: shopInfo.data.shop.name,
      store_currency: shopInfo.data.shop.currencyCode,
      store_timezone: shopInfo.data.shop.ianaTimezone,
      access_token: encrypt(tokenJson.access_token),
      refresh_token: tokenJson.refresh_token ? encrypt(tokenJson.refresh_token) : null,
      token_expires_at: tokenJson.expires_in
        ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
        : null,
      scopes: tokenJson.scope ?? SHOPIFY_SCOPES.join(','),
      connection_status: 'connected',
      connection_error: null,
    },
    { onConflict: 'user_id' }
  )

  if (error) return fail(`Could not save the connection: ${error.message}`)

  /* --------------------------- webhooks ------------------------------- */
  // A partial failure is not a failed connection: the topics that registered
  // work immediately. Record which ones did not, and name them.
  try {
    const { results, failed } = await registerShopifyWebhooks(shop, tokenJson.access_token, siteUrl)
    await db
      .from('shopify_config')
      .update({
        webhooks_registered: failed.length === 0,
        webhooks_registered_at: new Date().toISOString(),
        connection_error: failed.length
          ? `${results.length - failed.length} of ${results.length} webhooks registered. Failed: ` +
            failed.map((f) => `${f.topic} (${f.error})`).join(', ')
          : null,
      })
      .eq('user_id', userId)
  } catch (e: any) {
    // Connection still counts as successful — the Integrations page shows a retry.
    await db
      .from('shopify_config')
      .update({ webhooks_registered: false, connection_error: `Webhook registration failed: ${e?.message ?? e}` })
      .eq('user_id', userId)
  }

  jar.delete('shopify_oauth_state')
  jar.delete('shopify_oauth_user')

  return NextResponse.redirect(`${siteUrl}/integrations?shopify=connected`)
}
