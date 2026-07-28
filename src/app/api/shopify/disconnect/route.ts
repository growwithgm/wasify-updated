import { withAuth } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Forget the store credentials. Mirrored commerce data is kept for history. */
export async function POST() {
  return withAuth(async ({ supabase }) => {
    const { error } = await supabase
      .from('shopify_config')
      .update({
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
        connection_status: 'disconnected',
        connection_error: null,
        webhooks_registered: false,
      })
      .not('id', 'is', null)

    if (error) throw new Error(error.message)
    return { ok: true }
  })
}
