import { sendWhatsApp, resolveApprovedTemplate, refreshTemplateFromMeta } from '@/lib/whatsapp/send'
import { phonesMatch, sanitizePhone } from '@/lib/phone'
import { evaluateSegment } from './segments'
import { logActivity, notify } from '@/lib/contacts'
import {
  templateShape,
  paramMismatch,
  explainMetaError,
  namedVariables,
} from '@/lib/whatsapp/template-params'
import { chunk } from '@/lib/contacts-import'
import { allPages } from '@/lib/db-pages'

/**
 * Broadcast sender.
 *
 * Audience resolution honours consent: opted-out contacts and anyone on the
 * suppression list are marked `skipped` rather than silently dropped, so the
 * delivery report explains the gap between "audience" and "sent".
 */

const BATCH = 50 // recipients per cron pass, keeps us inside the lambda budget

export type VariableBinding = { kind: 'static' | 'contact_field' | 'custom_field'; value: string }

/**
 * Why this broadcast cannot send, or null if it can — checked against a
 * FRESH copy of the template pulled from Meta moments before.
 *
 * Broadcasts fill body variables and nothing else, so any template demanding
 * more — a media header, a header variable, a dynamic URL or coupon button,
 * named {{variables}} — has to be refused HERE, by name. Letting it through
 * means Meta rejects every single recipient with #131008 and the report is
 * 809 identical red rows.
 */
export async function broadcastShapeProblem(broadcast: any): Promise<string | null> {
  await refreshTemplateFromMeta(broadcast.user_id, broadcast.template_name)

  const tpl = await resolveApprovedTemplate(
    broadcast.user_id,
    broadcast.template_name,
    broadcast.template_language
  )
  if (!tpl) {
    return `Template "${broadcast.template_name}" is not Approved on Meta (it may have been edited or deleted). Run Templates → Sync from Meta.`
  }

  const components: any[] = Array.isArray(tpl.components) ? tpl.components : []
  const texts = components
    .flatMap((c: any) => [c?.text, ...((c?.buttons ?? []).map((b: any) => b?.url) ?? [])])
    .filter(Boolean)
  const named = [...new Set(texts.flatMap((t: string) => namedVariables(t)))]
  if (named.length) {
    return `This template uses NAMED variables ({{${named[0]}}}) which broadcasts cannot fill — recreate it on Meta with numbered variables ({{1}}, {{2}}).`
  }

  const bindings = broadcast.variable_map?.body ?? []
  return paramMismatch(templateShape(tpl.components), Array(bindings.length).fill('x'))
}

/** Resolve the audience into concrete recipient rows. */
export async function buildRecipients(db: any, userId: string, broadcast: any) {
  const audience = broadcast.audience ?? {}
  let contacts: any[] = []

  if (audience.mode === 'contacts' && audience.contact_ids?.length) {
    // Batched: hundreds of ids in one .in() overflow the request URL.
    for (const part of chunk(audience.contact_ids as string[], 100)) {
      const { data, error } = await db
        .from('contacts')
        .select('id, phone, name, opt_in_status')
        .eq('user_id', userId)
        .in('id', part)
      if (error) throw new Error(`Audience query failed: ${error.message}`)
      contacts.push(...(data ?? []))
    }
  } else if (audience.mode === 'tags' && audience.tag_ids?.length) {
    // Join, don't enumerate: collecting the tagged contact ids and passing
    // them back via .in('id', [...]) built a ~30 KB URL for a tag on 800
    // contacts, which the API rejected — and the wizard read that as an
    // audience of zero.
    contacts = await allPages((from, to) =>
      db
        .from('contacts')
        .select('id, phone, name, opt_in_status, tag_filter:contact_tags!inner(tag_id)')
        .eq('user_id', userId)
        .in('tag_filter.tag_id', audience.tag_ids)
        .order('id')
        .range(from, to)
    )
  } else if (audience.mode === 'segment' && audience.segment_id) {
    contacts = await evaluateSegment(db, userId, audience.segment_id)
  } else if (audience.mode === 'all') {
    contacts = await allPages((from, to) =>
      db
        .from('contacts')
        .select('id, phone, name, opt_in_status')
        .eq('user_id', userId)
        .eq('is_blocked', false)
        .order('id')
        .range(from, to)
    )
  }

  // Suppression list wins over everything.
  const { data: suppressed } = await db.from('suppression_list').select('phone').eq('user_id', userId)
  const suppressedPhones = (suppressed ?? []).map((s: any) => s.phone)

  return contacts.map((c) => {
    const isSuppressed =
      c.opt_in_status === 'opted_out' || suppressedPhones.some((p: string) => phonesMatch(p, c.phone))
    return {
      user_id: userId,
      broadcast_id: broadcast.id,
      contact_id: c.id,
      phone: sanitizePhone(c.phone),
      name: c.name,
      status: isSuppressed ? 'skipped' : 'queued',
      error_message: isSuppressed ? 'Contact opted out of marketing' : null,
    }
  })
}

/** Fill {{n}} for one contact from the broadcast's variable map. */
export async function resolveVariables(
  db: any,
  userId: string,
  contactId: string,
  bindings: VariableBinding[]
): Promise<string[]> {
  if (!bindings?.length) return []

  const needsContact = bindings.some((b) => b.kind === 'contact_field')
  const needsCustom = bindings.some((b) => b.kind === 'custom_field')

  const contact = needsContact
    ? (await db.from('contacts').select('*').eq('id', contactId).maybeSingle()).data
    : null

  let customValues: Record<string, string> = {}
  if (needsCustom) {
    const { data } = await db
      .from('contact_custom_values')
      .select('value, custom_fields:custom_field_id (key)')
      .eq('contact_id', contactId)
    for (const row of data ?? []) {
      const key = (row as any).custom_fields?.key
      if (key) customValues[key] = row.value ?? ''
    }
  }

  return bindings.map((b) => {
    if (b.kind === 'static') return b.value ?? ''
    if (b.kind === 'custom_field') return customValues[b.value] ?? ''
    const raw = contact?.[b.value]
    if (b.value === 'first_name') return (contact?.name ?? '').split(' ')[0] || ''
    return raw != null ? String(raw) : ''
  })
}

/** Send one batch of a broadcast. Returns how many were attempted. */
export async function sendBroadcastBatch(db: any, broadcast: any): Promise<number> {
  const userId = broadcast.user_id

  const tpl = await resolveApprovedTemplate(userId, broadcast.template_name, broadcast.template_language)
  if (!tpl) {
    await db
      .from('broadcasts')
      .update({ status: 'failed', completed_at: new Date().toISOString() })
      .eq('id', broadcast.id)
    await notify(
      db,
      userId,
      'error',
      `Broadcast "${broadcast.name}" failed: template is not Approved`,
      '/broadcasts'
    )
    return 0
  }

  const { data: queued } = await db
    .from('broadcast_recipients')
    .select('id, contact_id, phone')
    .eq('broadcast_id', broadcast.id)
    .eq('status', 'queued')
    .limit(BATCH)

  if (!queued?.length) {
    await db
      .from('broadcasts')
      .update({ status: 'sent', completed_at: new Date().toISOString() })
      .eq('id', broadcast.id)

    await logActivity(db, userId, {
      kind: 'broadcast',
      title: `Broadcast "${broadcast.name}" finished`,
    })
    return 0
  }

  const bindings: VariableBinding[] = broadcast.variable_map?.body ?? []
  const shape = templateShape(tpl.components)

  // A shape mismatch is the same for every recipient, so check it against the
  // template ONCE. Without this the run marches through the whole audience
  // collecting an identical #132012 per person.
  const structural = paramMismatch(shape, Array(bindings.length).fill('x'))
  if (structural) {
    await db
      .from('broadcasts')
      .update({ status: 'failed', completed_at: new Date().toISOString() })
      .eq('id', broadcast.id)
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: structural, error_code: '132012' })
      .eq('broadcast_id', broadcast.id)
      .eq('status', 'queued')
    await notify(db, userId, 'error', `Broadcast "${broadcast.name}" failed: ${structural}`, '/broadcasts')
    return 0
  }

  // Shape-family rejections (#131008/#132000/#132012/#132001) are identical
  // for every recipient — the template itself disagrees with what we send.
  // After a few in a row, marching on just paints hundreds of identical red
  // rows, so the run trips a breaker instead.
  const SHAPE_CODES = new Set(['131008', '132000', '132001', '132012'])
  let shapeFailStreak = 0

  for (const recipient of queued) {
    // Consent is re-read here, not just when the audience was built. A large
    // broadcast drains over many cron passes, and someone who replies STOP
    // mid-run must not receive the rest of it.
    if (recipient.contact_id && (await hasOptedOut(db, userId, recipient.contact_id, recipient.phone))) {
      await db
        .from('broadcast_recipients')
        .update({ status: 'skipped', error_message: 'Contact opted out of marketing' })
        .eq('id', recipient.id)
      continue
    }

    const vars = recipient.contact_id
      ? await resolveVariables(db, userId, recipient.contact_id, bindings)
      : bindings.map((b) => (b.kind === 'static' ? b.value : ''))

    // Per-recipient values can still come back blank — a contact_field binding
    // on someone with no first name, say. Meta rejects a blank parameter, so
    // skip that person rather than burning a send that cannot succeed.
    const perRecipient = paramMismatch(shape, vars)
    if (perRecipient) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: perRecipient,
          error_code: '132012',
          failed_at: new Date().toISOString(),
        })
        .eq('id', recipient.id)
      continue
    }

    const res = await sendWhatsApp(userId, recipient.phone, {
      kind: 'template',
      name: tpl.name,
      language: tpl.language,
      components: vars.length
        ? [{ type: 'body', parameters: vars.map((t) => ({ type: 'text' as const, text: t })) }]
        : undefined,
    })

    await db
      .from('broadcast_recipients')
      .update(
        res.ok
          ? { status: 'sent', message_id: res.wamid, sent_at: new Date().toISOString() }
          : {
              status: 'failed',
              error_message: explainMetaError(res.error, res.code),
              error_code: res.code ?? null,
              failed_at: new Date().toISOString(),
            }
      )
      .eq('id', recipient.id)

    if (!res.ok && SHAPE_CODES.has(String(res.code))) {
      if (++shapeFailStreak >= 5) {
        const reason = explainMetaError(res.error, res.code)
        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: `Stopped — the first sends all failed the same way: ${reason}`,
            error_code: String(res.code),
          })
          .eq('broadcast_id', broadcast.id)
          .eq('status', 'queued')
        await db
          .from('broadcasts')
          .update({ status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', broadcast.id)
        await notify(db, userId, 'error', `Broadcast "${broadcast.name}" stopped: ${reason}`, '/broadcasts')
        return queued.length
      }
    } else if (res.ok) {
      shapeFailStreak = 0
    }
  }

  return queued.length
}

/** Consent as of right now — contact flag or suppression list. */
async function hasOptedOut(db: any, userId: string, contactId: string, phone: string): Promise<boolean> {
  const { data: contact } = await db
    .from('contacts')
    .select('opt_in_status')
    .eq('id', contactId)
    .maybeSingle()
  if (contact?.opt_in_status === 'opted_out') return true

  const { data: suppressed } = await db.from('suppression_list').select('phone').eq('user_id', userId)
  return (suppressed ?? []).some((s: any) => phonesMatch(s.phone, phone))
}

/** Called by the cron tick: start scheduled broadcasts and drain sending ones. */
export async function sendDueBroadcasts(db: any): Promise<{ started: number; sent: number }> {
  const now = new Date().toISOString()
  let started = 0
  let sent = 0

  /* ---- promote scheduled → sending ---- */
  const { data: due } = await db
    .from('broadcasts')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now)
    .limit(10)

  for (const broadcast of due ?? []) {
    // Last call before real money and real quality rating: check the shape
    // against a template freshly pulled from Meta. Edited-since-sync is
    // caught here, not 809 times in the delivery report.
    const problem = await broadcastShapeProblem(broadcast)
    if (problem) {
      await db.from('broadcasts').update({ status: 'failed', completed_at: now }).eq('id', broadcast.id)
      await notify(db, broadcast.user_id, 'error', `Broadcast "${broadcast.name}" failed: ${problem}`, '/broadcasts')
      continue
    }

    // One broadcast whose audience cannot be resolved must fail LOUDLY and
    // ALONE — marked failed with a notification, while the rest still go out.
    let recipients: Awaited<ReturnType<typeof buildRecipients>>
    try {
      recipients = await buildRecipients(db, broadcast.user_id, broadcast)
    } catch (e: any) {
      console.error('[broadcasts] audience failed', broadcast.id, e)
      await db
        .from('broadcasts')
        .update({ status: 'failed', completed_at: now })
        .eq('id', broadcast.id)
      await notify(
        db,
        broadcast.user_id,
        'error',
        `Broadcast "${broadcast.name}" failed: ${e?.message ?? 'could not resolve the audience'}`,
        '/broadcasts'
      )
      continue
    }

    if (recipients.length) {
      // Chunked so a large audience does not blow the statement size.
      for (let i = 0; i < recipients.length; i += 500) {
        await db
          .from('broadcast_recipients')
          .upsert(recipients.slice(i, i + 500), { onConflict: 'broadcast_id,phone', ignoreDuplicates: true })
      }
    }

    await db
      .from('broadcasts')
      .update({ status: 'sending', started_at: now })
      .eq('id', broadcast.id)
    started++
  }

  /* ---- drain sending ---- */
  const { data: sending } = await db.from('broadcasts').select('*').eq('status', 'sending').limit(5)

  for (const broadcast of sending ?? []) {
    sent += await sendBroadcastBatch(db, broadcast)
  }

  return { started, sent }
}
