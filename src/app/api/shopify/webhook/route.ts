import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { hmacBase64 } from '@/lib/crypto'
import { configByStoreDomain } from '@/lib/shopify/admin'
import { startCodConfirmation, upsertOrderFromWebhook, refreshContactRollups } from '@/lib/engines/cod'
import { upsertCheckoutFromWebhook, ensureCheckoutRecovery } from '@/lib/engines/recovery'
import { logActivity, notify } from '@/lib/contacts'
import { COMPLIANCE_TOPICS } from '@/lib/shopify/webhooks'
import { phonesMatch, sanitizePhone } from '@/lib/phone'

/** Tenant lookup that does not need a working token — GDPR topics only. */
async function tenantByStoreDomain(db: any, domain: string): Promise<{ user_id: string } | null> {
  const { data } = await db.from('shopify_config').select('user_id').eq('store_domain', domain).maybeSingle()
  return data ?? null
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const started = Date.now()

  // HMAC is computed over the RAW body bytes — parse only after verifying.
  const raw = await request.text()
  const hmac = request.headers.get('x-shopify-hmac-sha256') ?? ''
  const topic = request.headers.get('x-shopify-topic') ?? ''
  const domain = request.headers.get('x-shopify-shop-domain') ?? ''

  // Fail closed for the same reason as the WhatsApp webhook: without the
  // secret we cannot tell a real Shopify delivery from a forged one.
  const secret = process.env.SHOPIFY_CLIENT_SECRET
  if (!secret) {
    console.error('[shopify-webhook] SHOPIFY_CLIENT_SECRET is not set — refusing all webhook traffic')
    return new NextResponse('Webhook signature verification is not configured', { status: 503 })
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

  // configByStoreDomain() returns null unless a usable ACCESS TOKEN decrypts,
  // which is right for every topic that calls back into Shopify. The GDPR
  // topics are the exception: shop/redact is delivered ~48 hours AFTER the app
  // is uninstalled, and app/uninstalled has already nulled the token by then.
  // Resolving those by domain alone is what makes erasure actually happen.
  const isCompliance = (COMPLIANCE_TOPICS as readonly string[]).includes(topic)
  const config = isCompliance ? await tenantByStoreDomain(db, domain) : await configByStoreDomain(domain)

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

  let failed = false

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
    failed = true
    if (logRow) {
      await db
        .from('shopify_webhook_events')
        .update({ status: 'failed', error: String(e?.message ?? e), duration_ms: Date.now() - started })
        .eq('id', logRow.id)
    }
  }

  // A SAVE failure returns 500 on purpose, so Shopify retries and the capture
  // is not lost — every write on this path is an idempotent upsert, so a retry
  // is free. Anything else (unknown shop, ignored topic) is a 200: retrying
  // would never change the outcome and repeated failures make Shopify disable
  // the subscription outright.
  if (failed) {
    return NextResponse.json({ received: false, retry: true }, { status: 500 })
  }
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

    /* -------------------------- GDPR compliance ------------------------ */
    // Configured in the Partner Dashboard, not registered through the Admin
    // API — see COMPLIANCE_TOPICS in lib/shopify/webhooks.ts.

    case 'shop/redact': {
      // Drop the mirrored commerce data for this store.
      await db.from('shopify_orders').delete().eq('user_id', userId)
      await db.from('shopify_checkouts').delete().eq('user_id', userId)
      await db.from('shopify_products').delete().eq('user_id', userId)
      return
    }

    case 'customers/redact': {
      // One customer, not the whole store. Resolve which contact they are the
      // same way everything else does — Shopify id, then exact digits or the
      // last 8 — so a redaction cannot miss a thread the app itself unified.
      const shopifyId = payload?.customer?.id != null ? String(payload.customer.id) : null
      const phone = sanitizePhone(payload?.customer?.phone ?? '')
      const email = (payload?.customer?.email ?? '').trim().toLowerCase()

      const ids = new Set<string>()

      if (shopifyId) {
        const { data } = await db
          .from('contacts')
          .select('id')
          .eq('user_id', userId)
          .eq('shopify_customer_id', shopifyId)
        for (const c of data ?? []) ids.add(c.id)
      }

      if (phone) {
        const { data } = await db
          .from('contacts')
          .select('id, phone')
          .eq('user_id', userId)
          .ilike('phone', `%${phone.slice(-8)}`)
        for (const c of data ?? []) if (phonesMatch(c.phone, phone)) ids.add(c.id)
      }

      if (email) {
        const { data } = await db.from('contacts').select('id').eq('user_id', userId).ilike('email', email)
        for (const c of data ?? []) ids.add(c.id)
      }

      if (!ids.size) return
      const list = [...ids]

      // shopify_orders/checkouts reference contacts with ON DELETE SET NULL,
      // so deleting the contact would orphan them rather than remove them.
      // They carry customer_name/email/phone, so they must go explicitly.
      await db.from('shopify_orders').delete().eq('user_id', userId).in('contact_id', list)
      await db.from('shopify_checkouts').delete().eq('user_id', userId).in('contact_id', list)

      // Conversations, messages and the rest cascade from the contact.
      await db.from('contacts').delete().eq('user_id', userId).in('id', list)
      return
    }

    case 'customers/data_request': {
      // Nothing is returned over this channel — Shopify requires the app to
      // hand the data to the store owner directly, within 30 days. Surface it
      // so the merchant knows a request is outstanding; the payload itself is
      // already stored on the shopify_webhook_events row.
      await notify(
        db,
        userId,
        'info',
        `A customer requested their data (${payload?.customer?.email ?? payload?.customer?.id ?? 'unknown'}). ` +
          'You have 30 days to send it to them.',
        '/integrations'
      )
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
