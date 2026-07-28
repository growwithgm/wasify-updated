import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { configByPhoneNumberId, fetchMediaUrl } from '@/lib/whatsapp/graph'
import { decrypt } from '@/lib/crypto'
import { hmacHex } from '@/lib/crypto'
import { sanitizePhone } from '@/lib/phone'
import { bumpConversation, findOrCreateContact, findOrCreateConversation, logActivity } from '@/lib/contacts'
import { runFlowForInbound } from '@/lib/engines/flows'
import { runAutomationsForInbound } from '@/lib/engines/automations'
import { runChatbotForInbound } from '@/lib/engines/chatbot'
import { handleCodReply } from '@/lib/engines/cod'
import { handleRecoveryOptOut } from '@/lib/engines/recovery'
import crypto from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/* ------------------------------------------------------------------ */
/* GET — Meta's subscription handshake                                 */
/* ------------------------------------------------------------------ */

/**
 * Meta sends the verify token the merchant typed into the App dashboard.
 * We don't know which tenant it belongs to yet, so match it against every
 * tenant's decrypted verify_token.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')

  if (mode !== 'subscribe' || !token || !challenge) {
    return new NextResponse('Bad Request', { status: 400 })
  }

  const db = createServiceClient()
  const { data } = await db.from('whatsapp_config').select('id, verify_token').not('verify_token', 'is', null)

  for (const row of data ?? []) {
    try {
      if (decrypt(row.verify_token) === token) {
        await db.from('whatsapp_config').update({ webhook_subscribed: true }).eq('id', row.id)
        return new NextResponse(challenge, { status: 200 })
      }
    } catch {
      /* unreadable token — skip this tenant */
    }
  }

  return new NextResponse('Forbidden', { status: 403 })
}

/* ------------------------------------------------------------------ */
/* POST — inbound messages + status callbacks                          */
/* ------------------------------------------------------------------ */

/** Forward-only ladder: a late 'sent' must never overwrite 'read'. */
const STATUS_RANK: Record<string, number> = {
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  replied: 4,
  failed: 5,
}

export async function POST(request: Request) {
  const started = Date.now()

  // Signature must be checked over the RAW bytes, before any parsing.
  const raw = await request.text()
  const signature = request.headers.get('x-hub-signature-256') ?? ''
  const appSecret = process.env.META_APP_SECRET

  // Fail CLOSED. An unverified webhook lets anyone who knows this URL inject
  // messages into a tenant's inbox, mark broadcasts read, or trigger COD
  // confirmations — so a missing secret must refuse traffic, not wave it through.
  if (!appSecret) {
    console.error('[wa-webhook] META_APP_SECRET is not set — refusing all webhook traffic')
    return new NextResponse('Webhook signature verification is not configured', { status: 503 })
  }

  const expected = `sha256=${hmacHex(appSecret, raw)}`
  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))

  if (!valid) return new NextResponse('Invalid signature', { status: 401 })

  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 })
  }

  const db = createServiceClient()

  // Vercel recycles the lambda the moment we respond, so all work is awaited.
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      try {
        await handleChange(db, change, started)
      } catch (e: any) {
        console.error('[wa-webhook] change failed', e)
        await db.from('whatsapp_webhook_events').insert({
          event_type: change.field ?? 'unknown',
          payload: change,
          status: 'failed',
          error: String(e?.message ?? e),
        })
      }
    }
  }

  return NextResponse.json({ received: true })
}

async function handleChange(db: any, change: any, started: number) {
  const value = change.value ?? {}
  const phoneNumberId = value.metadata?.phone_number_id

  // Template status updates arrive on a different field and carry no phone id.
  if (change.field === 'message_template_status_update') {
    await handleTemplateStatus(db, value)
    return
  }

  if (!phoneNumberId) return

  // Tenant routing FIRST — nothing else is safe to do before we know the owner.
  const config = await configByPhoneNumberId(phoneNumberId)
  if (!config) {
    await db.from('whatsapp_webhook_events').insert({
      event_type: change.field ?? 'messages',
      phone_number_id: phoneNumberId,
      payload: value,
      status: 'ignored',
      error: 'No tenant owns this phone_number_id',
    })
    return
  }

  const userId = config.user_id

  const { data: logRow } = await db
    .from('whatsapp_webhook_events')
    .insert({
      user_id: userId,
      event_type: value.statuses ? 'statuses' : 'messages',
      phone_number_id: phoneNumberId,
      payload: value,
      status: 'received',
    })
    .select('id')
    .single()

  if (value.statuses?.length) await handleStatuses(db, userId, value.statuses)
  if (value.messages?.length) {
    await handleMessages(db, userId, config, value.messages, value.contacts ?? [])
  }

  if (logRow) {
    await db
      .from('whatsapp_webhook_events')
      .update({ status: 'processed', duration_ms: Date.now() - started })
      .eq('id', logRow.id)
  }
}

/* ---------------------------- statuses ------------------------------ */

async function handleStatuses(db: any, userId: string, statuses: any[]) {
  for (const s of statuses) {
    const wamid = s.id
    const next = s.status as string
    if (!wamid || !next) continue

    const at = s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : new Date().toISOString()
    const errorMessage = s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? null
    const errorCode = s.errors?.[0]?.code ?? null

    /* messages — scoped by user_id so one tenant can never touch another's rows */
    const { data: msg } = await db
      .from('messages')
      .select('id, status')
      .eq('user_id', userId)
      .eq('message_id', wamid)
      .maybeSingle()

    if (msg && (STATUS_RANK[next] ?? -1) > (STATUS_RANK[msg.status] ?? -1)) {
      await db
        .from('messages')
        .update({
          status: next,
          ...(errorMessage ? { error_message: errorMessage, error_code: errorCode } : {}),
          ...(s.pricing
            ? {
                pricing_category: s.pricing.category ?? null,
                pricing_cost: s.pricing.billable === false ? 0 : null,
              }
            : {}),
        })
        .eq('id', msg.id)
    }

    /* broadcast recipients */
    const { data: recipient } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id')
      .eq('user_id', userId)
      .eq('message_id', wamid)
      .maybeSingle()

    if (recipient && (STATUS_RANK[next] ?? -1) > (STATUS_RANK[recipient.status] ?? -1)) {
      const patch: Record<string, unknown> = { status: next }
      if (next === 'delivered') patch.delivered_at = at
      if (next === 'read') patch.read_at = at
      if (next === 'failed') {
        patch.failed_at = at
        patch.error_message = errorMessage
        patch.error_code = errorCode
      }
      await db.from('broadcast_recipients').update(patch).eq('id', recipient.id)
    }
  }
}

/* ---------------------------- messages ------------------------------ */

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const

async function handleMessages(db: any, userId: string, config: any, messages: any[], contacts: any[]) {
  for (const m of messages) {
    const from = sanitizePhone(m.from)
    if (!from) continue

    const profileName = contacts.find((c: any) => sanitizePhone(c.wa_id) === from)?.profile?.name ?? null

    const contact = await findOrCreateContact(db, userId, from, {
      name: profileName,
      source: 'whatsapp',
    })
    if (!contact) continue

    const conversationId = await findOrCreateConversation(db, userId, contact.id)
    if (!conversationId) continue

    /* ---------- reactions are an edit of an existing message ---------- */
    if (m.type === 'reaction') {
      const { data: target } = await db
        .from('messages')
        .select('id')
        .eq('user_id', userId)
        .eq('message_id', m.reaction?.message_id)
        .maybeSingle()

      if (target && m.reaction?.emoji) {
        await db.from('message_reactions').upsert(
          { user_id: userId, message_id: target.id, emoji: m.reaction.emoji, by_type: 'customer' },
          { onConflict: 'message_id,emoji,by_type' }
        )
      }
      continue
    }

    /* ------------------------- normal message ------------------------ */
    let contentType = 'text'
    let content = ''
    let mediaUrl: string | null = null
    let mediaMime: string | null = null
    let mediaFilename: string | null = null
    let interactiveReplyId: string | null = null

    if (m.type === 'text') {
      content = m.text?.body ?? ''
    } else if (MEDIA_TYPES.includes(m.type)) {
      contentType = m.type === 'sticker' ? 'sticker' : m.type
      const media = m[m.type] ?? {}
      content = media.caption ?? ''
      mediaMime = media.mime_type ?? null
      mediaFilename = media.filename ?? null
      if (media.id) mediaUrl = await fetchMediaUrl(media.id, config.token)
    } else if (m.type === 'location') {
      contentType = 'location'
      const l = m.location ?? {}
      content = l.name || l.address || `${l.latitude}, ${l.longitude}`
    } else if (m.type === 'interactive') {
      contentType = 'interactive'
      const i = m.interactive ?? {}
      if (i.type === 'button_reply') {
        interactiveReplyId = i.button_reply?.id ?? null
        content = i.button_reply?.title ?? ''
      } else if (i.type === 'list_reply') {
        interactiveReplyId = i.list_reply?.id ?? null
        content = i.list_reply?.title ?? ''
      }
    } else if (m.type === 'button') {
      // Quick-reply tap on a template message.
      contentType = 'interactive'
      interactiveReplyId = m.button?.payload ?? null
      content = m.button?.text ?? ''
    } else {
      content = `[${m.type}]`
    }

    const createdAt = m.timestamp
      ? new Date(Number(m.timestamp) * 1000).toISOString()
      : new Date().toISOString()

    // Resolve a quoted message to our own row id, if we have it.
    let replyTo: string | null = null
    if (m.context?.id) {
      const { data: quoted } = await db
        .from('messages')
        .select('id')
        .eq('user_id', userId)
        .eq('message_id', m.context.id)
        .maybeSingle()
      replyTo = quoted?.id ?? null
    }

    const { error: insertError } = await db.from('messages').insert({
      user_id: userId,
      conversation_id: conversationId,
      contact_id: contact.id,
      sender_type: 'customer',
      sender_name: profileName,
      content_type: contentType,
      content,
      media_url: mediaUrl,
      media_mime: mediaMime,
      media_filename: mediaFilename,
      message_id: m.id,
      reply_to_message_id: replyTo,
      interactive_reply_id: interactiveReplyId,
      status: 'delivered',
      created_at: createdAt,
    })

    // Duplicate wamid = Meta retry. The unique index makes this a clean no-op.
    if (insertError && insertError.code === '23505') continue

    await bumpConversation(db, conversationId, {
      text: content || `[${contentType}]`,
      at: createdAt,
      inbound: true,
    })

    // A reply from a broadcast recipient flips them to "replied".
    await markBroadcastReplied(db, userId, contact.id)

    /* ------------------------- dispatch chain ------------------------ */
    // Each handler is independent: one throwing must not stop the others.
    const ctx = {
      db,
      userId,
      contactId: contact.id,
      conversationId,
      phone: contact.phone,
      text: content,
      interactiveReplyId,
    }

    let consumedByFlow = false
    try {
      consumedByFlow = await runFlowForInbound(ctx)
    } catch (e) {
      console.error('[wa-webhook] flow runner failed', e)
    }

    if (!consumedByFlow) {
      try {
        await runAutomationsForInbound(ctx)
      } catch (e) {
        console.error('[wa-webhook] automations failed', e)
      }

      try {
        await runChatbotForInbound(ctx)
      } catch (e) {
        console.error('[wa-webhook] chatbot failed', e)
      }
    }

    try {
      await handleCodReply(ctx)
    } catch (e) {
      console.error('[wa-webhook] COD reply handler failed', e)
    }

    try {
      await handleRecoveryOptOut(ctx)
    } catch (e) {
      console.error('[wa-webhook] recovery opt-out handler failed', e)
    }

    await logActivity(db, userId, {
      kind: 'message',
      title: `${profileName || `+${contact.phone}`} sent a message`,
      detail: content.slice(0, 80),
      contactId: contact.id,
    })
  }
}

async function markBroadcastReplied(db: any, userId: string, contactId: string) {
  const { data: rows } = await db
    .from('broadcast_recipients')
    .select('id, status')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .in('status', ['sent', 'delivered', 'read'])
    .order('created_at', { ascending: false })
    .limit(5)

  for (const r of rows ?? []) {
    await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', r.id)
  }
}

/* ---------------------- template status update ---------------------- */

async function handleTemplateStatus(db: any, value: any) {
  const name = value.message_template_name
  const language = value.message_template_language
  const event = (value.event ?? '').toUpperCase()
  if (!name) return

  const status =
    event === 'APPROVED' ? 'APPROVED' : event === 'REJECTED' ? 'REJECTED' : event === 'PAUSED' ? 'PAUSED' : null
  if (!status) return

  let query = db.from('message_templates').update({
    status,
    rejected_reason: value.reason ?? null,
    ...(status === 'APPROVED' ? { approved_at: new Date().toISOString() } : {}),
  })

  query = query.eq('name', name)
  if (language) query = query.eq('language', language)

  const { data: updated } = await query.select('user_id, name')

  for (const row of updated ?? []) {
    await db.from('notifications').insert({
      user_id: row.user_id,
      kind: status === 'APPROVED' ? 'success' : 'warning',
      text: `Template "${row.name}" was ${status.toLowerCase()} by Meta`,
      link: '/templates',
    })
  }
}
