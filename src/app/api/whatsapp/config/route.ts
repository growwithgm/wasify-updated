import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { encrypt, decrypt, maskToken, randomToken } from '@/lib/crypto'
import { fetchPhoneNumberInfo, fetchWabaInfo, subscribeWebhook } from '@/lib/whatsapp/graph'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return withAuth(async ({ supabase }) => {
    const { data } = await supabase.from('whatsapp_config').select('*').maybeSingle()
    if (!data) return { config: null }

    // Never return the real token to the browser.
    let masked = ''
    try {
      masked = data.access_token ? maskToken(decrypt(data.access_token)) : ''
    } catch {
      masked = '(unreadable — re-enter the token)'
    }

    return {
      config: {
        ...data,
        access_token: masked,
        verify_token: data.verify_token ? '••••••••' : '',
        has_token: !!data.access_token,
      },
    }
  })
}

export async function PATCH(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<any>(request)

    const patch: Record<string, unknown> = {}
    if (body.phone_number_id !== undefined) patch.phone_number_id = body.phone_number_id?.trim() || null
    if (body.waba_id !== undefined) patch.waba_id = body.waba_id?.trim() || null
    if (body.business_id !== undefined) patch.business_id = body.business_id?.trim() || null

    // Only overwrite the token when a new one is actually supplied.
    if (body.access_token && !body.access_token.includes('•')) {
      patch.access_token = encrypt(body.access_token.trim())
    }
    if (body.verify_token && !body.verify_token.includes('•')) {
      patch.verify_token = encrypt(body.verify_token.trim())
    }

    // phone_number_id is globally UNIQUE — routing depends on it.
    if (patch.phone_number_id) {
      const { data: owner } = await supabase
        .from('whatsapp_config')
        .select('user_id')
        .eq('phone_number_id', patch.phone_number_id)
        .maybeSingle()
      if (owner && owner.user_id !== userId) {
        badRequest('That WhatsApp number is already connected to another Wasify account')
      }
    }

    const { data, error } = await supabase
      .from('whatsapp_config')
      .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' })
      .select('*')
      .single()

    if (error) badRequest(error.message)
    return { ok: true, id: data.id }
  })
}

/** Generate a verify token for the merchant to paste into the Meta dashboard. */
export async function POST() {
  return withAuth(async ({ supabase, userId }) => {
    const token = randomToken(16)
    await supabase
      .from('whatsapp_config')
      .upsert({ user_id: userId, verify_token: encrypt(token) }, { onConflict: 'user_id' })
    return { verify_token: token }
  })
}
