import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { safeEqual } from '@/lib/crypto'
import { sendWhatsApp, resolveApprovedTemplate } from '@/lib/whatsapp/send'
import { templateShape, paramMismatch } from '@/lib/whatsapp/template-params'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/contacts'
import { normalizeShopDomain } from '@/app/api/shopify/connect/route'
import { siteUrlStatus } from '@/lib/site-url'
import { makeCode, toMetaPhone, formatOrderTotal } from '@/lib/flow/order-confirmation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Order-confirmation WhatsApp message, driven by Shopify Flow.
 *
 * Flow's "Send HTTP request" action calls this on Order created. It is NOT a
 * webhook (no HMAC to verify) — authentication is a bearer secret, same
 * timing-safe comparison the cron routes use.
 *
 * The one rule that shapes every response here: **Shopify Flow retries any
 * non-2xx.** So conditions that will be exactly as true on the fifth attempt
 * — invalid phone, duplicate order, feature switched off — answer 200 with a
 * `skipped` reason instead of an error. Only misconfiguration (missing
 * secret) and genuinely transient failures return non-2xx.
 */
export async function POST(request: Request) {
  const secret = process.env.FLOW_SECRET
  if (!secret) {
    // Fail closed, same as the webhooks: without the secret, anyone who
    // guesses the URL could make the store message arbitrary numbers.
    console.error('[flow-orderconf] FLOW_SECRET is not set — refusing all traffic')
    return new NextResponse('FLOW_SECRET is not configured', { status: 503 })
  }

  const auth = request.headers.get('authorization') ?? ''
  if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    order_id?: string | number
    order_name?: string
    first_name?: string
    phone?: string
    total?: string | number
    currency?: string
    status_url?: string
    shop?: string
    country_code?: string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const orderId = body.order_id != null ? String(body.order_id) : ''
  const shop = normalizeShopDomain(body.shop ?? '')
  if (!orderId || !shop || !body.status_url) {
    return NextResponse.json({ error: 'order_id, shop and status_url are required' }, { status: 400 })
  }

  const db = createServiceClient()

  // Tenant routing by store domain — the same key the webhook uses.
  const { data: config } = await db
    .from('shopify_config')
    .select('user_id, orderconf_enabled, orderconf_template, orderconf_language')
    .eq('store_domain', shop)
    .maybeSingle()

  if (!config) return NextResponse.json({ skipped: 'unknown_shop' })
  if (!config.orderconf_enabled) return NextResponse.json({ skipped: 'disabled' })

  const phone = toMetaPhone(body.phone, body.country_code)
  if (!phone) return NextResponse.json({ skipped: 'invalid_phone' })

  /* ------------------------- short link, deduped ---------------------- */
  const code = makeCode()
  const { error: linkError } = await db.from('order_links').insert({
    code,
    user_id: config.user_id,
    order_id: orderId,
    shop,
    status_url: body.status_url,
  })

  // 23505 on (shop, order_id): this order was already handled — a Flow retry
  // or double-fire. The dedupe IS the success path.
  if (linkError) {
    if (String(linkError.code) === '23505') return NextResponse.json({ skipped: 'duplicate' })
    return NextResponse.json({ error: linkError.message }, { status: 500 })
  }

  /* ------------------------------ send -------------------------------- */
  const tpl = await resolveApprovedTemplate(config.user_id, config.orderconf_template, config.orderconf_language)
  if (!tpl) {
    // A missing template is config, not weather — retrying cannot fix it.
    return NextResponse.json({
      skipped: 'template_not_approved',
      error: `Template "${config.orderconf_template}" is not synced or not Approved`,
    })
  }

  const firstName = (body.first_name ?? '').trim() || 'cliente'
  const vars = [firstName, body.order_name ?? `#${orderId}`, formatOrderTotal(body.total, body.currency)]

  const shape = templateShape(tpl.components)
  const mismatch = paramMismatch(shape, vars, { urlSuffixes: shape.dynamicUrlButtons.length ? 1 : 0 })
  if (mismatch) {
    return NextResponse.json({ skipped: 'template_mismatch', error: mismatch })
  }

  const components: any[] = [
    { type: 'body', parameters: vars.map((t) => ({ type: 'text' as const, text: t })) },
  ]
  if (shape.dynamicUrlButtons.length) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(shape.dynamicUrlButtons[0]),
      parameters: [{ type: 'text', text: code }],
    })
  }

  const res = await sendWhatsApp(config.user_id, phone, {
    kind: 'template',
    name: tpl.name,
    language: tpl.language,
    components,
  })

  if (!res.ok) {
    // Send failures can be transient (rate limit, Meta hiccup) — a non-2xx
    // here is the one place a Flow retry genuinely helps. Free the dedupe
    // row first, or every retry would bounce off 23505 as "duplicate".
    await db.from('order_links').delete().eq('code', code)
    return NextResponse.json({ error: res.error, code: res.code ?? null }, { status: 502 })
  }

  /* ------------------- mirror into the inbox thread ------------------- */
  // Same rule as COD and recovery: every outbound lands in the conversation,
  // so the customer's reply has a thread to arrive in.
  try {
    const contact = await findOrCreateContact(db, config.user_id, phone, {
      name: firstName === 'cliente' ? null : firstName,
      source: 'shopify',
    })
    if (contact) {
      const conversationId = await findOrCreateConversation(db, config.user_id, contact.id)
      if (conversationId) {
        await db.from('messages').insert({
          user_id: config.user_id,
          conversation_id: conversationId,
          contact_id: contact.id,
          sender_type: 'bot',
          content_type: 'template',
          content: `Order confirmation — ${body.order_name ?? orderId}`,
          template_name: tpl.name,
          message_id: res.wamid ?? null,
          status: 'sent',
        })
      }
    }
  } catch (e) {
    // The message reached the customer; a mirror failure must not fail Flow.
    console.error('[flow-orderconf] mirror failed', e)
  }

  const site = siteUrlStatus()
  return NextResponse.json({
    sent: true,
    code,
    link: site.ok ? `${site.url}/o/${code}` : `/o/${code}`,
  })
}
