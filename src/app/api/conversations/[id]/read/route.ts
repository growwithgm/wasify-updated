import { withAuth } from '@/lib/api'
import { markRead } from '@/lib/whatsapp/send'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** Clear the unread badge and send blue ticks back to the customer. */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase, userId }) => {
    await supabase.from('conversations').update({ unread_count: 0 }).eq('id', id)

    // Best-effort read receipt on the newest inbound message.
    const { data: latest } = await supabase
      .from('messages')
      .select('message_id')
      .eq('conversation_id', id)
      .eq('sender_type', 'customer')
      .not('message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (latest?.message_id) {
      try {
        await markRead(userId, latest.message_id)
      } catch {
        /* read receipts are advisory */
      }
    }

    return { ok: true }
  })
}
