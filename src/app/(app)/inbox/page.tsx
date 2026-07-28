import { createClient } from '@/lib/supabase/server'
import { ToastProvider } from '@/components/ui'
import { InboxClient } from './InboxClient'
import type { Agent, MessageTemplate } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function InboxPage() {
  const supabase = await createClient()

  const [agentsRes, cannedRes, templatesRes] = await Promise.all([
    supabase.from('agents').select('*').order('is_self', { ascending: false }).order('name'),
    supabase.from('canned_replies').select('id, shortcut, body').order('shortcut'),
    supabase
      .from('message_templates')
      .select('id, name, language, category, status, body_text, header_text, footer_text, buttons')
      .eq('status', 'APPROVED')
      .order('name'),
  ])

  const agents = (agentsRes.data ?? []) as Agent[]
  const selfAgentId = agents.find((a) => a.is_self)?.id ?? null

  return (
    <ToastProvider>
      <InboxClient
        agents={agents}
        selfAgentId={selfAgentId}
        cannedReplies={cannedRes.data ?? []}
        templates={(templatesRes.data ?? []) as MessageTemplate[]}
      />
    </ToastProvider>
  )
}
