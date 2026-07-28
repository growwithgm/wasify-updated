import { withAuth } from '@/lib/api'
import { siteUrlStatus } from '@/lib/site-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Everything the Integrations screen renders, in one call. */
export async function GET() {
  return withAuth(async ({ supabase }) => {
    const [shopify, whatsapp, waEvents, shopEvents, apiKeys, templates] = await Promise.all([
      supabase.from('shopify_config').select('*').maybeSingle(),
      supabase
        .from('whatsapp_config')
        .select(
          'phone_number_id, waba_id, business_id, display_phone_number, verified_name, quality_rating, messaging_tier, connection_status, connection_error, webhook_subscribed, last_verified_at, access_token, verify_token'
        )
        .maybeSingle(),
      supabase
        .from('whatsapp_webhook_events')
        .select('id, event_type, status, error, duration_ms, created_at')
        .order('created_at', { ascending: false })
        .limit(25),
      supabase
        .from('shopify_webhook_events')
        .select('id, topic, status, error, duration_ms, created_at')
        .order('created_at', { ascending: false })
        .limit(25),
      supabase
        .from('api_keys')
        .select('id, name, key_prefix, scopes, last_used_at, revoked_at, created_at')
        .order('created_at', { ascending: false }),
      supabase.from('message_templates').select('name, language').eq('status', 'APPROVED').limit(50),
    ])

    const wa = whatsapp.data
    const sh = shopify.data

    // Secrets never leave the server — only their presence is reported.
    const { access_token: _waToken, verify_token: _waVerify, ...waSafe } = (wa ?? {}) as any
    const { access_token: _shToken, refresh_token: _shRefresh, ...shSafe } = (sh ?? {}) as any

    return {
      whatsapp: wa ? { ...waSafe, has_token: !!wa.access_token, has_verify_token: !!wa.verify_token } : null,
      shopify: sh ? { ...shSafe, has_token: !!sh.access_token } : null,
      events: [
        ...(waEvents.data ?? []).map((e: any) => ({ ...e, source: 'WhatsApp', topic: e.event_type })),
        ...(shopEvents.data ?? []).map((e: any) => ({ ...e, source: 'Shopify' })),
      ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
      apiKeys: apiKeys.data ?? [],
      approvedTemplates: templates.data ?? [],
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? null,
      // The screen prints callback URLs built from siteUrl and offers a
      // "Connect Shopify" button that depends on it. If it is unset or still
      // the example placeholder, say so here rather than letting the merchant
      // discover it on Shopify's error page.
      siteUrlError: siteUrlStatus().message,
    }
  })
}
