import { adminGraphql, type ShopifyConfig } from './admin'
import { upsertOrderFromWebhook, refreshContactRollups } from '@/lib/engines/cod'
import { upsertCheckoutFromWebhook } from '@/lib/engines/recovery'

/**
 * Historical backfill — GraphQL only.
 *
 * The REST Admin API is legacy as of October 2024, and since 1 April 2025
 * apps created after that date cannot use it at all. This app is one of them,
 * so the old REST resource endpoints return nothing useful. The symptom was
 * nasty because it was SILENT and PARTIAL: orders still appeared (they arrive
 * on the orders/create webhook), while products and abandoned carts stayed
 * empty forever with no error anywhere in the UI.
 *
 * Everything written here carries source='backfill'. The COD engine only ever
 * starts a confirmation from a live orders/create webhook, so importing two
 * years of history can never message anyone.
 *
 * Recovery rows ARE created from backfilled checkouts — deliberately, so the
 * carts page has history — but sending stays gated on recovery_enabled and on
 * the completed/recovered re-check inside the sweep.
 */

const PAGE_SIZE = 100 // GraphQL cost limits; REST allowed 250

export type SyncResult = {
  orders: number
  checkouts: number
  products: number
  errors: string[]
}

const ORDERS_QUERY = `
  query Orders($cursor: String, $query: String) {
    orders(first: ${PAGE_SIZE}, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt updatedAt cancelledAt
        displayFinancialStatus displayFulfillmentStatus note tags
        paymentGatewayNames
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer { id firstName lastName email phone }
        phone email
        shippingAddress { name phone address1 city province zip countryCodeV2 }
        billingAddress { phone }
        lineItems(first: 50) { nodes { title quantity sku variantTitle
          originalUnitPriceSet { shopMoney { amount } } } }
      }
    }
  }`

const CHECKOUTS_QUERY = `
  query AbandonedCheckouts($cursor: String, $query: String) {
    abandonedCheckouts(first: ${PAGE_SIZE}, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id createdAt updatedAt completedAt abandonedCheckoutUrl
        totalPriceSet { shopMoney { amount currencyCode } }
        customer { id firstName lastName email phone locale }
        billingAddress { phone }
        shippingAddress { name phone }
        lineItems(first: 50) { nodes { title quantity sku variantTitle
          originalUnitPriceSet { shopMoney { amount } } } }
      }
    }
  }`

const PRODUCTS_QUERY = `
  query Products($cursor: String) {
    products(first: ${PAGE_SIZE}, after: $cursor, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title handle vendor productType status
        featuredMedia { preview { image { url } } }
        totalInventory
        variants(first: 1) { nodes { sku price } }
      }
    }
  }`

/** `gid://shopify/Order/12345` → `12345`, which is what every table stores. */
export function numericId(gid: string | null | undefined): string {
  if (!gid) return ''
  const tail = String(gid).split('/').pop() ?? ''
  return tail.split('?')[0]
}

/**
 * Reshape a GraphQL node into the REST-ish payload the webhook mappers expect.
 *
 * Deliberately reusing those mappers rather than writing a second one: they
 * hold the phone-resolution chain and the source discipline, and a parallel
 * implementation is exactly how the two paths drift apart.
 */
export function orderNodeToPayload(node: any): any {
  const money = node.currentTotalPriceSet?.shopMoney ?? {}
  return {
    id: numericId(node.id),
    name: node.name,
    order_number: node.name,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    cancelled_at: node.cancelledAt,
    financial_status: (node.displayFinancialStatus ?? '').toLowerCase(),
    fulfillment_status: (node.displayFulfillmentStatus ?? '').toLowerCase() || null,
    note: node.note,
    tags: Array.isArray(node.tags) ? node.tags.join(', ') : (node.tags ?? ''),
    payment_gateway_names: node.paymentGatewayNames ?? [],
    gateway: (node.paymentGatewayNames ?? [])[0] ?? null,
    total_price: money.amount ?? '0',
    currency: money.currencyCode ?? null,
    email: node.email,
    phone: node.phone,
    customer: node.customer
      ? {
          id: numericId(node.customer.id),
          first_name: node.customer.firstName,
          last_name: node.customer.lastName,
          email: node.customer.email,
          phone: node.customer.phone,
        }
      : null,
    shipping_address: node.shippingAddress
      ? {
          name: node.shippingAddress.name,
          phone: node.shippingAddress.phone,
          address1: node.shippingAddress.address1,
          city: node.shippingAddress.city,
          province: node.shippingAddress.province,
          zip: node.shippingAddress.zip,
          country_code: node.shippingAddress.countryCodeV2,
        }
      : null,
    billing_address: node.billingAddress ? { phone: node.billingAddress.phone } : null,
    line_items: (node.lineItems?.nodes ?? []).map((l: any) => ({
      title: l.title,
      quantity: l.quantity,
      sku: l.sku,
      variant_title: l.variantTitle,
      price: l.originalUnitPriceSet?.shopMoney?.amount ?? null,
    })),
  }
}

export function checkoutNodeToPayload(node: any): any {
  const money = node.totalPriceSet?.shopMoney ?? {}
  return {
    id: numericId(node.id),
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    completed_at: node.completedAt ?? null,
    abandoned_checkout_url: node.abandonedCheckoutUrl,
    total_price: money.amount ?? '0',
    currency: money.currencyCode ?? null,
    customer_locale: node.customer?.locale ?? null,
    email: node.customer?.email ?? null,
    phone: node.customer?.phone ?? null,
    customer: node.customer
      ? {
          id: numericId(node.customer.id),
          first_name: node.customer.firstName,
          last_name: node.customer.lastName,
          email: node.customer.email,
          phone: node.customer.phone,
        }
      : null,
    shipping_address: node.shippingAddress
      ? { name: node.shippingAddress.name, phone: node.shippingAddress.phone }
      : null,
    billing_address: node.billingAddress ? { phone: node.billingAddress.phone } : null,
    line_items: (node.lineItems?.nodes ?? []).map((l: any) => ({
      title: l.title,
      quantity: l.quantity,
      sku: l.sku,
      variant_title: l.variantTitle,
      price: l.originalUnitPriceSet?.shopMoney?.amount ?? null,
    })),
  }
}

/** Walk a GraphQL connection, one page at a time, up to `maxPages`. */
async function paginate(
  config: ShopifyConfig & { token: string },
  query: string,
  field: string,
  variables: Record<string, unknown>,
  maxPages: number,
  onNode: (node: any) => Promise<void>
): Promise<{ count: number; error?: string }> {
  let cursor: string | null = null
  let count = 0

  for (let page = 0; page < maxPages; page++) {
    const res: Awaited<ReturnType<typeof adminGraphql<any>>> = await adminGraphql<any>(
      config.store_domain,
      config.token,
      query,
      { ...variables, cursor }
    )
    if (!res.ok) return { count, error: res.error }

    const connection: any = res.data?.[field]
    if (!connection) return { count, error: `Shopify returned no ${field} — is the scope granted?` }

    for (const node of connection.nodes ?? []) {
      await onNode(node)
      count++
    }

    if (!connection.pageInfo?.hasNextPage) break
    cursor = connection.pageInfo.endCursor
  }

  return { count }
}

export async function syncStore(
  db: any,
  config: ShopifyConfig & { token: string },
  opts: { maxPages?: number; sinceDays?: number } = {}
): Promise<SyncResult> {
  const maxPages = opts.maxPages ?? 8
  const sinceDays = opts.sinceDays ?? 90
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString().slice(0, 10)

  const result: SyncResult = { orders: 0, checkouts: 0, products: 0, errors: [] }
  const touchedContacts = new Set<string>()

  /* ------------------------------ orders ------------------------------ */
  try {
    const { count, error } = await paginate(
      config,
      ORDERS_QUERY,
      'orders',
      { query: `created_at:>=${since}` },
      maxPages,
      async (node) => {
        const payload = orderNodeToPayload(node)
        payload.__store_domain = config.store_domain
        const row = await upsertOrderFromWebhook(db, config.user_id, payload, 'backfill')
        if (row?.contact_id) touchedContacts.add(row.contact_id)
      }
    )
    result.orders = count
    if (error) result.errors.push(`orders: ${error}`)
  } catch (e: any) {
    result.errors.push(`orders: ${e?.message ?? e}`)
  }

  /* ---------------------------- checkouts ----------------------------- */
  try {
    const { count, error } = await paginate(
      config,
      CHECKOUTS_QUERY,
      'abandonedCheckouts',
      { query: `created_at:>=${since}` },
      maxPages,
      async (node) => {
        await upsertCheckoutFromWebhook(db, config.user_id, checkoutNodeToPayload(node), 'backfill')
      }
    )
    result.checkouts = count
    if (error) result.errors.push(`abandoned checkouts: ${error}`)
  } catch (e: any) {
    result.errors.push(`abandoned checkouts: ${e?.message ?? e}`)
  }

  /* ----------------------------- products ----------------------------- */
  try {
    const { count, error } = await paginate(config, PRODUCTS_QUERY, 'products', {}, maxPages, async (node) => {
      const variant = node.variants?.nodes?.[0] ?? {}
      await db.from('shopify_products').upsert(
        {
          user_id: config.user_id,
          shopify_product_id: numericId(node.id),
          title: node.title,
          handle: node.handle,
          sku: variant.sku ?? null,
          vendor: node.vendor ?? null,
          product_type: node.productType ?? null,
          price: variant.price != null ? Number(variant.price) : null,
          currency: config.store_currency ?? 'EUR',
          inventory_quantity: node.totalInventory ?? 0,
          image_url: node.featuredMedia?.preview?.image?.url ?? null,
          status: (node.status ?? '').toLowerCase() || null,
          catalog_sync_status: String(node.status).toUpperCase() === 'ACTIVE' ? 'synced' : 'excluded',
          synced_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,shopify_product_id' }
      )
    })
    result.products = count
    if (error) result.errors.push(`products: ${error}`)
  } catch (e: any) {
    result.errors.push(`products: ${e?.message ?? e}`)
  }

  /* --------------------------- roll-ups ------------------------------- */
  for (const contactId of touchedContacts) {
    await refreshContactRollups(db, config.user_id, contactId)
  }

  await db
    .from('shopify_config')
    .update({
      last_sync_at: new Date().toISOString(),
      last_sync_status: result.errors.length ? `partial: ${result.errors[0]}` : 'ok',
    })
    .eq('user_id', config.user_id)

  return result
}
