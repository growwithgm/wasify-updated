import { sendWhatsApp, resolveApprovedTemplate } from '@/lib/whatsapp/send'
import { phonesMatch, sanitizePhone } from '@/lib/phone'
import { evaluateSegment } from './segments'
import { logActivity, notify } from '@/lib/contacts'

/**
 * Broadcast sender.
 *
 * Audience resolution honours consent: opted-out contacts and anyone on the
 * suppression list are marked `skipped` rather than silently dropped, so the
 * delivery report explains the gap between "audience" and "sent".
 */

const BATCH = 50 // recipients per cron pass, keeps us inside the lambda budget

export type VariableBinding = { kind: 'static' | 'contact_field' | 'custom_field'; value: string }

/** Resolve the audience into concrete recipient rows. */
export async function buildRecipients(db: any, userId: string, broadcast: any) {
  const audience = broadcast.audience ?? {}
  let contacts: any[] = []

  if (audience.mode === 'contacts' && audience.contact_ids?.length) {
    const { data } = await db
      .from('contacts')
      .select('id, phone, name, opt_in_status')
      .eq('user_id', userId)
      .in('id', audience.contact_ids)
    contacts = data ?? []
  } else if (audience.mode === 'tags' && audience.tag_ids?.length) {
    const { data: links } = await db
      .from('contact_tags')
      .select('contact_id')
      .eq('user_id', userId)
      .in('tag_id', audience.tag_ids)

    const ids = [...new Set((links ?? []).map((l: any) => l.contact_id))]
    if (ids.length) {
      const { data } = await db
        .from('contacts')
        .select('id, phone, name, opt_in_status')
        .eq('user_id', userId)
        .in('id', ids)
      contacts = data ?? []
    }
  } else if (audience.mode === 'segment' && audience.segment_id) {
    contacts = await evaluateSegment(db, userId, audience.segment_id)
  } else if (audience.mode === 'all') {
    const { data } = await db
      .from('contacts')
      .select('id, phone, name, opt_in_status')
      .eq('user_id', userId)
      .eq('is_blocked', false)
    contacts = data ?? []
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

  for (const recipient of queued) {
    const vars = recipient.contact_id
      ? await resolveVariables(db, userId, recipient.contact_id, bindings)
      : bindings.map((b) => (b.kind === 'static' ? b.value : ''))

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
              error_message: res.error,
              error_code: res.code ?? null,
              failed_at: new Date().toISOString(),
            }
      )
      .eq('id', recipient.id)
  }

  return queued.length
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
    const recipients = await buildRecipients(db, broadcast.user_id, broadcast)

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
