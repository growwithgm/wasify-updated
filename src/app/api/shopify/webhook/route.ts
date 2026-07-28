import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { hmacBase64 } from '@/lib/crypto'
import { configByStoreDomain } from '@/lib/shopify/admin'
import { startCodConfirmation, upsertOrderFromWebhook, refreshContactRollups } from '@/lib/engines/cod'
import { upsertCheckoutFromWebhook, ensureCheckoutRecovery } from '@/lib/engines/recovery'
import { logActivity, notify } from '@/lib/contacts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const started = Date.now()

  // HMAC is computed over the RAW body bytes — parse only after verifying.
  const raw = await request.text()
  const hmac = request.headers.get('x-shopify-hmac-sha256') ?? ''
  const topic = request.headers.get('x-shopify-topic') ?? ''
  const domain = request.headers.get('x-shopify-shop-domain') ?? ''

  const secret = process.env.SHOPIFY_CLIENT_SECRET
  if (!secret) {
    console.error('[shopify-webhook] SHOPIFY_CLIENT_SECRET is not set')
    return new NextResponse('Not configured', { status: 500 })
  }

  const expected = hmacBase64(secret, raw)
  const valid =
    hmac.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))

  if (!valid) return new NextResponse('Invalid HMAC', { status: 401 })

  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 })
  }

  const db = createServiceClient()
  const config = await configByStoreDomain(domain)

  // Log every delivery — the Integrations screen renders this table.
  const { data: logRow } = await db
    .from('shopify_webhook_events')
    .insert({
      user_id: config?.user_id ?? null,
      topic,
      store_domain: domain,
      shopify_id: payload?.id != null ? String(payload.id) : null,
      payload,
      status: config ? 'received' : 'ignored',
      error: config ? null : 'No tenant owns this store domain',
    })
    .select('id')
    .single()

  if (!config) return NextResponse.json({ received: true })

  try {
    // Attach the domain so downstream helpers can resolve tenant config.
    payload.__store_domain = domain
    await handleTopic(db, config, topic, payload)

    if (logRow) {
      await db
        .from('shopify_webhook_events')
        .update({ status: 'processed', duration_ms: Date.now() - started })
        .eq('id', logRow.id)
    }
  } catch (e: any) {
    console.error('[shopify-webhook]', topic, e)
    if (logRow) {
      await db
        .from('shopify_webhook_events')
        .update({ status: 'failed', error: String(e?.message ?? e), duration_ms: Date.now() - started })
        .eq('id', logRow.id)
    }
  }

  // Always 200 — a non-2xx makes Shopify retry and eventually disable the hook.
  return NextResponse.json({ received: true })
}

async function handleTopic(db: any, config: any, topic: string, payload: any) {
  const userId = config.user_id

  switch (topic) {
    /* ------------------------------ orders ----------------------------- */
    case 'orders/create': {
      const order = await upsertOrderFromWebhook(db, userId, payload, 'webhook')
      if (!order) return

      await logActivity(db, userId, {
        kind: 'order',
        title: `New order ${order.order_number ?? ''}`.trim(),
        detail: order.customer_name ?? undefined,
        contactId: order.contact_id ?? undefined,
        amount: Number(order.total_price ?? 0),
      })

      // ONLY live webhook orders may start a COD conversation.
      if (order.is_cod) await startCodConfirmation(db, userId, order)

      // A completed order closes any recovery sequence for that customer.
      await closeRecoveriesForOrder(db, userId, payload, order)
      return
    }

    case 'orders/updated':
    case 'orders/cancelled': {
      const order = await upsertOrderFromWebhook(db, userId, payload, 'webhook')
      if (order?.contact_id) await refreshContactRollups(db, userId, order.contact_id)
      await closeRecoveriesForOrder(db, userId, payload, order)
      return
    }

    /* ---------------------------- checkouts ---------------------------- */
    case 'checkouts/create':
    case 'checkouts/update': {
      const checkout = await upsertCheckoutFromWebhook(db, userId, payload, 'webhook')
      if (checkout) await ensureCheckoutRecovery(db, userId, checkout)
      return
    }

    /* -------------------------- fulfillments --------------------------- */
    case 'fulfillments/create':
    case 'fulfillments/update': {
      await db.from('shopify_fulfillments').upsert(
        {
          user_id: userId,
          shopify_fulfillment_id: String(payload.id),
          shopify_order_id: payload.order_id != null ? String(payload.order_id) : null,
          status: payload.status ?? null,
          shipment_status: payload.shipment_status ?? null,
          tracking_company: payload.tracking_company ?? null,
          tracking_number: payload.tracking_number ?? null,
          tracking_url: payload.tracking_url ?? payload.tracking_urls?.[0] ?? null,
          source: 'webhook',
          shopify_created_at: payload.created_at ?? null,
        },
        { onConflict: 'user_id,shopify_fulfillment_id' }
      )
      return
    }

    /* --------------------------- app lifecycle ------------------------- */
    case 'app/uninstalled': {
      await db
        .from('shopify_config')
        .update({
          connection_status: 'disconnected',
          connection_error: 'The app was uninstalled from Shopify',
          webhooks_registered: false,
          access_token: null,
          refresh_token: null,
        })
        .eq('user_id', userId)

      await notify(db, userId, 'error', 'Shopify app was uninstalled — reconnect to resume syncing', '/integrations')
      return
    }

    case 'shop/redact': {
      // GDPR: drop the mirrored commerce data for this store.
      await db.from('shopify_orders').delete().eq('user_id', userId)
      await db.from('shopify_checkouts').delete().eq('user_id', userId)
      await db.from('shopify_products').delete().eq('user_id', userId)
      return
    }

    default:
      return
  }
}

/**
 * When a customer completes an order, stop any recovery sequence for them
 * and mark the originating checkout recovered. This is the guard that stops
 * a paying customer receiving "you left something behind".
 */
async function closeRecoveriesForOrder(db: any, userId: string, payload: any, order: any) {
  const checkoutId = payload.checkout_id != null ? String(payload.checkout_id) : null
  const checkoutToken = payload.checkout_token ?? null

  if (checkoutId || checkoutToken) {
    let query = db.from('shopify_checkouts').update({
      completed_at: payload.created_at ?? new Date().toISOString(),
      recovered: true,
      recovered_order_id: String(payload.id),
    })
    query = checkoutId
      ? query.eq('user_id', userId).eq('shopify_checkout_id', checkoutId)
      : query.eq('user_id', userId).eq('token', checkoutToken)
    await query

    await db
      .from('checkout_recoveries')
      .update({ status: 'completed_order' })
      .eq('user_id', userId)
      .eq('shopify_checkout_id', checkoutId ?? '')
      .eq('status', 'active')
  }

  // Belt and braces: close any other active sequence for the same contact.
  if (order?.contact_id) {
    await db
      .from('checkout_recoveries')
      .update({ status: 'completed_order' })
      .eq('user_id', userId)
      .eq('contact_id', order.contact_id)
      .eq('status', 'active')
  }
}
