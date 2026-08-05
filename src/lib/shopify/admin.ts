import { decrypt, encrypt } from '@/lib/crypto'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * Admin API version. The Partner Dashboard's "Webhooks API version" should be
 * set to the SAME value, so a payload never arrives in a shape the parsers
 * were not written against.
 */
export const SHOPIFY_API_VERSION = '2026-04'

/**
 * Scopes, and why each one is here. This list must match the Partner
 * Dashboard exactly — see SETUP.md Step 4.
 *
 * Removing any of these silently breaks a feature rather than erroring:
 * Shopify simply refuses to register the webhook, and the corresponding
 * automation never fires.
 *
 *   read_customers    contact name/email when mirroring orders and checkouts
 *   read_orders       orders/* AND checkouts/* webhooks (checkout topics are
 *                     gated on read_orders, not read_checkouts), plus the
 *                     order backfill
 *   write_orders      COD tags — "COD Pending" -> "COD Confirmed"/"Cancelled"
 *   read_checkouts    the REST checkouts.json backfill used for cart history
 *   read_fulfillments fulfillments/create and fulfillments/update webhooks
 *   read_products     catalog mirror on the Catalog screen
 *   read_discounts    reading existing discounts
 *   write_discounts   minting the single-use cart-recovery codes
 *
 * Deliberately NOT requested: read_product_listings and read_validations are
 * for sales channels and checkout functions, neither of which this app is.
 */
export const SHOPIFY_SCOPES = [
  'read_customers',
  'read_orders',
  'write_orders',
  'read_checkouts',
  'read_fulfillments',
  'read_products',
  'read_discounts',
  'write_discounts',
] as const

export type ShopifyConfig = {
  id: string
  user_id: string
  store_domain: string
  store_name: string | null
  access_token: string | null
  refresh_token: string | null
  token_expires_at: string | null
  scopes: string | null
  webhooks_registered: boolean | null
  connection_status: string | null
  /**
   * shopify_config also carries every `cod_*` and `recovery_*` feature column
   * (see supabase/schema.sql §12). They are read by the COD and recovery
   * engines and are too numerous — and too likely to grow — to restate here.
   */
  [featureColumn: string]: any
}

/**
 * Return a usable access token for a store, refreshing an expiring
 * offline token first (5-minute buffer) and re-encrypting on write.
 */
export async function getValidToken(config: ShopifyConfig): Promise<string | null> {
  if (!config.access_token) return null

  let token: string
  try {
    token = decrypt(config.access_token)
  } catch {
    return null
  }

  const expiresAt = config.token_expires_at ? new Date(config.token_expires_at).getTime() : 0
  const needsRefresh = expiresAt > 0 && expiresAt - Date.now() < 5 * 60 * 1000

  if (!needsRefresh || !config.refresh_token) return token

  try {
    const refresh = decrypt(config.refresh_token)
    const res = await fetch(`https://${config.store_domain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refresh,
      }),
      cache: 'no-store',
    })
    if (!res.ok) return token // keep using the old one rather than breaking the caller

    const json = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string }
    const db = createServiceClient()
    await db
      .from('shopify_config')
      .update({
        access_token: encrypt(json.access_token),
        ...(json.refresh_token ? { refresh_token: encrypt(json.refresh_token) } : {}),
        token_expires_at: json.expires_in
          ? new Date(Date.now() + json.expires_in * 1000).toISOString()
          : null,
      })
      .eq('id', config.id)

    return json.access_token
  } catch {
    return token
  }
}

export async function getShopifyConfig(
  userId: string
): Promise<(ShopifyConfig & { token: string }) | null> {
  const db = createServiceClient()
  const { data } = await db.from('shopify_config').select('*').eq('user_id', userId).maybeSingle()
  if (!data) return null
  const token = await getValidToken(data as ShopifyConfig)
  return token ? { ...(data as ShopifyConfig), token } : null
}

export async function configByStoreDomain(
  domain: string
): Promise<(ShopifyConfig & { token: string }) | null> {
  const db = createServiceClient()
  const { data } = await db.from('shopify_config').select('*').eq('store_domain', domain).maybeSingle()
  if (!data) return null
  const token = await getValidToken(data as ShopifyConfig)
  return token ? { ...(data as ShopifyConfig), token } : null
}

/* ------------------------------------------------------------------ */
/* REST + GraphQL helpers                                              */
/* ------------------------------------------------------------------ */

export type AdminResult<T> = { ok: true; data: T; link?: string | null } | { ok: false; error: string }

export async function adminRest<T = any>(
  domain: string,
  token: string,
  path: string,
  init: RequestInit & { query?: Record<string, string | number | undefined> } = {}
): Promise<AdminResult<T>> {
  const { query, ...rest } = init
  const url = new URL(
    path.startsWith('http') ? path : `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/${path.replace(/^\//, '')}`
  )
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v))

  try {
    const res = await fetch(url.toString(), {
      ...rest,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        ...(rest.headers || {}),
      },
      cache: 'no-store',
    })
    const text = await res.text()
    const json = text ? JSON.parse(text) : null
    if (!res.ok) {
      return { ok: false, error: json?.errors ? JSON.stringify(json.errors) : `Shopify returned ${res.status}` }
    }
    return { ok: true, data: json as T, link: res.headers.get('link') }
  } catch (e: any) {
    return { ok: false, error: `Shopify request failed: ${e?.message ?? e}` }
  }
}

export async function adminGraphql<T = any>(
  domain: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<AdminResult<T>> {
  try {
    const res = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
    })
    const json = await res.json()
    if (!res.ok || json.errors) {
      return { ok: false, error: JSON.stringify(json.errors ?? `HTTP ${res.status}`) }
    }
    return { ok: true, data: json.data as T }
  } catch (e: any) {
    return { ok: false, error: `Shopify GraphQL failed: ${e?.message ?? e}` }
  }
}

/** Follow REST `Link: <…>; rel="next"` pagination. */
export function nextPageUrl(link: string | null | undefined): string | null {
  if (!link) return null
  const m = link.split(',').find((p) => p.includes('rel="next"'))
  if (!m) return null
  const url = m.match(/<([^>]+)>/)
  return url ? url[1] : null
}

/** `12345` → `gid://shopify/Order/12345`, passing an existing gid through. */
export function orderGid(orderId: string | number): string {
  const id = String(orderId)
  return id.startsWith('gid://') ? id : `gid://shopify/Order/${id}`
}

/**
 * Tag an order — the COD flow reflects confirmation state in Shopify with it.
 *
 * GraphQL, because REST is closed to apps created after 1 April 2025 and a
 * REST failure here is invisible: the WhatsApp side of COD keeps working
 * while the merchant's Shopify admin never shows "COD Confirmed".
 */
export async function setOrderTags(domain: string, token: string, orderId: string | number, tags: string[]) {
  const current = await getOrderTags(domain, token, orderId)
  const wanted = new Set(tags.map((t) => t.trim()).filter(Boolean))
  const remove = current.filter((t) => !wanted.has(t))
  const add = [...wanted].filter((t) => !current.includes(t))

  if (remove.length) {
    const res = await adminGraphql(
      domain,
      token,
      `mutation Remove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) { userErrors { message } }
      }`,
      { id: orderGid(orderId), tags: remove }
    )
    if (!res.ok) return res
  }

  if (!add.length) return { ok: true as const, data: null }

  return adminGraphql(
    domain,
    token,
    `mutation Add($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { message } }
    }`,
    { id: orderGid(orderId), tags: add }
  )
}

export async function getOrderTags(domain: string, token: string, orderId: string | number): Promise<string[]> {
  const res = await adminGraphql<{ order: { tags: string[] } | null }>(
    domain,
    token,
    `query Tags($id: ID!) { order(id: $id) { tags } }`,
    { id: orderGid(orderId) }
  )
  if (!res.ok || !res.data.order) return []
  return (res.data.order.tags ?? []).map((t) => String(t).trim()).filter(Boolean)
}

/** Replace any tag from `remove` with `add`, preserving everything else. */
export async function retagOrder(
  domain: string,
  token: string,
  orderId: string | number,
  remove: string[],
  add: string[]
) {
  const current = await getOrderTags(domain, token, orderId)
  const lowerRemove = remove.map((t) => t.toLowerCase())
  const kept = current.filter((t) => !lowerRemove.includes(t.toLowerCase()))
  const next = [...new Set([...kept, ...add])]
  return setOrderTags(domain, token, orderId, next)
}
