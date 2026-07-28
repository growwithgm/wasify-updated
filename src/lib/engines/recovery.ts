import { sendTemplate } from '@/lib/whatsapp/send'
import { getShopifyConfig } from '@/lib/shopify/admin'
import { generateDiscountCodeForContact } from './discounts'
import { matchesKeyword, type InboundCtx } from './types'
import { findOrCreateContact, findOrCreateConversation, logActivity } from '@/lib/contacts'
import { extractShopifyPhone, phonesMatch } from '@/lib/phone'

/**
 * Abandoned-checkout recovery.
 *
 * Intake creates ONE row per checkout regardless of whether recovery is
 * enabled (so turning it on later has history); SENDING is what the enabled
 * flag gates.
 *
 * The rule that matters most: re-read the checkout immediately before every
 * send and stop if it completed. Messaging a customer who already paid is the
 * worst failure mode this system has.
 */

const STAGE_COLUMNS = ['reminder1_sent_at', 'reminder2_sent_at', 'reminder3_sent_at'] as const

/* ------------------------------------------------------------------ */
/* Intake                                                              */
/* ------------------------------------------------------------------ */

export async function ensureCheckoutRecovery(db: any, userId: string, checkoutRow: any) {
  const shopifyCheckoutId = checkoutRow?.shopify_checkout_id

  // Guard against the literal string "undefined", which the old app once wrote.
  if (!shopifyCheckoutId || shopifyCheckoutId === 'undefined' || shopifyCheckoutId === 'null') return

  const { data: existing } = await db
    .from('checkout_recoveries')
    .select('id, status, phone')
    .eq('user_id', userId)
    .eq('shopify_checkout_id', shopifyCheckoutId)
    .maybeSingle()

  // Already completed → nothing to recover.
  if (checkoutRow.completed_at || checkoutRow.recovered) {
    if (existing && existing.status === 'active') {
      await db.from('checkout_recoveries').update({ status: 'completed_order' }).eq('id', existing.id)
    }
    return
  }

  const phone = checkoutRow.customer_phone

  if (existing) {
    // A phone that arrives later re-activates a row parked as skipped_no_phone.
    if (existing.status === 'skipped_no_phone' && phone) {
      await db.from('checkout_recoveries').update({ status: 'active', phone }).eq('id', existing.id)
    }
    return
  }

  if (!phone) {
    await db.from('checkout_recoveries').insert({
      user_id: userId,
      shopify_checkout_id: shopifyCheckoutId,
      checkout_row_id: checkoutRow.id,
      contact_id: checkoutRow.contact_id,
      status: 'skipped_no_phone',
    })
    return
  }

  // Cooldown: don't chase the same person twice in N days.
  const config = await getShopifyConfig(userId)
  const cooldownDays = config?.recovery_cooldown_days ?? 7

  if (cooldownDays > 0) {
    const since = new Date(Date.now() - cooldownDays * 86400_000).toISOString()
    const { data: recent } = await db
      .from('checkout_recoveries')
      .select('phone')
      .eq('user_id', userId)
      .gte('created_at', since)
      .not('phone', 'is', null)
      .limit(200)

    if ((recent ?? []).some((r: any) => phonesMatch(r.phone, phone))) {
      await db.from('checkout_recoveries').insert({
        user_id: userId,
        shopify_checkout_id: shopifyCheckoutId,
        checkout_row_id: checkoutRow.id,
        contact_id: checkoutRow.contact_id,
        phone,
        status: 'suppressed_cooldown',
      })
      return
    }
  }

  await db.from('checkout_recoveries').insert({
    user_id: userId,
    shopify_checkout_id: shopifyCheckoutId,
    checkout_row_id: checkoutRow.id,
    contact_id: checkoutRow.contact_id,
    phone,
    status: 'active',
  })
}

/* ------------------------------------------------------------------ */
/* Sweep                                                               */
/* ------------------------------------------------------------------ */

export async function runRecoveryTimers(db: any): Promise<{ sent: number; stopped: number }> {
  const { data: rows } = await db
    .from('checkout_recoveries')
    .select('*')
    .eq('status', 'active')
    .limit(500)

  let sent = 0
  let stopped = 0

  const byUser = new Map<string, any[]>()
  for (const row of rows ?? []) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, [])
    byUser.get(row.user_id)!.push(row)
  }

  for (const [userId, userRows] of byUser) {
    const config = await getShopifyConfig(userId)
    if (!config?.recovery_enabled) continue

    const delays = [
      config.recovery_delay1_minutes ?? 45,
      config.recovery_delay2_minutes ?? 1440,
      config.recovery_delay3_minutes ?? 2880,
    ]

    for (const row of userRows) {
      if (!row.phone) continue

      // ---- re-read the checkout RIGHT BEFORE sending ----
      const { data: checkout } = await db
        .from('shopify_checkouts')
        .select('*')
        .eq('user_id', userId)
        .eq('shopify_checkout_id', row.shopify_checkout_id)
        .maybeSingle()

      if (!checkout) continue

      if (checkout.completed_at || checkout.recovered) {
        await db.from('checkout_recoveries').update({ status: 'completed_order' }).eq('id', row.id)
        stopped++
        continue
      }

      const ageMinutes = (Date.now() - new Date(row.created_at).getTime()) / 60_000

      // Highest DUE stage fires once — never a burst of three.
      let stage = 0
      for (let i = 0; i < 3; i++) {
        if (ageMinutes >= delays[i] && row.reminders_sent < i + 1) stage = i + 1
      }
      if (stage === 0) continue

      const result = await sendReminder(db, userId, config, row, checkout, stage)

      const patch: Record<string, unknown> = {
        reminders_sent: stage,
        [STAGE_COLUMNS[stage - 1]]: new Date().toISOString(),
        last_error: result.ok ? null : result.error,
      }
      if (result.discountCode) patch.discount_code = result.discountCode
      if (stage === 3) patch.status = 'done'

      await db.from('checkout_recoveries').update(patch).eq('id', row.id)

      if (result.ok) sent++
    }
  }

  return { sent, stopped }
}

async function sendReminder(
  db: any,
  userId: string,
  config: any,
  row: any,
  checkout: any,
  stage: number
): Promise<{ ok: boolean; error?: string; discountCode?: string }> {
  /* ---------------- template selection by locale ---------------- */
  const es = config[`recovery_r${stage}_template_es`]
  const en = config[`recovery_r${stage}_template_en`]
  const prefersSpanish = (checkout.customer_locale ?? '').toLowerCase().startsWith('es')

  // Cross-language fallback: use whichever is set. Skip only if NEITHER is.
  const templateName = prefersSpanish ? es || en : en || es
  if (!templateName) return { ok: false, error: `No template set for reminder ${stage}` }

  const language = templateName === es ? 'es' : 'en'

  /* ---------------------- optional discount --------------------- */
  let discountCode: string | undefined
  const discountId = config[`recovery_r${stage}_discount_id`]

  if (discountId && row.contact_id) {
    try {
      const code = await generateDiscountCodeForContact(db, userId, discountId, row.contact_id)
      discountCode = code ?? undefined
    } catch (e) {
      // A discount failure must never block the reminder itself.
      console.error('[recovery] discount generation failed', e)
    }
  }

  /* ---------------------- variable mapping ---------------------- */
  const map = config[`recovery_r${stage}_var_map`] ?? []
  const vars = (map as any[]).map((entry) => {
    switch (entry.source) {
      case 'first_name':
        return (checkout.customer_name ?? '').split(' ')[0] || 'hola'
      case 'full_name':
        return checkout.customer_name ?? ''
      case 'cart_total':
        return formatMoney(checkout.total_price, checkout.currency)
      case 'currency':
        return checkout.currency ?? 'EUR'
      case 'items_count':
        return String(checkout.items_count ?? 0)
      case 'discount_code':
        return discountCode ?? ''
      default:
        return entry.value ?? ''
    }
  })

  /* --------------------- dynamic URL button --------------------- */
  // Meta only substitutes a SUFFIX: the template's button base URL is
  // https://<store-domain>/{{1}} and we pass path+query only.
  const components: any[] = []
  if (vars.length) {
    components.push({ type: 'body', parameters: vars.map((t) => ({ type: 'text', text: t })) })
  }

  const suffix = urlSuffix(checkout.abandoned_checkout_url, discountCode)
  if (suffix) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: suffix }],
    })
  }

  const res = await sendTemplate(
    userId,
    row.phone,
    templateName,
    components.length ? components : undefined,
    language
  )

  if (res.ok) {
    await mirrorToThread(db, userId, row, checkout, templateName, res.wamid)
    await logActivity(db, userId, {
      kind: 'recovery',
      title: `Cart reminder ${stage} sent`,
      detail: discountCode ? `with code ${discountCode}` : undefined,
      contactId: row.contact_id ?? undefined,
      amount: Number(checkout.total_price ?? 0),
    })
  }

  return { ok: res.ok, error: res.ok ? undefined : res.error, discountCode }
}

/** Path + query only — the domain lives in the template's button base URL. */
export function urlSuffix(checkoutUrl: string | null | undefined, discountCode?: string): string | null {
  if (!checkoutUrl) return null
  try {
    const url = new URL(checkoutUrl)
    if (discountCode) url.searchParams.set('discount', discountCode)
    // Drop the leading slash: Meta appends our value directly to the base.
    return `${url.pathname.replace(/^\//, '')}${url.search}`
  } catch {
    return null
  }
}

function formatMoney(value: unknown, currency = 'EUR') {
  const n = Number(value ?? 0)
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

async function mirrorToThread(
  db: any,
  userId: string,
  row: any,
  checkout: any,
  templateName: string,
  wamid?: string
) {
  if (!row.contact_id) return
  const conversationId = await findOrCreateConversation(db, userId, row.contact_id)
  if (!conversationId) return

  await db.from('messages').insert({
    user_id: userId,
    conversation_id: conversationId,
    contact_id: row.contact_id,
    sender_type: 'bot',
    content_type: 'template',
    content: `Cart recovery reminder — ${formatMoney(checkout.total_price, checkout.currency)}`,
    template_name: templateName,
    message_id: wamid ?? null,
    status: wamid ? 'sent' : 'failed',
  })
}

/* ------------------------------------------------------------------ */
/* STOP / opt-out                                                      */
/* ------------------------------------------------------------------ */

/**
 * Marketing opt-out. Flips this contact's ACTIVE recovery sequences to
 * opted_out and adds them to the suppression list.
 *
 * Deliberately does NOT touch COD confirmations — those are transactional
 * and the customer still needs to confirm their order.
 */
export async function handleRecoveryOptOut(ctx: InboundCtx): Promise<boolean> {
  const { db, userId, contactId, text } = ctx
  if (!text?.trim()) return false

  const config = await getShopifyConfig(userId)
  const keywords: string[] = config?.recovery_stop_keywords ?? ['stop', 'baja', 'parar', 'unsubscribe']

  const matched = keywords.find((k) => matchesKeyword(text, k))
  if (!matched) return false

  const now = new Date().toISOString()

  await db
    .from('checkout_recoveries')
    .update({ status: 'opted_out' })
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .eq('status', 'active')

  await db
    .from('contacts')
    .update({ opt_in_status: 'opted_out', opt_out_at: now, accepts_marketing: false })
    .eq('id', contactId)

  await db.from('suppression_list').upsert(
    {
      user_id: userId,
      phone: ctx.phone,
      contact_id: contactId,
      reason: 'opt_out',
      keyword: matched,
      source: 'whatsapp',
    },
    { onConflict: 'user_id,phone' }
  )

  await db.from('consent_events').insert({
    user_id: userId,
    contact_id: contactId,
    event: 'opt_out',
    source: 'whatsapp STOP',
    keyword: matched,
    detail: `Customer sent "${text.slice(0, 60)}"`,
  })

  await logActivity(db, userId, {
    kind: 'system',
    title: 'Contact opted out of marketing',
    detail: `sent "${matched}"`,
    contactId,
  })

  return true
}

/* ------------------------------------------------------------------ */
/* Checkout mirroring (called by the Shopify webhook + sync)           */
/* ------------------------------------------------------------------ */

export async function upsertCheckoutFromWebhook(
  db: any,
  userId: string,
  payload: any,
  source: 'webhook' | 'backfill'
) {
  const shopifyCheckoutId = payload.id != null ? String(payload.id) : null
  if (!shopifyCheckoutId || shopifyCheckoutId === 'undefined') return null

  const phone = extractShopifyPhone(payload)

  let contactId: string | null = null
  if (phone) {
    const contact = await findOrCreateContact(db, userId, phone, {
      name: [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(' ') || null,
      email: payload.customer?.email ?? payload.email ?? null,
      locale: payload.customer_locale ?? null,
      source: 'shopify',
      shopify_customer_id: payload.customer?.id ? String(payload.customer.id) : null,
    })
    contactId = contact?.id ?? null
  }

  const row = {
    user_id: userId,
    shopify_checkout_id: shopifyCheckoutId,
    token: payload.token ?? null,
    contact_id: contactId,
    customer_name:
      [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(' ') || null,
    customer_email: payload.customer?.email ?? payload.email ?? null,
    customer_phone: phone || null,
    customer_locale: payload.customer_locale ?? null,
    total_price: Number(payload.total_price ?? 0),
    currency: payload.currency ?? 'EUR',
    items_count: (payload.line_items ?? []).reduce((s: number, l: any) => s + (l.quantity ?? 0), 0),
    line_items: (payload.line_items ?? []).slice(0, 50).map((l: any) => ({
      title: l.title,
      quantity: l.quantity,
      price: l.price,
    })),
    abandoned_checkout_url: payload.abandoned_checkout_url ?? null,
    completed_at: payload.completed_at ?? null,
    source,
    shopify_created_at: payload.created_at ?? null,
    shopify_updated_at: payload.updated_at ?? null,
  }

  const { data } = await db
    .from('shopify_checkouts')
    .upsert(row, { onConflict: 'user_id,shopify_checkout_id' })
    .select('*')
    .single()

  // Row creation is the deliberate exception to "backfill never triggers":
  // creating history is safe, and sending stays gated on recovery_enabled.
  if (data) await ensureCheckoutRecovery(db, userId, data)

  return data
}
