import { adminRest, nextPageUrl, type ShopifyConfig } from './admin'
import { upsertOrderFromWebhook, refreshContactRollups } from '@/lib/engines/cod'
import { upsertCheckoutFromWebhook } from '@/lib/engines/recovery'

/**
 * Historical backfill.
 *
 * Everything written here carries source='backfill'. The COD engine only ever
 * starts a confirmation from a live orders/create webhook, so importing two
 * years of history can never message anyone.
 *
 * Recovery rows ARE created from backfilled checkouts — deliberately, so the
 * carts page has history — but sending stays gated on recovery_enabled and on
 * the completed/recovered re-check inside the sweep.
 */

const PAGE_SIZE = 250

export type SyncResult = {
  orders: number
  checkouts: number
  products: number
  errors: string[]
}

export async function syncStore(
  db: any,
  config: ShopifyConfig & { token: string },
  opts: { maxPages?: number; sinceDays?: number } = {}
): Promise<SyncResult> {
  const maxPages = opts.maxPages ?? 8
  const since = new Date(Date.now() - (opts.sinceDays ?? 90) * 86400_000).toISOString()

  const result: SyncResult = { orders: 0, checkouts: 0, products: 0, errors: [] }
  const touchedContacts = new Set<string>()

  /* ------------------------------ orders ------------------------------ */
  try {
    let url: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const res: any = url
        ? await adminRest<any>(config.store_domain, config.token, url)
        : await adminRest<any>(config.store_domain, config.token, 'orders.json', {
            query: { limit: PAGE_SIZE, status: 'any', created_at_min: since },
          })

      if (!res.ok) {
        result.errors.push(`orders: ${res.error}`)
        break
      }

      for (const order of res.data.orders ?? []) {
        order.__store_domain = config.store_domain
        const row = await upsertOrderFromWebhook(db, config.user_id, order, 'backfill')
        if (row?.contact_id) touchedContacts.add(row.contact_id)
        result.orders++
      }

      url = nextPageUrl(res.link)
      if (!url) break
    }
  } catch (e: any) {
    result.errors.push(`orders: ${e?.message ?? e}`)
  }

  /* ---------------------------- checkouts ----------------------------- */
  try {
    let url: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const res: any = url
        ? await adminRest<any>(config.store_domain, config.token, url)
        : await adminRest<any>(config.store_domain, config.token, 'checkouts.json', {
            query: { limit: PAGE_SIZE, created_at_min: since },
          })

      if (!res.ok) {
        result.errors.push(`checkouts: ${res.error}`)
        break
      }

      for (const checkout of res.data.checkouts ?? []) {
        await upsertCheckoutFromWebhook(db, config.user_id, checkout, 'backfill')
        result.checkouts++
      }

      url = nextPageUrl(res.link)
      if (!url) break
    }
  } catch (e: any) {
    result.errors.push(`checkouts: ${e?.message ?? e}`)
  }

  /* ----------------------------- products ----------------------------- */
  try {
    let url: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const res: any = url
        ? await adminRest<any>(config.store_domain, config.token, url)
        : await adminRest<any>(config.store_domain, config.token, 'products.json', {
            query: { limit: PAGE_SIZE },
          })

      if (!res.ok) {
        result.errors.push(`products: ${res.error}`)
        break
      }

      for (const product of res.data.products ?? []) {
        const variant = product.variants?.[0] ?? {}
        await db.from('shopify_products').upsert(
          {
            user_id: config.user_id,
            shopify_product_id: String(product.id),
            title: product.title,
            handle: product.handle,
            sku: variant.sku ?? null,
            vendor: product.vendor ?? null,
            product_type: product.product_type ?? null,
            price: variant.price != null ? Number(variant.price) : null,
            currency: config.store_currency ?? 'EUR',
            inventory_quantity: (product.variants ?? []).reduce(
              (s: number, v: any) => s + (v.inventory_quantity ?? 0),
              0
            ),
            image_url: product.image?.src ?? product.images?.[0]?.src ?? null,
            status: product.status ?? null,
            catalog_sync_status: product.status === 'active' ? 'synced' : 'excluded',
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,shopify_product_id' }
        )
        result.products++
      }

      url = nextPageUrl(res.link)
      if (!url) break
    }
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
