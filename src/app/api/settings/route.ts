import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const EDITABLE = [
  'business_name', 'business_category', 'business_about', 'business_logo_url',
  'timezone', 'currency', 'business_hours',
  'greeting_enabled', 'greeting_message', 'away_enabled', 'away_message',
  'routing_rules', 'auto_close_hours', 'notify_email', 'notify_push',
]

export async function GET() {
  return withAuth(async ({ supabase, userId }) => {
    const [settings, profile, agents, canned, suppression] = await Promise.all([
      supabase.from('settings').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      supabase.from('agents').select('*').order('is_self', { ascending: false }).order('name'),
      supabase.from('canned_replies').select('*').order('shortcut'),
      supabase.from('suppression_list').select('*').order('created_at', { ascending: false }).limit(50),
    ])

    return {
      settings: settings.data,
      profile: profile.data,
      agents: agents.data ?? [],
      cannedReplies: canned.data ?? [],
      suppression: suppression.data ?? [],
    }
  })
}

export async function PATCH(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<any>(request)

    const patch: Record<string, unknown> = {}
    for (const key of EDITABLE) if (key in body) patch[key] = body[key]

    if (Object.keys(patch).length) {
      const { error } = await supabase
        .from('settings')
        .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' })
      if (error) badRequest(error.message)
    }

    if (body.full_name !== undefined) {
      await supabase.from('profiles').update({ full_name: body.full_name }).eq('id', userId)
      await supabase.from('agents').update({ name: body.full_name }).eq('is_self', true)
    }

    return { ok: true }
  })
}
