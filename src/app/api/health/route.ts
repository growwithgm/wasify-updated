import { NextResponse } from 'next/server'
import { cronAuthHint } from '@/lib/cron'
import { siteUrlStatus } from '@/lib/site-url'
import { encryptionKeyStatus, serviceRoleStatus } from '@/lib/config'

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

/**
 * Columns added after the first release, per table. The code writes them on
 * every webhook/sync, so a database that predates them fails every write with
 * PGRST204 — silently, from the UI's point of view. Probing them here turns
 * "nothing shows up" into a named, fixable answer.
 */
const MIGRATION_PROBES: Array<{ table: string; columns: string }> = [
  { table: 'shopify_checkouts', columns: 'abandoned_at, raw' },
  { table: 'checkout_recoveries', columns: 'send_attempts, conversation_id' },
]

async function databaseStatus(): Promise<{ ok: boolean; message: string | null }> {
  if (!serviceRoleStatus().ok) return { ok: false, message: 'Cannot check — Supabase variables are missing.' }
  try {
    const { createServiceClient } = await import('@/lib/supabase/server')
    const db = createServiceClient()
    for (const probe of MIGRATION_PROBES) {
      const { error } = await db.from(probe.table).select(probe.columns).limit(1)
      if (error) {
        return {
          ok: false,
          message:
            `Table "${probe.table}" is missing a column this version needs (${error.message}). ` +
            'Run supabase/schema.sql in the Supabase SQL editor again — it is idempotent and will only add what is missing. ' +
            'Until then, Shopify webhooks and syncs fail on every write.',
        }
      }
    }
    return { ok: true, message: null }
  } catch (e: any) {
    return { ok: false, message: `Could not reach the database: ${e?.message ?? e}` }
  }
}

export async function GET() {
  const env = process.env
  const site = siteUrlStatus()
  const encryption = encryptionKeyStatus()
  const serviceRole = serviceRoleStatus()
  const database = await databaseStatus()

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
      breaks: serviceRole.ok
        ? ''
        : `${serviceRole.message} Webhooks, cron sweeps and the Shopify callback all fail without it.`,
    },
    {
      key: 'ENCRYPTION_KEY',
      ok: encryption.ok,
      required: true,
      breaks: encryption.ok
        ? ''
        : `${encryption.message} Connecting WhatsApp or Shopify fails at the moment the token is saved.`,
    },
    {
      key: 'NEXT_PUBLIC_SITE_URL',
      // Present is not enough: the example file's placeholder is a real string
      // that produces a well-formed URL pointing at somebody else's domain.
      ok: site.ok,
      required: true,
      breaks: site.ok ? '' : site.message,
    },
    {
      key: 'META_APP_SECRET',
      ok: !!env.META_APP_SECRET,
      required: true,
      breaks: 'The WhatsApp webhook refuses all traffic (503) — no inbound messages arrive.',
    },
    {
      key: 'DATABASE_SCHEMA',
      ok: database.ok,
      required: true,
      breaks: database.ok ? '' : database.message!,
    },
    {
      // Either variable satisfies this — they differ only in which header
      // the scheduler must send. See cronAuthHint() in lib/cron.ts.
      key: 'CRON_SECRET or AUTOMATION_CRON_SECRET',
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

  // Show what the URLs currently resolve to even when the value is wrong —
  // seeing "your-app.vercel.app" printed back is usually the moment it clicks.
  const siteUrl = (env.NEXT_PUBLIC_SITE_URL ?? '').trim().replace(/\/+$/, '')

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
      shopify: {
        // Paste this verbatim into Partner Dashboard → Configuration →
        // Redirect URLs, then Release the version. A mismatch of even one
        // character is "The redirect_uri is not whitelisted".
        redirectUrl: `${siteUrl}/api/shopify/callback`,
        siteUrlValid: site.ok,
        siteUrlProblem: site.ok ? null : site.problem,
      },
      cron: {
        tick: `${siteUrl}/api/cron/tick`,
        daily: `${siteUrl}/api/cron/daily`,
        // Which header to use depends on WHICH secret variable you set —
        // mixing them is the usual reason a scheduler gets a silent 401.
        authHeader: cronAuthHint().example,
        headerName: cronAuthHint().header,
        usingVariable: env.CRON_SECRET
          ? 'CRON_SECRET'
          : env.AUTOMATION_CRON_SECRET
            ? 'AUTOMATION_CRON_SECRET'
            : null,
      },
    },
    { status: missingRequired.length === 0 ? 200 : 503 }
  )
}
