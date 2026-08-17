import { GRAPH_BASE, graphFetch, getWhatsAppConfig, type GraphResult } from './graph'
import { templateShape } from './template-params'
import { phoneVariants, sanitizePhone } from '@/lib/phone'
import { createServiceClient } from '@/lib/supabase/server'

export type TemplateComponent = {
  type: 'header' | 'body' | 'button'
  sub_type?: 'url' | 'quick_reply' | 'copy_code'
  index?: string
  parameters?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: { link?: string; id?: string } }
    | { type: 'currency'; currency: { fallback_value: string; code: string; amount_1000: number } }
    | { type: 'coupon_code'; coupon_code: string }
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
/**
 * Re-pull ONE template from Meta so a pre-send shape check runs against what
 * Meta will actually enforce, not a possibly week-old synced copy — a
 * template edited after the last sync is exactly how a broadcast that passed
 * every local check still dies per-recipient with #131008.
 *
 * Best-effort by design: on any failure the caller simply checks the synced
 * rows, which is no worse than before this existed.
 */
export async function refreshTemplateFromMeta(userId: string, name: string): Promise<void> {
  try {
    const config = await getWhatsAppConfig(userId)
    if (!config?.waba_id) return

    const res = await graphFetch<{ data: any[] }>(`${config.waba_id}/message_templates`, config.token, {
      query: { name, fields: 'id,name,language,status,category,components' },
    })
    if (!res.ok) return

    const db = createServiceClient()
    for (const tpl of res.data.data ?? []) {
      if (tpl.name !== name) continue // Meta's name filter can prefix-match
      await db.from('message_templates').upsert(
        {
          user_id: userId,
          name: tpl.name,
          language: tpl.language,
          category: (tpl.category ?? 'MARKETING').toUpperCase(),
          status: (tpl.status ?? 'PENDING').toUpperCase(),
          meta_template_id: tpl.id,
          components: tpl.components ?? null,
          synced_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,name,language' }
      )
    }
  } catch (e) {
    console.error('[templates] single-template refresh failed', e)
  }
}

export async function resolveApprovedTemplate(userId: string, name: string, preferredLang?: string) {
  const db = createServiceClient()
  const { data } = await db
    .from('message_templates')
    // buttons / header_media_url / sample_values / header_media_* ride along
    // so callers can fill per-send parameters (coupon code, header image)
    // from the synced template without a second query.
    .select('name, language, status, components, category, buttons, header_media_url, sample_values, header_media_id, header_media_src, header_media_synced_at')
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

/** Meta-hosted URLs — the approved sample — that Meta's own send-time downloader refuses. */
function isMetaHosted(url: string): boolean {
  return /lookaside|fbsbx|fbcdn|whatsapp\.net|scontent/i.test(url)
}

/** Meta keeps uploaded media ~30 days; refresh comfortably before that. */
const HEADER_MEDIA_TTL_DAYS = 25

/**
 * The header-image parameter for an image-header template, plus the URL the
 * inbox thread should display.
 *
 * A merchant-hosted public URL goes out as a plain link. But the common case
 * — "send the image the approved template already has" — is a Meta lookaside
 * URL, and Meta's send-time downloader REFUSES its own lookaside domain
 * ("Media upload error"). So that image is downloaded once, re-uploaded to
 * the WhatsApp media endpoint, and sent by media id — cached on the template
 * row and refreshed when it nears Meta's ~30-day media expiry.
 */
export async function resolveHeaderImage(
  userId: string,
  tpl: any,
  overrideUrl?: string
): Promise<{ param: { type: 'image'; image: { link?: string; id?: string } }; displayUrl: string } | null> {
  const src: string =
    (overrideUrl ?? '').trim() || tpl.header_media_url || tpl.sample_values?.header_url || ''
  if (!src) return null

  if (!isMetaHosted(src)) {
    return { param: { type: 'image', image: { link: src } }, displayUrl: src }
  }

  const freshAfter = Date.now() - HEADER_MEDIA_TTL_DAYS * 86_400_000
  if (
    tpl.header_media_id &&
    tpl.header_media_src === src &&
    tpl.header_media_synced_at &&
    new Date(tpl.header_media_synced_at).getTime() > freshAfter
  ) {
    return { param: { type: 'image', image: { id: tpl.header_media_id } }, displayUrl: src }
  }

  try {
    const config = await getWhatsAppConfig(userId)
    if (!config?.phone_number_id) {
      return { param: { type: 'image', image: { link: src } }, displayUrl: src }
    }

    const download = await fetch(src)
    if (!download.ok) throw new Error(`sample download failed: HTTP ${download.status}`)
    const mime = download.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
    const bytes = new Uint8Array(await download.arrayBuffer())
    if (bytes.byteLength > 5 * 1024 * 1024) throw new Error('sample image exceeds 5 MB')

    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', mime)
    form.append('file', new Blob([bytes], { type: mime }), 'header')

    const upload = await fetch(`${GRAPH_BASE}/${config.phone_number_id}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: form,
    })
    const json: any = await upload.json().catch(() => null)
    if (!upload.ok || !json?.id) {
      throw new Error(json?.error?.message ?? `media upload failed: HTTP ${upload.status}`)
    }

    const db = createServiceClient()
    await db
      .from('message_templates')
      .update({
        header_media_id: json.id,
        header_media_src: src,
        header_media_synced_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('name', tpl.name)
      .eq('language', tpl.language)

    return { param: { type: 'image', image: { id: json.id } }, displayUrl: src }
  } catch (e) {
    console.error('[templates] header media re-upload failed', e)
    // No worse than before this existed: the link may still be refused, but a
    // transient upload failure must not hard-block the whole send path.
    return { param: { type: 'image', image: { link: src } }, displayUrl: src }
  }
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

  // Per-send parameters the synced template can supply ITSELF: an image
  // header's default image and a copy-code button's coupon. Flows,
  // automations, COD and recovery all come through here with body/url
  // components only — without this, the moment a merchant picked an image
  // template for any of them, every send died at Meta with #132012.
  const shape = templateShape(tpl.components)
  const merged: TemplateComponent[] = [...(components ?? [])]

  if (shape.headerFormat === 'IMAGE' && !merged.some((c) => c.type === 'header')) {
    const header = await resolveHeaderImage(userId, tpl)
    if (header) {
      merged.unshift({ type: 'header', parameters: [header.param] })
    }
  }

  if (shape.copyCodeButtons.length && !merged.some((c) => c.sub_type === 'copy_code')) {
    const code = ((tpl as any).buttons ?? []).find((b: any) => b?.kind === 'copy_code')?.code
    if (code) {
      for (const index of shape.copyCodeButtons) {
        merged.push({
          type: 'button',
          sub_type: 'copy_code',
          index: String(index),
          parameters: [{ type: 'coupon_code', coupon_code: code }],
        })
      }
    }
  }

  return sendWhatsApp(userId, to, {
    kind: 'template',
    name: tpl.name,
    language: tpl.language,
    components: merged.length ? merged : undefined,
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
