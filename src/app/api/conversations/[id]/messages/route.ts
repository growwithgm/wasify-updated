import { withAuth, jsonBody, badRequest, notFound } from '@/lib/api'
import { sendWhatsApp, resolveApprovedTemplate, type TemplateComponent } from '@/lib/whatsapp/send'
import { canSendFreeText } from '@/lib/window'
import { bumpConversation } from '@/lib/contacts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** Thread messages, oldest first. */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase }) => {
    const url = new URL(request.url)
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 200))

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) badRequest(error.message)
    return { messages: (data ?? []).reverse() }
  })
}

/**
 * Send a message (or record an internal note).
 *
 * Free text is refused outside the 24h window — the guard lives here so the
 * UI cannot bypass it by crafting a request.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<{
      kind?: 'text' | 'template' | 'note'
      body?: string
      template_name?: string
      template_language?: string
      variables?: string[]
      button_url_suffix?: string
      reply_to?: string
    }>(request)

    const kind = body.kind ?? 'text'

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, contact_id, last_inbound_at, contacts:contact_id (phone, name)')
      .eq('id', id)
      .maybeSingle()

    if (!conv) notFound('Conversation not found')

    const contact = conv.contacts as any
    const phone: string = contact?.phone ?? ''
    const now = new Date().toISOString()

    /* -------------------------- internal note -------------------------- */
    if (kind === 'note') {
      const text = (body.body ?? '').trim()
      if (!text) badRequest('The note is empty')

      const { data: agent } = await supabase
        .from('agents')
        .select('name')
        .eq('is_self', true)
        .maybeSingle()

      const { data: inserted, error } = await supabase
        .from('messages')
        .insert({
          user_id: userId,
          conversation_id: id,
          contact_id: conv.contact_id,
          sender_type: 'agent',
          sender_name: agent?.name ?? 'You',
          content_type: 'note',
          content: text,
          status: 'sent',
          is_internal_note: true,
        })
        .select('*')
        .single()

      if (error) badRequest(error.message)
      // Notes are internal: they must not move last_message_* or the window.
      return { message: inserted }
    }

    if (!phone) badRequest('This contact has no phone number')

    /* ----------------------------- free text ---------------------------- */
    if (kind === 'text') {
      const text = (body.body ?? '').trim()
      if (!text) badRequest('The message is empty')

      if (!canSendFreeText(conv.last_inbound_at)) {
        badRequest(
          'The 24-hour window has expired — send an approved template to re-open this conversation.',
          { code: 'window_expired' }
        )
      }

      // Optimistic row first so the thread updates instantly, then reconcile.
      const { data: pending, error: insertError } = await supabase
        .from('messages')
        .insert({
          user_id: userId,
          conversation_id: id,
          contact_id: conv.contact_id,
          sender_type: 'agent',
          content_type: 'text',
          content: text,
          status: 'sending',
          reply_to_message_id: body.reply_to ?? null,
        })
        .select('*')
        .single()

      if (insertError) badRequest(insertError.message)

      const result = await sendWhatsApp(userId, phone, { kind: 'text', body: text })

      if (!result.ok) {
        await supabase
          .from('messages')
          .update({ status: 'failed', error_message: result.error, error_code: result.code ?? null })
          .eq('id', pending.id)
        badRequest(result.error, { code: 'send_failed', message_id: pending.id })
      }

      await supabase
        .from('messages')
        .update({ status: 'sent', message_id: result.wamid })
        .eq('id', pending.id)

      await bumpConversation(supabase, id, { text, at: now, inbound: false })

      return { message: { ...pending, status: 'sent', message_id: result.wamid } }
    }

    /* ------------------------------ template ---------------------------- */
    if (kind === 'template') {
      const name = body.template_name
      if (!name) badRequest('Pick a template first')

      const tpl = await resolveApprovedTemplate(userId, name, body.template_language)
      if (!tpl) badRequest(`Template "${name}" is not synced or not Approved by Meta`)

      const components: TemplateComponent[] = []
      const vars = (body.variables ?? []).filter((v) => v !== undefined)
      if (vars.length) {
        components.push({
          type: 'body',
          parameters: vars.map((v) => ({ type: 'text' as const, text: String(v ?? '') })),
        })
      }
      if (body.button_url_suffix) {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: body.button_url_suffix }],
        })
      }

      const preview = renderTemplatePreview(tpl, vars)

      const { data: pending, error: insertError } = await supabase
        .from('messages')
        .insert({
          user_id: userId,
          conversation_id: id,
          contact_id: conv.contact_id,
          sender_type: 'agent',
          content_type: 'template',
          content: preview,
          template_name: tpl.name,
          template_language: tpl.language,
          status: 'sending',
        })
        .select('*')
        .single()

      if (insertError) badRequest(insertError.message)

      const result = await sendWhatsApp(userId, phone, {
        kind: 'template',
        name: tpl.name,
        language: tpl.language,
        components: components.length ? components : undefined,
      })

      if (!result.ok) {
        await supabase
          .from('messages')
          .update({ status: 'failed', error_message: result.error, error_code: result.code ?? null })
          .eq('id', pending.id)
        badRequest(result.error, { code: 'send_failed', message_id: pending.id })
      }

      await supabase
        .from('messages')
        .update({ status: 'sent', message_id: result.wamid })
        .eq('id', pending.id)

      await bumpConversation(supabase, id, { text: preview, at: now, inbound: false })

      // Usage counter keeps the Templates screen honest.
      const { data: tplRow } = await supabase
        .from('message_templates')
        .select('id, usage_count')
        .eq('name', tpl.name)
        .eq('language', tpl.language)
        .maybeSingle()
      if (tplRow) {
        await supabase
          .from('message_templates')
          .update({ usage_count: (tplRow.usage_count ?? 0) + 1, last_used_at: now })
          .eq('id', tplRow.id)
      }

      return { message: { ...pending, status: 'sent', message_id: result.wamid } }
    }

    badRequest(`Unsupported message kind "${kind}"`)
  })
}

/** Fill {{1}}, {{2}}… in the template body so the thread shows real text. */
function renderTemplatePreview(tpl: { components?: any; body_text?: string }, vars: string[]) {
  let body = tpl.body_text ?? ''

  if (!body && Array.isArray(tpl.components)) {
    body = tpl.components.find((c: any) => c.type === 'BODY')?.text ?? ''
  }

  return body.replace(/\{\{(\d+)\}\}/g, (_m, n) => vars[Number(n) - 1] ?? `{{${n}}}`)
}
