import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Wipe the tenant's MESSAGING data — for starting over with a new WhatsApp
 * number.
 *
 * Deliberately narrow. Deleted: contacts (and everything hanging off them),
 * conversations + messages, tags, templates, broadcasts with their reports,
 * import history, COD confirmations, recovery tracking, webhook event log.
 * KEPT: Shopify data (orders/products/checkouts — the store didn't change),
 * flow/automation/chatbot definitions, segment definitions, custom-field
 * definitions, credentials and settings, and the SUPPRESSION LIST — people
 * who said STOP stay suppressed across the number change; consent does not
 * reset with the SIM.
 *
 * Runs on the RLS client, so even a bug here cannot reach another tenant.
 * The typed confirmation is enforced server-side on top of the UI's checks.
 */
const WIPE_ORDER = [
  // Children before parents — most cascade anyway, but explicit order makes
  // a partial failure land in a sane, resumable state.
  'messages',
  'conversations',
  'broadcast_recipients',
  'broadcasts',
  'contact_imports',
  'cod_confirmations',
  'checkout_recoveries',
  'contact_tags',
  'tags',
  'contacts',
  'message_templates',
  'whatsapp_webhook_events',
] as const

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<{ confirm?: string }>(request)
    if ((body.confirm ?? '').trim().toUpperCase() !== 'DELETE') {
      badRequest('Type DELETE to confirm — nothing was removed')
    }

    const removed: Record<string, number> = {}
    for (const table of WIPE_ORDER) {
      const { count, error } = await supabase
        .from(table)
        .delete({ count: 'exact' })
        .eq('user_id', userId)
      if (error) {
        badRequest(`Stopped at "${table}": ${error.message} — tables after it were not touched. Fix and run again; the wipe is resumable.`)
      }
      removed[table] = count ?? 0
    }

    // Segment definitions survive, but their cached member counts would lie.
    await supabase.from('segments').update({ member_count: 0 }).eq('user_id', userId)

    return { ok: true, removed }
  })
}
