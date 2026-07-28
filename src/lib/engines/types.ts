import type { SupabaseClient } from '@supabase/supabase-js'

/** Everything an inbound-message handler needs. Passed by the WhatsApp webhook. */
export type InboundCtx = {
  db: SupabaseClient<any, any, any>
  userId: string
  contactId: string
  conversationId: string
  phone: string
  text: string
  interactiveReplyId: string | null
}

/** Strip accents and lowercase — "Sí" and "si" must match. */
export function normalize(input: string): string {
  return (input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/** Whole-word match that survives punctuation: "STOP." still matches "stop". */
export function matchesKeyword(text: string, keyword: string): boolean {
  const haystack = normalize(text)
  const needle = normalize(keyword)
  if (!haystack || !needle) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(needle)}([^\\p{L}\\p{N}]|$)`, 'u').test(haystack)
}

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Record an outbound message we sent from an engine, so it shows in the thread. */
export async function recordOutbound(
  ctx: InboundCtx,
  args: {
    content: string
    wamid?: string
    contentType?: string
    templateName?: string
    senderType?: 'bot' | 'agent' | 'system'
    buttons?: Array<{ id: string; title: string }>
    status?: string
  }
) {
  await ctx.db.from('messages').insert({
    user_id: ctx.userId,
    conversation_id: ctx.conversationId,
    contact_id: ctx.contactId,
    sender_type: args.senderType ?? 'bot',
    content_type: args.contentType ?? 'text',
    content: args.content,
    template_name: args.templateName ?? null,
    message_id: args.wamid ?? null,
    buttons: args.buttons ?? [],
    status: args.status ?? (args.wamid ? 'sent' : 'failed'),
  })

  await ctx.db
    .from('conversations')
    .update({
      last_message_text: args.content.slice(0, 500),
      last_message_at: new Date().toISOString(),
    })
    .eq('id', ctx.conversationId)
}
