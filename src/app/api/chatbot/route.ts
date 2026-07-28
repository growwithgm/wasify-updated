import { withAuth, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return withAuth(async ({ supabase, userId }) => {
    const [config, rules, faqs, handoffs] = await Promise.all([
      supabase.from('chatbot_config').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('chatbot_rules').select('*').order('priority', { ascending: false }),
      supabase.from('chatbot_faqs').select('*').order('used_count', { ascending: false }),
      supabase
        .from('chatbot_handoffs')
        .select('*, contacts:contact_id (name, phone)')
        .order('created_at', { ascending: false })
        .limit(20),
    ])

    return {
      config: config.data,
      rules: rules.data ?? [],
      faqs: faqs.data ?? [],
      handoffs: handoffs.data ?? [],
    }
  })
}

export async function PATCH(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody(request)
    const patch: Record<string, unknown> = {}
    for (const k of [
      'rules_enabled', 'faq_enabled', 'business_hours_only', 'handoff_enabled', 'handoff_rules',
      'ai_persona', 'ai_tone', 'ai_languages', 'ai_allowed_topics', 'ai_confidence_threshold',
    ]) {
      if (k in body) patch[k] = body[k]
    }

    // ai_enabled stays server-controlled while the AI engine is parked.
    const { data, error } = await supabase
      .from('chatbot_config')
      .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' })
      .select('*')
      .single()

    if (error) throw new Error(error.message)
    return { config: data }
  })
}
