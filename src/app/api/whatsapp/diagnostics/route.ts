import { withAuth, badRequest } from '@/lib/api'
import { getWhatsAppConfig, fetchPhoneNumberInfo, fetchWabaInfo, fetchSubscribedApps, subscribeWebhook } from '@/lib/whatsapp/graph'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Live Graph calls that prove the credentials actually work. */
export async function GET() {
  return withAuth(async ({ userId }) => {
    const config = await getWhatsAppConfig(userId)
    if (!config) badRequest('Enter your phone number ID and access token first')

    const checks: Array<{ name: string; ok: boolean; detail: string }> = []

    const phone = await fetchPhoneNumberInfo(config.phone_number_id, config.token)
    checks.push({
      name: 'Phone number',
      ok: phone.ok,
      detail: phone.ok
        ? `${phone.data.verified_name} · ${phone.data.display_phone_number}`
        : phone.error.message,
    })

    let quality: string | null = null
    let tier: string | null = null
    if (phone.ok) {
      quality = phone.data.quality_rating ?? null
      tier = phone.data.messaging_limit_tier ?? null
    }

    if (config.waba_id) {
      const waba = await fetchWabaInfo(config.waba_id, config.token)
      checks.push({
        name: 'Business account',
        ok: waba.ok,
        detail: waba.ok ? `${waba.data.name} · review ${waba.data.account_review_status}` : waba.error.message,
      })

      const apps = await fetchSubscribedApps(config.waba_id, config.token)
      const subscribed = apps.ok && (apps.data?.data ?? []).length > 0
      checks.push({
        name: 'Webhook subscription',
        ok: subscribed,
        detail: subscribed ? 'This app is subscribed to the WABA' : 'Not subscribed — use the button below',
      })
    } else {
      checks.push({ name: 'Business account', ok: false, detail: 'WABA ID is not set' })
    }

    // Reflect what we learned back into the config so the shell badge is right.
    const db = createServiceClient()
    await db
      .from('whatsapp_config')
      .update({
        connection_status: checks[0].ok ? 'connected' : 'error',
        connection_error: checks[0].ok ? null : checks[0].detail,
        quality_rating: quality,
        messaging_tier: tier,
        verified_name: phone.ok ? phone.data.verified_name : null,
        display_phone_number: phone.ok ? phone.data.display_phone_number : null,
        last_verified_at: new Date().toISOString(),
      })
      .eq('user_id', userId)

    return { checks, quality, tier }
  })
}

/** Subscribe this app to the WABA's webhooks. */
export async function POST() {
  return withAuth(async ({ userId }) => {
    const config = await getWhatsAppConfig(userId)
    if (!config?.waba_id) badRequest('Set your WABA ID first')

    const res = await subscribeWebhook(config.waba_id, config.token)
    if (!res.ok) badRequest(res.error.message)

    const db = createServiceClient()
    await db.from('whatsapp_config').update({ webhook_subscribed: true }).eq('user_id', userId)

    return { ok: true }
  })
}
