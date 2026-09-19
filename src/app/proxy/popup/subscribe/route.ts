import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { normalizeShopDomain } from '@/app/api/shopify/connect/route'
import { verifyProxySignature } from '@/lib/flow/stock-alerts'
import { toMetaPhone } from '@/lib/flow/order-confirmation'
import { makeRateLimiter, requestIp } from '@/lib/rate-limit'
import { findOrCreateContact, findOrCreateConversation, logActivity } from '@/lib/contacts'
import { generateDiscountCodeForContact } from '@/lib/engines/discounts'
import { sendTemplate, resolveApprovedTemplate } from '@/lib/whatsapp/send'
import { templateShape, explainMetaError } from '@/lib/whatsapp/template-params'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Popup submit — where the MARKETING opt-in is born.
 *
 * Ordered writes, consent first. consent_events.contact_id is NOT NULL, so
 * the contact row (pure identity, no marketing state) is created as a
 * prerequisite; the CONSENT RECORD is the first thing written after it, and
 * only then the opt-in flags, the discount and the send. A discount or
 * WhatsApp failure after that point returns a CLEAR error — the consent
 * stays saved, and nothing pretends to be success.
 *
 * The consent record stores the exact text the visitor saw (echoed by the
 * client, because the admin can edit the text between page load and
 * submit), the page URL, the IP and the number.
 */

const rateLimited = makeRateLimiter(5, 10 * 60 * 1000)

type Body = {
  name?: string
  phone?: string
  country_code?: string
  locale?: string
  hp?: string
  path?: string
  page_url?: string
  consent_text?: string
  consent_checked?: boolean
}

export async function POST(request: Request) {
  const secret = process.env.SHOPIFY_PROXY_SECRET || process.env.SHOPIFY_CLIENT_SECRET
  if (!secret) return new NextResponse('Proxy secret is not configured', { status: 503 })

  const url = new URL(request.url)
  if (!verifyProxySignature(url.searchParams, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const shop = normalizeShopDomain(url.searchParams.get('shop') ?? '')
  if (!shop) return NextResponse.json({ error: 'shop is required' }, { status: 400 })

  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Honeypot: answer exactly like success so the bot learns nothing.
  if ((body.hp ?? '').trim()) return NextResponse.json({ ok: true })

  const ip = requestIp(request)
  if (rateLimited(ip)) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  // No ticked box, no consent — the server enforces it, not just the UI.
  if (body.consent_checked !== true) {
    return NextResponse.json({ error: 'Please tick the consent box first' }, { status: 400 })
  }

  const phone = toMetaPhone(body.phone, body.country_code)
  if (!phone) {
    return NextResponse.json(
      { error: 'That phone number doesn’t look right — include your country code' },
      { status: 400 }
    )
  }

  const db = createServiceClient()

  const { data: config } = await db
    .from('shopify_config')
    .select('user_id, popup_consent_text, popup_discount_id, popup_template')
    .eq('store_domain', shop)
    .maybeSingle()
  if (!config) return NextResponse.json({ error: 'Unknown shop' }, { status: 400 })

  const userId = config.user_id

  /* 1 — identity (no marketing state yet) */
  const contact = await findOrCreateContact(db, userId, phone, {
    name: (body.name ?? '').trim() || null,
    locale: (body.locale ?? '').slice(0, 8) || null,
    source: 'popup',
  })
  if (!contact) {
    return NextResponse.json({ error: 'Could not save your details — try again' }, { status: 500 })
  }

  /* 2 — THE consent record, before anything marketing happens */
  const { error: consentError } = await db.from('consent_events').insert({
    user_id: userId,
    contact_id: contact.id,
    event: 'opt_in',
    source: 'popup',
    phone,
    consent_text: (body.consent_text ?? '').trim() || config.popup_consent_text || null,
    page_url: (body.page_url ?? '').slice(0, 2048) || null,
    ip,
    detail: body.path ?? null,
  })
  if (consentError) {
    // Without the consent record nothing else may proceed.
    return NextResponse.json({ error: `Could not record consent: ${consentError.message}` }, { status: 500 })
  }

  /* 3 — opt-in state + explicit re-opt-in clears an old suppression */
  await db
    .from('contacts')
    .update({
      opt_in_status: 'opted_in',
      opt_in_at: new Date().toISOString(),
      opt_in_source: 'popup',
      accepts_marketing: true,
    })
    .eq('id', contact.id)

  // A fresh, explicit opt-in outranks an old STOP — the consent_events row
  // above is the audit trail for this deletion.
  await db.from('suppression_list').delete().eq('user_id', userId).eq('phone', phone)

  // Submit counted the moment consent is saved — send failures below don't
  // un-count a real signup.
  await db.from('popup_events').insert({ user_id: userId, event: 'submit', path: body.path ?? null })

  /* 4 — discount (optional) */
  let code: string | null = null
  if (config.popup_discount_id) {
    try {
      code = await generateDiscountCodeForContact(db, userId, config.popup_discount_id, contact.id)
    } catch (e: any) {
      console.error('[popup] discount failed', e)
    }
    if (!code) {
      return NextResponse.json(
        { error: 'You are subscribed, but the discount code could not be created — please try again in a moment' },
        { status: 502 }
      )
    }
  }

  /* 5 — WhatsApp send (optional: only when a template is configured) */
  if ((config.popup_template ?? '').trim()) {
    const tpl = await resolveApprovedTemplate(userId, config.popup_template)
    if (!tpl) {
      return NextResponse.json(
        { error: 'You are subscribed, but the welcome message could not be sent' },
        { status: 502 }
      )
    }

    const shape = templateShape(tpl.components)
    if (shape.bodyVars > 1 || (shape.bodyVars === 1 && !code)) {
      // Misconfigured template — subscription stands, message cannot.
      return NextResponse.json(
        { error: 'You are subscribed, but the welcome message could not be sent' },
        { status: 502 }
      )
    }

    const components: any[] = []
    if (shape.bodyVars === 1 && code) {
      components.push({ type: 'body', parameters: [{ type: 'text', text: code }] })
    }
    // The coupon button carries the PER-CONTACT code — supplied explicitly,
    // so sendTemplate's auto-fill (the template's sample code) stays out.
    for (const index of shape.copyCodeButtons) {
      if (code) {
        components.push({
          type: 'button',
          sub_type: 'copy_code',
          index: String(index),
          parameters: [{ type: 'coupon_code', coupon_code: code }],
        })
      }
    }

    const res = await sendTemplate(userId, phone, tpl.name, components.length ? components : undefined)
    if (!res.ok) {
      console.error('[popup] send failed', explainMetaError(res.error, res.code))
      return NextResponse.json(
        { error: 'You are subscribed, but the WhatsApp message failed to send' },
        { status: 502 }
      )
    }

    // Mirror into the inbox thread, like every other outbound.
    try {
      const conversationId = await findOrCreateConversation(db, userId, contact.id)
      if (conversationId) {
        await db.from('messages').insert({
          user_id: userId,
          conversation_id: conversationId,
          contact_id: contact.id,
          sender_type: 'bot',
          content_type: 'template',
          content: code ? `Popup welcome — code ${code}` : 'Popup welcome message',
          template_name: tpl.name,
          message_id: res.wamid ?? null,
          status: 'sent',
        })
      }
    } catch (e) {
      console.error('[popup] mirror failed', e)
    }
  }

  await logActivity(db, userId, {
    kind: 'system',
    title: 'Popup signup — WhatsApp marketing opt-in',
    detail: code ? `code ${code}` : undefined,
    contactId: contact.id,
  })

  return NextResponse.json({ ok: true, code })
}
