import { decrypt, isLegacyFormat, encrypt } from '@/lib/crypto'
import { createServiceClient } from '@/lib/supabase/server'

export const GRAPH_VERSION = 'v22.0'
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

export type WhatsAppConfig = {
  id: string
  user_id: string
  phone_number_id: string
  waba_id: string | null
  business_id: string | null
  /** Meta App ID — the Resumable Upload API (template sample images) is app-scoped. */
  app_id: string | null
  access_token: string | null
  verify_token: string | null
  display_phone_number: string | null
  verified_name: string | null
  quality_rating: string | null
  messaging_tier: string | null
  connection_status: string | null
  webhook_subscribed: boolean | null
}

export type GraphResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; code?: number; subcode?: number; details?: any } }

/**
 * Every Graph call funnels through here so error shapes are consistent and
 * Meta's numeric codes survive to the caller (we branch on #131030, #132001…).
 */
export async function graphFetch<T = any>(
  path: string,
  token: string,
  init: RequestInit & { query?: Record<string, string | undefined> } = {}
): Promise<GraphResult<T>> {
  const { query, ...rest } = init
  const url = new URL(path.startsWith('http') ? path : `${GRAPH_BASE}/${path.replace(/^\//, '')}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v)
  }

  let res: Response
  try {
    res = await fetch(url.toString(), {
      ...rest,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        ...(rest.headers || {}),
      },
      cache: 'no-store',
    })
  } catch (e: any) {
    return { ok: false, error: { message: `Network error calling Meta: ${e?.message ?? e}` } }
  }

  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body — keep raw text in details */
  }

  if (!res.ok) {
    const err = json?.error ?? {}
    return {
      ok: false,
      error: {
        message: err.message || `Meta returned ${res.status}`,
        code: err.code,
        subcode: err.error_subcode,
        details: json ?? text,
      },
    }
  }

  return { ok: true, data: json as T }
}

/**
 * Load a tenant's WhatsApp config with the access token already decrypted.
 * Self-heals legacy CBC values by re-encrypting them on read.
 */
export async function getWhatsAppConfig(userId: string): Promise<(WhatsAppConfig & { token: string }) | null> {
  const db = createServiceClient()
  const { data } = await db.from('whatsapp_config').select('*').eq('user_id', userId).maybeSingle()
  if (!data || !data.access_token) return null

  let token = ''
  try {
    token = decrypt(data.access_token)
  } catch {
    return null
  }

  if (isLegacyFormat(data.access_token)) {
    // Re-encrypt with GCM so the legacy branch eventually goes cold.
    await db.from('whatsapp_config').update({ access_token: encrypt(token) }).eq('id', data.id)
  }

  return { ...(data as WhatsAppConfig), token }
}

/** Resolve the tenant that owns an inbound webhook by its phone_number_id. */
export async function configByPhoneNumberId(phoneNumberId: string) {
  const db = createServiceClient()
  const { data } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle()
  if (!data?.access_token) return null
  try {
    return { ...(data as WhatsAppConfig), token: decrypt(data.access_token) }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostics used by the Integrations screen                         */
/* ------------------------------------------------------------------ */

export async function fetchPhoneNumberInfo(phoneNumberId: string, token: string) {
  return graphFetch(phoneNumberId, token, {
    query: {
      fields:
        'verified_name,display_phone_number,quality_rating,code_verification_status,platform_type,throughput,messaging_limit_tier',
    },
  })
}

export async function fetchWabaInfo(wabaId: string, token: string) {
  return graphFetch(wabaId, token, {
    query: { fields: 'name,currency,timezone_id,account_review_status,message_template_namespace' },
  })
}

export async function subscribeWebhook(wabaId: string, token: string) {
  return graphFetch(`${wabaId}/subscribed_apps`, token, { method: 'POST' })
}

export async function fetchSubscribedApps(wabaId: string, token: string) {
  return graphFetch(`${wabaId}/subscribed_apps`, token)
}

export async function registerPhoneNumber(phoneNumberId: string, token: string, pin: string) {
  return graphFetch(`${phoneNumberId}/register`, token, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  })
}

/** Download inbound media and return it as a data URL we can store/serve. */
export async function fetchMediaUrl(mediaId: string, token: string): Promise<string | null> {
  const meta = await graphFetch<{ url: string; mime_type: string }>(mediaId, token)
  if (!meta.ok) return null
  try {
    const res = await fetch(meta.data.url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    // Keep small media inline; anything large is left to be re-fetched on demand.
    if (buf.length > 4 * 1024 * 1024) return null
    return `data:${meta.data.mime_type};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
