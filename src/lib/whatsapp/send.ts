import { GRAPH_BASE, graphFetch, getWhatsAppConfig, type GraphResult } from './graph'
import { phoneVariants, sanitizePhone } from '@/lib/phone'
import { createServiceClient } from '@/lib/supabase/server'

export type TemplateComponent = {
  type: 'header' | 'body' | 'button'
  sub_type?: 'url' | 'quick_reply'
  index?: string
  parameters?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: { link: string } }
    | { type: 'currency'; currency: { fallback_value: string; code: string; amount_1000: number } }
  >
}

export type SendPayload =
  | { kind: 'text'; body: string; previewUrl?: boolean }
  | { kind: 'template'; name: string; language: string; components?: TemplateComponent[] }
  | { kind: 'image' | 'video' | 'audio' | 'document'; link: string; caption?: string; filename?: string }
  | {
      kind: 'interactive-buttons'
      body: string
      header?: string
      footer?: string
      buttons: Array<{ id: string; title: string }>
    }
  | {
      kind: 'interactive-list'
      body: string
      header?: string
      footer?: string
      buttonText: string
      sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>
    }

function buildBody(to: string, payload: SendPayload): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to }

  switch (payload.kind) {
    case 'text':
      return { ...base, type: 'text', text: { body: payload.body, preview_url: payload.previewUrl ?? true } }

    case 'template':
      return {
        ...base,
        type: 'template',
        template: {
          name: payload.name,
          language: { code: payload.language },
          ...(payload.components?.length ? { components: payload.components } : {}),
        },
      }

    case 'image':
    case 'video':
    case 'audio':
    case 'document':
      return {
        ...base,
        type: payload.kind,
        [payload.kind]: {
          link: payload.link,
          ...(payload.caption ? { caption: payload.caption } : {}),
          ...(payload.kind === 'document' && payload.filename ? { filename: payload.filename } : {}),
        },
      }

    case 'interactive-buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(payload.header ? { header: { type: 'text', text: payload.header } } : {}),
          body: { text: payload.body },
          ...(payload.footer ? { footer: { text: payload.footer } } : {}),
          action: {
            buttons: payload.buttons.slice(0, 3).map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      }

    case 'interactive-list':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(payload.header ? { header: { type: 'text', text: payload.header } } : {}),
          body: { text: payload.body },
          ...(payload.footer ? { footer: { text: payload.footer } } : {}),
          action: { button: payload.buttonText.slice(0, 20), sections: payload.sections },
        },
      }
  }
}

export type SendResult =
  | { ok: true; wamid: string; usedPhone: string }
  | { ok: false; error: string; code?: number; details?: unknown }

/**
 * Send one WhatsApp message for a tenant.
 *
 * Retries across phone variants only for Meta error #131030 ("not in allowed
 * list" / sandbox recipient mismatch), which is the one failure mode that a
 * trunk-zero difference actually causes. Every other error returns immediately.
 */
export async function sendWhatsApp(userId: string, to: string, payload: SendPayload): Promise<SendResult> {
  const config = await getWhatsAppConfig(userId)
  if (!config) return { ok: false, error: 'WhatsApp is not connected for this account' }

  const variants = phoneVariants(to)
  if (!variants.length) return { ok: false, error: 'Recipient phone number is empty or invalid' }

  let last: GraphResult | null = null

  for (const candidate of variants) {
    const res = await graphFetch<{ messages: Array<{ id: string }> }>(
      `${config.phone_number_id}/messages`,
      config.token,
      { method: 'POST', body: JSON.stringify(buildBody(candidate, payload)) }
    )

    if (res.ok) {
      const wamid = res.data?.messages?.[0]?.id
      if (!wamid) return { ok: false, error: 'Meta accepted the request but returned no message id' }
      return { ok: true, wamid, usedPhone: candidate }
    }

    last = res
    if (res.error.code !== 131030) break // only the sandbox-recipient error is worth retrying
  }

  return {
    ok: false,
    error: last?.ok === false ? last.error.message : 'Unknown error sending message',
    code: last?.ok === false ? last.error.code : undefined,
    details: last?.ok === false ? last.error.details : undefined,
  }
}

/**
 * Resolve a template by name against the tenant's synced templates and
 * confirm it is Approved before sending. Sending an unsynced or stale
 * name is the usual cause of Meta #132001.
 */
export async function resolveApprovedTemplate(userId: string, name: string, preferredLang?: string) {
  const db = createServiceClient()
  const { data } = await db
    .from('message_templates')
    .select('name, language, status, components, category')
    .eq('user_id', userId)
    .eq('name', name)
    .eq('status', 'APPROVED')

  if (!data?.length) return null
  if (preferredLang) {
    const exact = data.find((t) => t.language === preferredLang)
    if (exact) return exact
    const loose = data.find((t) => t.language.split('_')[0] === preferredLang.split('_')[0])
    if (loose) return loose
  }
  return data[0]
}

/** Convenience: send an approved template, resolving the exact language first. */
export async function sendTemplate(
  userId: string,
  to: string,
  templateName: string,
  components?: TemplateComponent[],
  preferredLang?: string
): Promise<SendResult> {
  const tpl = await resolveApprovedTemplate(userId, templateName, preferredLang)
  if (!tpl) return { ok: false, error: `Template "${templateName}" is not synced or not Approved` }
  return sendWhatsApp(userId, to, {
    kind: 'template',
    name: tpl.name,
    language: tpl.language,
    components,
  })
}

/** Mark a customer message as read (blue ticks on their side). */
export async function markRead(userId: string, wamid: string) {
  const config = await getWhatsAppConfig(userId)
  if (!config) return
  await graphFetch(`${config.phone_number_id}/messages`, config.token, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: wamid }),
  })
}

export { GRAPH_BASE, sanitizePhone }
