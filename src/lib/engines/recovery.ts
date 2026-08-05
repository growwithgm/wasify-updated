import { sendTemplate, resolveApprovedTemplate } from '@/lib/whatsapp/send'
import { templateShape, paramMismatch } from '@/lib/whatsapp/template-params'
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

/**
 * How many times one reminder may fail before the sequence moves past it.
 * At a 15-minute tick that is roughly an hour of retrying, which covers a
 * template being corrected or a transient Meta error, without a permanently
 * broken setup retrying until the checkout ages out.
 */
export const MAX_SEND_ATTEMPTS = 5

/**
 * What to write after attempting one reminder.
 *
 * A FAILED send used to still mark the reminder as sent, so a template with
 * the wrong shape silently burned all three stages and delivered nothing —
 * and correcting the template did not help the carts already in flight.
 *
 * A failure now leaves the stage due so the next tick retries it, and only
 * gives up after MAX_SEND_ATTEMPTS so a permanently broken setup cannot loop
 * until the checkout ages out.
 */
export function reminderPatch(
  stage: number,
  result: { ok: boolean; error?: string; discountCode?: string },
  priorAttempts: number,
  now: () => string = () => new Date().toISOString()
): Record<string, unknown> {
  const attempts = priorAttempts + 1
  const consumed = result.ok || attempts >= MAX_SEND_ATTEMPTS

  const patch: Record<string, unknown> = {
    last_error: result.ok ? null : (result.error ?? 'Unknown error'),
    send_attempts: consumed ? 0 : attempts,
  }

  if (consumed) {
    patch.reminders_sent = stage
    patch[STAGE_COLUMNS[stage - 1]] = now()
    if (stage === 3) patch.status = 'done'
  }

  if (result.discountCode) patch.discount_code = result.discountCode
  return patch
}

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
    // Only a phone that was actually MESSAGED starts a cooldown. Counting
    // rows that never sent anything — no phone, opted out, or still waiting
    // for their first reminder — would suppress people who have heard
    // nothing from us at all.
    const { data: recent } = await db
      .from('checkout_recoveries')
      .select('phone')
      .eq('user_id', userId)
      .gte('created_at', since)
      .not('phone', 'is', null)
      .gte('reminders_sent', 1)
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
  // Oldest first: the carts closest to going cold get the batch's capacity.
  const { data: rows } = await db
    .from('checkout_recoveries')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: true })
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
      // One bad row must never take the rest of the sweep down with it — the
      // remaining carts would silently miss their window.
      try {
        if (!row.phone) {
          // Defensive: an active row without a phone can never be sent, and
          // leaving it active means re-examining it on every single sweep.
          await db.from('checkout_recoveries').update({ status: 'skipped_no_phone' }).eq('id', row.id)
          continue
        }

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

        await db
          .from('checkout_recoveries')
          .update({
            ...reminderPatch(stage, result, row.send_attempts ?? 0),
            // Linkage for the Carts page: which contact and thread this went to.
            ...(result.contactId ? { contact_id: result.contactId } : {}),
            ...(result.conversationId ? { conversation_id: result.conversationId } : {}),
          })
          .eq('id', row.id)

        if (result.ok) sent++
      } catch (e: any) {
        console.error('[recovery] row failed', row.id, e)
        await db
          .from('checkout_recoveries')
          .update({ last_error: `Sweep error: ${e?.message ?? e}` })
          .eq('id', row.id)
      }
    }
  }

  return { sent, stopped }
}

export async function sendReminder(
  db: any,
  userId: string,
  config: any,
  row: any,
  checkout: any,
  stage: number
): Promise<{
  ok: boolean
  error?: string
  discountCode?: string
  contactId?: string | null
  conversationId?: string | null
}> {
  /* ---------------- template selection by locale ---------------- */
  const es = config[`recovery_r${stage}_template_es`]
  const en = config[`recovery_r${stage}_template_en`]
  const prefersSpanish = (checkout.customer_locale ?? '').toLowerCase().startsWith('es')

  // Cross-language fallback: use whichever is set. Skip only if NEITHER is.
  const templateName = prefersSpanish ? es || en : en || es
  if (!templateName) return { ok: false, error: `No template set for reminder ${stage}` }

  // The CUSTOMER's preference, not a guess from which field held the name.
  // resolveApprovedTemplate() matches it exactly, then loosely, then falls
  // back — so a single template configured for everyone still resolves.
  const language = prefersSpanish ? 'es' : 'en'

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
  //
  // Whether to send that parameter is decided by the TEMPLATE, not by whether
  // we happen to have a link. A static button takes no parameter, and sending
  // one anyway is rejected for every recipient with #132012.
  const tpl = await resolveApprovedTemplate(userId, templateName, language)
  if (!tpl) return { ok: false, error: `Template "${templateName}" is not synced or not Approved` }

  const shape = templateShape(tpl.components)
  const suffix = urlSuffix(checkout.abandoned_checkout_url, discountCode)
  const wantsSuffix = shape.dynamicUrlButtons.length > 0

  const mismatch = paramMismatch(shape, vars, { urlSuffixes: wantsSuffix && suffix ? 1 : 0 })
  if (mismatch) return { ok: false, error: `Reminder ${stage} template "${templateName}": ${mismatch}` }

  const components: any[] = []
  if (vars.length) {
    components.push({ type: 'body', parameters: vars.map((t) => ({ type: 'text', text: t })) })
  }

  if (wantsSuffix && suffix) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(shape.dynamicUrlButtons[0]),
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

  let linkage: { contactId?: string | null; conversationId?: string | null } = {}

  if (res.ok) {
    linkage = await mirrorToThread(db, userId, row, checkout, templateName, res.wamid)
    await logActivity(db, userId, {
      kind: 'recovery',
      title: `Cart reminder ${stage} sent`,
      detail: discountCode ? `with code ${discountCode}` : undefined,
      contactId: linkage.contactId ?? row.contact_id ?? undefined,
      amount: Number(checkout.total_price ?? 0),
    })
  }

  return {
    ok: res.ok,
    error: res.ok ? undefined : res.error,
    discountCode,
    contactId: linkage.contactId ?? null,
    conversationId: linkage.conversationId ?? null,
  }
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
  // A recovery row can predate its contact — a backfilled cart, or one
  // captured before the phone arrived. Resolve it here through the SAME
  // matcher the inbound webhook uses, so the customer's reply lands in this
  // very thread instead of opening a second one.
  let contactId: string | null = row.contact_id ?? checkout.contact_id ?? null
  if (!contactId && row.phone) {
    const contact = await findOrCreateContact(db, userId, row.phone, {
      name: checkout.customer_name ?? null,
      email: checkout.customer_email ?? null,
      locale: checkout.customer_locale ?? null,
      source: 'shopify',
    })
    contactId = contact?.id ?? null
  }
  if (!contactId) return {}

  const conversationId = await findOrCreateConversation(db, userId, contactId)
  if (!conversationId) return { contactId }

  await db.from('messages').insert({
    user_id: userId,
    conversation_id: conversationId,
    contact_id: contactId,
    sender_type: 'bot',
    content_type: 'template',
    content: `Cart recovery reminder — ${formatMoney(checkout.total_price, checkout.currency)}`,
    template_name: templateName,
    message_id: wamid ?? null,
    status: wamid ? 'sent' : 'failed',
  })

  return { contactId, conversationId }
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

  const address = payload.shipping_address ?? payload.billing_address ?? {}
  const customerName =
    [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(' ') ||
    address.name ||
    [address.first_name, address.last_name].filter(Boolean).join(' ') ||
    null

  const row = {
    user_id: userId,
    shopify_checkout_id: shopifyCheckoutId,
    token: payload.token ?? null,
    contact_id: contactId,
    customer_name: customerName,
    customer_email: payload.customer?.email ?? payload.email ?? null,
    customer_phone: phone || null,
    customer_locale: payload.customer_locale ?? null,
    total_price: Number(payload.total_price ?? 0),
    currency: payload.currency ?? payload.presentment_currency ?? 'EUR',
    items_count: (payload.line_items ?? []).reduce((s: number, l: any) => s + (l.quantity ?? 0), 0),
    line_items: (payload.line_items ?? []).slice(0, 50).map((l: any) => ({
      title: l.title,
      quantity: l.quantity,
      price: l.price,
      variant_title: l.variant_title ?? null,
      sku: l.sku ?? null,
    })),
    abandoned_checkout_url: payload.abandoned_checkout_url ?? null,
    completed_at: payload.completed_at ?? null,
    // Conversion truth. Kept in step with completed_at so the UI can key the
    // "Recovered" badge off the checkout itself rather than a tracking row.
    recovered: !!payload.completed_at,
    // Shopify surfaces a checkout only once it is abandonment-eligible.
    abandoned_at: payload.created_at ?? null,
    raw: payload,
    source,
    shopify_created_at: payload.created_at ?? null,
    shopify_updated_at: payload.updated_at ?? null,
  }

  const { data, error } = await db
    .from('shopify_checkouts')
    .upsert(mergeWithStored(await storedCheckout(db, userId, shopifyCheckoutId), row), {
      onConflict: 'user_id,shopify_checkout_id',
    })
    .select('*')
    .single()

  // Throw, never swallow: an ignored error here marked the webhook delivery
  // "processed" while nothing was written, which is how an out-of-date
  // database (missing columns → PGRST204) looked exactly like success.
  if (error) {
    throw new Error(
      `Could not save checkout ${shopifyCheckoutId}: ${error.message}` +
        (String(error.code) === 'PGRST204'
          ? ' — the database is missing a column this version writes. Run supabase/schema.sql again (it is idempotent).'
          : '')
    )
  }

  // Row creation is the deliberate exception to "backfill never triggers":
  // creating history is safe, and sending stays gated on recovery_enabled.
  if (data) await ensureCheckoutRecovery(db, userId, data)

  return data
}

async function storedCheckout(db: any, userId: string, shopifyCheckoutId: string) {
  const { data } = await db
    .from('shopify_checkouts')
    .select('*')
    .eq('user_id', userId)
    .eq('shopify_checkout_id', shopifyCheckoutId)
    .maybeSingle()
  return data
}

/**
 * Merge an incoming mapping over what is already stored, without losing data.
 *
 * Two rules, both from the brief's source discipline:
 *
 * · A `backfill` never downgrades a row already marked `webhook`. Only live
 *   webhook data may trigger messaging elsewhere, so the stamp must not drift
 *   backwards just because a nightly reconcile touched the row.
 *
 * · A null never overwrites a stored value. The phone usually arrives on a
 *   LATER checkouts/update as the customer types it, and the REST backfill
 *   payload is thinner than the webhook one — so a plain upsert would blank
 *   out the very field the reminder depends on.
 */
export function mergeWithStored(stored: any | null, incoming: Record<string, any>): Record<string, any> {
  if (!stored) return incoming

  const merged: Record<string, any> = { ...incoming }

  for (const [key, value] of Object.entries(incoming)) {
    if (value == null && stored[key] != null) merged[key] = stored[key]
  }

  if (stored.source === 'webhook') merged.source = 'webhook'

  // Conversion is one-way: a thin backfill payload must not un-complete a
  // checkout the webhook already reported as paid.
  if (stored.completed_at && !incoming.completed_at) {
    merged.completed_at = stored.completed_at
    merged.recovered = true
  }
  if (stored.recovered) merged.recovered = true

  return merged
}
