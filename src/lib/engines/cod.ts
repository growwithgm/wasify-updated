import { sendTemplate, sendWhatsApp } from '@/lib/whatsapp/send'
import { getShopifyConfig, retagOrder, configByStoreDomain } from '@/lib/shopify/admin'
import { canSendFreeText } from '@/lib/window'
import { matchesKeyword, recordOutbound, type InboundCtx } from './types'
import { findOrCreateContact, findOrCreateConversation, logActivity } from '@/lib/contacts'
import { extractShopifyPhone } from '@/lib/phone'

/**
 * Cash-on-delivery order confirmation.
 *
 * Lifecycle: live orders/create webhook → confirmation template → customer
 * replies SÍ/NO → re-tag in Shopify → timers escalate → no-reply cancellation.
 *
 * Every step is counter-gated so a webhook retry or a double cron run is a
 * no-op. One row per order, forever (DB unique on user_id + shopify_order_id).
 */

type VarMap = Array<{ source: string; value?: string }>

/** Order fields the variable mapper can inject into {{1}}, {{2}}… */
export function buildOrderVars(order: any, map: VarMap): string[] {
  return (map ?? []).map((entry) => {
    switch (entry.source) {
      case 'first_name':
        return (order.customer_name ?? '').split(' ')[0] || 'cliente'
      case 'full_name':
        return order.customer_name ?? 'cliente'
      case 'order_number':
        return String(order.order_number ?? order.shopify_order_id ?? '')
      case 'total':
        return formatMoney(order.total_price, order.currency)
      case 'currency':
        return order.currency ?? 'EUR'
      case 'items_count':
        return String(order.items_count ?? 0)
      case 'shipping_city':
        return order.shipping_city ?? ''
      case 'static':
      default:
        return entry.value ?? ''
    }
  })
}

function formatMoney(value: unknown, currency = 'EUR') {
  const n = Number(value ?? 0)
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

/** Does this order's gateway or financial status mark it as COD? */
export function isCodOrder(payload: any, gateways: string[]): boolean {
  const haystack = [
    payload.gateway,
    payload.payment_gateway_names?.join(' '),
    payload.processing_method,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (gateways.some((g) => haystack.includes(g.toLowerCase()))) return true

  // Some COD apps leave the gateway blank and only set financial_status.
  return payload.financial_status === 'pending' && !payload.payment_gateway_names?.length
}

/* ------------------------------------------------------------------ */
/* 1. Start a confirmation when a live COD order lands                 */
/* ------------------------------------------------------------------ */

export async function startCodConfirmation(
  db: any,
  userId: string,
  orderRow: any
): Promise<'created' | 'exists' | 'skipped'> {
  const config = await getShopifyConfig(userId)
  if (!config?.cod_enabled) return 'skipped'

  // Idempotency guard: one row per order, ever.
  const { data: existing } = await db
    .from('cod_confirmations')
    .select('id')
    .eq('user_id', userId)
    .eq('shopify_order_id', orderRow.shopify_order_id)
    .maybeSingle()

  if (existing) return 'exists'

  const phone = orderRow.customer_phone
  if (!phone) {
    await db.from('cod_confirmations').insert({
      user_id: userId,
      shopify_order_id: orderRow.shopify_order_id,
      order_number: orderRow.order_number,
      contact_id: orderRow.contact_id,
      status: 'skipped_no_phone',
    })
    return 'created'
  }

  const { data: row } = await db
    .from('cod_confirmations')
    .insert({
      user_id: userId,
      shopify_order_id: orderRow.shopify_order_id,
      order_number: orderRow.order_number,
      contact_id: orderRow.contact_id,
      phone,
      status: 'pending',
    })
    .select('id')
    .single()

  // Tag the order in Shopify so warehouse staff can see the state.
  try {
    await retagOrder(config.store_domain, config.token, orderRow.shopify_order_id, [], [config.cod_tag_pending])
  } catch (e) {
    console.error('[cod] tagging failed', e)
  }

  if (config.cod_confirm_template) {
    const vars = buildOrderVars(orderRow, config.cod_confirm_var_map)
    const res = await sendTemplate(
      userId,
      phone,
      config.cod_confirm_template,
      vars.length ? [{ type: 'body', parameters: vars.map((t) => ({ type: 'text' as const, text: t })) }] : undefined,
      orderRow.customer_locale?.startsWith('es') ? 'es' : undefined
    )

    if (res.ok) {
      await db.from('cod_confirmations').update({ messages_sent: 1 }).eq('id', row.id)
      await mirrorToThread(db, userId, orderRow, config.cod_confirm_template, res.wamid)
    } else {
      await db.from('cod_confirmations').update({ last_error: res.error }).eq('id', row.id)
    }
  }

  await logActivity(db, userId, {
    kind: 'cod',
    title: `COD confirmation sent for order #${orderRow.order_number ?? orderRow.shopify_order_id}`,
    contactId: orderRow.contact_id,
    amount: Number(orderRow.total_price ?? 0),
  })

  return 'created'
}

/** Show the outbound template in the customer's inbox thread. */
async function mirrorToThread(db: any, userId: string, orderRow: any, templateName: string, wamid?: string) {
  if (!orderRow.contact_id) return
  const conversationId = await findOrCreateConversation(db, userId, orderRow.contact_id)
  if (!conversationId) return

  await db.from('messages').insert({
    user_id: userId,
    conversation_id: conversationId,
    contact_id: orderRow.contact_id,
    sender_type: 'bot',
    content_type: 'template',
    content: `COD confirmation for order #${orderRow.order_number ?? orderRow.shopify_order_id}`,
    template_name: templateName,
    message_id: wamid ?? null,
    status: wamid ? 'sent' : 'failed',
  })
}

/* ------------------------------------------------------------------ */
/* 2. Interpret the customer's reply                                   */
/* ------------------------------------------------------------------ */

export async function handleCodReply(ctx: InboundCtx): Promise<boolean> {
  const { db, userId, contactId, text } = ctx
  if (!text?.trim()) return false

  const { data: pending } = await db
    .from('cod_confirmations')
    .select('*')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!pending) return false

  const config = await getShopifyConfig(userId)
  if (!config) return false

  const yes = (config.cod_yes_keywords ?? []).some((k: string) => matchesKeyword(text, k))
  const no = (config.cod_no_keywords ?? []).some((k: string) => matchesKeyword(text, k))

  // Unknown replies are ignored on purpose — reminders keep running.
  if (!yes && !no) return false

  const now = new Date().toISOString()
  const confirmed = yes && !no

  await db
    .from('cod_confirmations')
    .update({
      status: confirmed ? 'confirmed' : 'cancelled',
      [confirmed ? 'confirmed_at' : 'cancelled_at']: now,
      reply_text: text.slice(0, 200),
    })
    .eq('id', pending.id)

  try {
    await retagOrder(
      config.store_domain,
      config.token,
      pending.shopify_order_id,
      [config.cod_tag_pending],
      [confirmed ? config.cod_tag_confirmed : config.cod_tag_cancelled]
    )
  } catch (e) {
    console.error('[cod] re-tagging failed', e)
  }

  // Acknowledge: free text inside the window, template otherwise.
  const replyText = confirmed ? config.cod_confirmed_reply : config.cod_cancelled_reply
  const templateName = confirmed ? config.cod_confirmed_template : config.cod_cancelled_template

  const { data: conv } = await db
    .from('conversations')
    .select('last_inbound_at')
    .eq('id', ctx.conversationId)
    .maybeSingle()

  if (replyText && canSendFreeText(conv?.last_inbound_at)) {
    const res = await sendWhatsApp(userId, ctx.phone, { kind: 'text', body: replyText })
    await recordOutbound(ctx, { content: replyText, wamid: res.ok ? res.wamid : undefined })
  } else if (templateName) {
    const res = await sendTemplate(userId, ctx.phone, templateName)
    await recordOutbound(ctx, {
      content: confirmed ? 'Order confirmed' : 'Order cancelled',
      contentType: 'template',
      templateName,
      wamid: res.ok ? res.wamid : undefined,
    })
  }

  await logActivity(db, userId, {
    kind: 'cod',
    title: `Order #${pending.order_number ?? pending.shopify_order_id} ${confirmed ? 'confirmed' : 'cancelled'} over WhatsApp`,
    contactId,
  })

  return true
}

/* ------------------------------------------------------------------ */
/* 3. Timers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Reminder ladder. `messages_sent` is the gate: 1 = confirmation only,
 * 2 = reminder 1 sent, 3 = reminder 2 sent. Running this twice in a row can
 * never double-send because every branch checks the counter first.
 */
export async function runCodTimers(db: any): Promise<{ reminders: number; cancelled: number }> {
  const { data: pending } = await db
    .from('cod_confirmations')
    .select('*')
    .eq('status', 'pending')
    .limit(500)

  let reminders = 0
  let cancelled = 0

  // Group by tenant so we load each Shopify config once.
  const byUser = new Map<string, any[]>()
  for (const row of pending ?? []) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, [])
    byUser.get(row.user_id)!.push(row)
  }

  for (const [userId, rows] of byUser) {
    const config = await getShopifyConfig(userId)
    if (!config?.cod_enabled) continue

    for (const row of rows) {
      if (!row.phone) continue

      const ageMinutes = (Date.now() - new Date(row.created_at).getTime()) / 60_000
      const order = await loadOrder(db, userId, row.shopify_order_id)
      if (!order) continue

      /* ---- no-reply cancellation ---- */
      if (ageMinutes >= config.cod_no_reply_hours * 60) {
        await db
          .from('cod_confirmations')
          .update({ status: 'no_reply_cancelled', no_reply_at: new Date().toISOString() })
          .eq('id', row.id)

        try {
          await retagOrder(
            config.store_domain,
            config.token,
            row.shopify_order_id,
            [config.cod_tag_pending],
            [config.cod_tag_cancelled]
          )
        } catch (e) {
          console.error('[cod] no-reply re-tag failed', e)
        }

        if (config.cod_no_reply_template) {
          await sendTemplate(userId, row.phone, config.cod_no_reply_template, varsFor(order, config.cod_no_reply_var_map))
        }
        cancelled++
        continue
      }

      /* ---- reminder 2 ---- */
      if (
        config.cod_reminder_count >= 2 &&
        row.messages_sent <= 2 &&
        ageMinutes >= config.cod_reminder2_hours * 60 &&
        config.cod_reminder2_template
      ) {
        const res = await sendTemplate(
          userId,
          row.phone,
          config.cod_reminder2_template,
          varsFor(order, config.cod_reminder2_var_map)
        )
        await db
          .from('cod_confirmations')
          .update({
            messages_sent: 3,
            reminder2_sent_at: new Date().toISOString(),
            last_error: res.ok ? null : res.error,
          })
          .eq('id', row.id)
        if (res.ok) reminders++
        continue
      }

      /* ---- reminder 1 ---- */
      if (
        config.cod_reminder_count >= 1 &&
        row.messages_sent <= 1 &&
        ageMinutes >= config.cod_reminder1_hours * 60 &&
        config.cod_reminder1_template
      ) {
        const res = await sendTemplate(
          userId,
          row.phone,
          config.cod_reminder1_template,
          varsFor(order, config.cod_reminder1_var_map)
        )
        await db
          .from('cod_confirmations')
          .update({
            messages_sent: 2,
            reminder1_sent_at: new Date().toISOString(),
            last_error: res.ok ? null : res.error,
          })
          .eq('id', row.id)
        if (res.ok) reminders++
      }
    }
  }

  return { reminders, cancelled }
}

function varsFor(order: any, map: VarMap) {
  const vars = buildOrderVars(order, map)
  return vars.length
    ? [{ type: 'body' as const, parameters: vars.map((t) => ({ type: 'text' as const, text: t })) }]
    : undefined
}

async function loadOrder(db: any, userId: string, shopifyOrderId: string) {
  const { data } = await db
    .from('shopify_orders')
    .select('*')
    .eq('user_id', userId)
    .eq('shopify_order_id', shopifyOrderId)
    .maybeSingle()
  return data
}

/* ------------------------------------------------------------------ */
/* Helper used by the Shopify webhook                                  */
/* ------------------------------------------------------------------ */

export async function upsertOrderFromWebhook(
  db: any,
  userId: string,
  payload: any,
  source: 'webhook' | 'backfill'
) {
  const phone = extractShopifyPhone(payload)

  let contactId: string | null = null
  if (phone) {
    const contact = await findOrCreateContact(db, userId, phone, {
      name:
        [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(' ') || null,
      email: payload.customer?.email ?? payload.email ?? null,
      locale: payload.customer_locale ?? null,
      country: payload.shipping_address?.country ?? payload.billing_address?.country ?? null,
      city: payload.shipping_address?.city ?? payload.billing_address?.city ?? null,
      source: 'shopify',
      shopify_customer_id: payload.customer?.id ? String(payload.customer.id) : null,
    })
    contactId = contact?.id ?? null
  }

  const config = await configByStoreDomain(payload.__store_domain ?? '')
  const gateways = config?.cod_gateways ?? ['cash on delivery', 'contra reembolso', 'cod']

  const row = {
    user_id: userId,
    shopify_order_id: String(payload.id),
    order_number: payload.name ?? String(payload.order_number ?? ''),
    contact_id: contactId,
    customer_name:
      [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(' ') || null,
    customer_email: payload.customer?.email ?? payload.email ?? null,
    customer_phone: phone || null,
    customer_locale: payload.customer_locale ?? null,
    total_price: Number(payload.total_price ?? 0),
    subtotal_price: Number(payload.subtotal_price ?? 0),
    currency: payload.currency ?? 'EUR',
    items_count: (payload.line_items ?? []).reduce((s: number, l: any) => s + (l.quantity ?? 0), 0),
    line_items: (payload.line_items ?? []).slice(0, 50).map((l: any) => ({
      title: l.title,
      quantity: l.quantity,
      price: l.price,
      sku: l.sku,
    })),
    financial_status: payload.financial_status ?? null,
    fulfillment_status: payload.fulfillment_status ?? null,
    gateway: payload.gateway ?? payload.payment_gateway_names?.[0] ?? null,
    is_cod: isCodOrder(payload, gateways),
    tags: payload.tags ?? null,
    shipping_city: payload.shipping_address?.city ?? null,
    shipping_country: payload.shipping_address?.country ?? null,
    cancelled_at: payload.cancelled_at ?? null,
    source,
    shopify_created_at: payload.created_at ?? null,
    shopify_updated_at: payload.updated_at ?? null,
  }

  const { data, error } = await db
    .from('shopify_orders')
    .upsert(row, { onConflict: 'user_id,shopify_order_id' })
    .select('*')
    .single()

  // Same rule as the checkout mirror: a swallowed write error reads as
  // "processed" in the deliveries log while the order never lands.
  if (error) {
    throw new Error(
      `Could not save order ${row.shopify_order_id}: ${error.message}` +
        (String(error.code) === 'PGRST204'
          ? ' — the database is missing a column this version writes. Run supabase/schema.sql again (it is idempotent).'
          : '')
    )
  }

  if (contactId) await refreshContactRollups(db, userId, contactId)

  return data
}

/** Recompute lifetime spend / order count / AOV from the mirrored orders. */
export async function refreshContactRollups(db: any, userId: string, contactId: string) {
  const { data: orders } = await db
    .from('shopify_orders')
    .select('total_price, shopify_created_at, cancelled_at')
    .eq('user_id', userId)
    .eq('contact_id', contactId)

  const valid = (orders ?? []).filter((o: any) => !o.cancelled_at)
  const total = valid.reduce((s: number, o: any) => s + Number(o.total_price ?? 0), 0)
  const count = valid.length
  const last = valid
    .map((o: any) => o.shopify_created_at)
    .filter(Boolean)
    .sort()
    .pop()

  await db
    .from('contacts')
    .update({
      lifetime_spent: total,
      orders_count: count,
      avg_order_value: count ? total / count : 0,
      last_order_at: last ?? null,
    })
    .eq('id', contactId)
}
