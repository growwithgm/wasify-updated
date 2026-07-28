import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/contacts'
import { sanitizePhone, isValidPhone } from '@/lib/phone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Conversation list for the inbox left pane. */
export async function GET(request: Request) {
  return withAuth(async ({ supabase }) => {
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim()
    const filter = url.searchParams.get('filter') ?? 'all'
    const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 100))

    let query = supabase
      .from('conversations')
      .select(
        'id, contact_id, status, assigned_to, labels, last_message_text, last_message_at, last_inbound_at, unread_count, contacts:contact_id (id, name, phone, rfm_segment, locale, opt_in_status)'
      )
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(limit)

    if (filter === 'open' || filter === 'pending' || filter === 'closed') {
      query = query.eq('status', filter)
    } else if (filter === 'unassigned') {
      query = query.is('assigned_to', null)
    }

    const { data, error } = await query
    if (error) badRequest(error.message)

    let rows = data ?? []

    // Free-text search runs in JS so it can span contact fields and preview text.
    if (q) {
      const needle = q.toLowerCase()
      const digits = sanitizePhone(q)
      rows = rows.filter((r: any) => {
        const c = r.contacts
        return (
          c?.name?.toLowerCase().includes(needle) ||
          (digits && c?.phone?.includes(digits)) ||
          r.last_message_text?.toLowerCase().includes(needle)
        )
      })
    }

    return { conversations: rows }
  })
}

/** Start a new chat: resolve or create the contact, then its conversation. */
export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<{ phone?: string; contact_id?: string; name?: string }>(request)

    let contactId = body.contact_id

    if (!contactId) {
      const phone = sanitizePhone(body.phone ?? '')
      if (!isValidPhone(phone)) {
        badRequest('Enter a valid phone number in international format, e.g. +34 600 123 456')
      }
      // Same matcher the webhook uses, so a later reply lands in this thread.
      const contact = await findOrCreateContact(supabase, userId, phone, {
        name: body.name ?? null,
        source: 'manual',
      })
      if (!contact) badRequest('Could not create the contact')
      contactId = contact.id
    }

    const conversationId = await findOrCreateConversation(supabase, userId, contactId!)
    if (!conversationId) badRequest('Could not open a conversation')

    return { conversation_id: conversationId, contact_id: contactId }
  })
}
