import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

/** Cheap liveness probe — also reports which integrations are configured. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'wasify',
    time: new Date().toISOString(),
    env: {
      supabase: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      serviceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      encryptionKey: !!process.env.ENCRYPTION_KEY,
      metaAppSecret: !!process.env.META_APP_SECRET,
      shopify: !!process.env.SHOPIFY_CLIENT_ID && !!process.env.SHOPIFY_CLIENT_SECRET,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? null,
    },
  })
}
