import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Configuration check.
 *
 * Open https://<your-app>/api/health after deploying: it reports which
 * environment variables are present and what each missing one breaks, without
 * ever revealing a value. This is the fastest way to diagnose "my webhook
 * returns 503" or "Shopify won't connect".
 */

type Check = {
  key: string
  ok: boolean
  required: boolean
  breaks: string
}

function isHex64(value: string | undefined): boolean {
  return !!value && /^[0-9a-fA-F]{64}$/.test(value.trim())
}

export async function GET() {
  const env = process.env

  const checks: Check[] = [
    {
      key: 'NEXT_PUBLIC_SUPABASE_URL',
      ok: !!env.NEXT_PUBLIC_SUPABASE_URL,
      required: true,
      breaks: 'Nothing works — the app cannot reach the database.',
    },
    {
      key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      ok: !!env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      required: true,
      breaks: 'Login and every page read fails.',
    },
    {
      key: 'SUPABASE_SERVICE_ROLE_KEY',
      ok: !!env.SUPABASE_SERVICE_ROLE_KEY,
      required: true,
      breaks: 'Webhooks, cron sweeps and all sending fail.',
    },
    {
      key: 'ENCRYPTION_KEY',
      ok: isHex64(env.ENCRYPTION_KEY),
      required: true,
      breaks:
        env.ENCRYPTION_KEY && !isHex64(env.ENCRYPTION_KEY)
          ? 'Set but INVALID — it must be exactly 64 hex characters (openssl rand -hex 32).'
          : 'WhatsApp and Shopify tokens cannot be saved or read.',
    },
    {
      key: 'NEXT_PUBLIC_SITE_URL',
      ok: !!env.NEXT_PUBLIC_SITE_URL,
      required: true,
      breaks: 'Shopify OAuth and the webhook callback URLs are built wrong.',
    },
    {
      key: 'META_APP_SECRET',
      ok: !!env.META_APP_SECRET,
      required: true,
      breaks: 'The WhatsApp webhook refuses all traffic (503) — no inbound messages arrive.',
    },
    {
      key: 'CRON_SECRET',
      ok: !!env.CRON_SECRET || !!env.AUTOMATION_CRON_SECRET,
      required: true,
      breaks: 'Cron endpoints reject every request — no reminders, recovery or scheduled sends.',
    },
    {
      key: 'SHOPIFY_CLIENT_ID',
      ok: !!env.SHOPIFY_CLIENT_ID,
      required: false,
      breaks: 'Shopify cannot be connected. Fine to leave unset if you are not using Shopify yet.',
    },
    {
      key: 'SHOPIFY_CLIENT_SECRET',
      ok: !!env.SHOPIFY_CLIENT_SECRET,
      required: false,
      breaks: 'The Shopify webhook refuses all traffic (503) — no orders or abandoned carts.',
    },
  ]

  const missingRequired = checks.filter((c) => c.required && !c.ok)
  const missingOptional = checks.filter((c) => !c.required && !c.ok)

  const siteUrl = env.NEXT_PUBLIC_SITE_URL ?? ''

  return NextResponse.json(
    {
      ok: missingRequired.length === 0,
      service: 'wasify',
      time: new Date().toISOString(),
      summary:
        missingRequired.length > 0
          ? `${missingRequired.length} required variable(s) missing — see "missing.required".`
          : missingOptional.length > 0
            ? `Ready. ${missingOptional.length} optional variable(s) unset, so Shopify features are off.`
            : 'All environment variables are set.',
      missing: {
        required: missingRequired.map((c) => ({ key: c.key, breaks: c.breaks })),
        optional: missingOptional.map((c) => ({ key: c.key, breaks: c.breaks })),
      },
      // Presence only — a value is never returned.
      configured: Object.fromEntries(checks.map((c) => [c.key, c.ok])),
      webhooks: {
        whatsapp: `${siteUrl}/api/whatsapp/webhook`,
        shopify: `${siteUrl}/api/shopify/webhook`,
      },
      cron: {
        tick: `${siteUrl}/api/cron/tick`,
        daily: `${siteUrl}/api/cron/daily`,
        authHeader: 'Authorization: Bearer <CRON_SECRET>',
      },
    },
    { status: missingRequired.length === 0 ? 200 : 503 }
  )
}
