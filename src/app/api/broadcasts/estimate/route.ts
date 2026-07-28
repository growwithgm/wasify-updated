import { withAuth, jsonBody } from '@/lib/api'
import { buildRecipients } from '@/lib/engines/broadcasts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Audience size + opt-out split, before anything is saved. */
export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const { audience } = await jsonBody<{ audience: any }>(request)
    const recipients = await buildRecipients(supabase, userId, { id: '00000000-0000-0000-0000-000000000000', audience })

    const sendable = recipients.filter((r) => r.status === 'queued').length
    return {
      total: recipients.length,
      sendable,
      suppressed: recipients.length - sendable,
    }
  })
}
