import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AppShell, type ShellContext } from '@/components/shell/AppShell'

export const dynamic = 'force-dynamic'

/** Human labels for Meta's quality / tier enums. */
const QUALITY: Record<string, string> = { GREEN: 'High', YELLOW: 'Medium', RED: 'Low' }
const TIER: Record<string, string> = {
  TIER_50: '50/24h',
  TIER_250: '250/24h',
  TIER_1K: '1K/24h',
  TIER_10K: '10K/24h',
  TIER_100K: '100K/24h',
  TIER_UNLIMITED: 'Unlimited',
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const [profileRes, shopifyRes, waRes, convRes, notifRes] = await Promise.all([
    supabase.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle(),
    supabase.from('shopify_config').select('store_name, store_domain, connection_status').maybeSingle(),
    supabase
      .from('whatsapp_config')
      .select('connection_status, quality_rating, messaging_tier, display_phone_number')
      .maybeSingle(),
    supabase.from('conversations').select('unread_count'),
    supabase
      .from('notifications')
      .select('id, kind, text, created_at, read_at')
      .order('created_at', { ascending: false })
      .limit(15),
  ])

  const wa = waRes.data
  const ctx: ShellContext = {
    userName: profileRes.data?.full_name || user.email?.split('@')[0] || 'You',
    userEmail: profileRes.data?.email || user.email || '',
    storeName: shopifyRes.data?.store_name ?? null,
    storeDomain: shopifyRes.data?.store_domain ?? null,
    whatsappConnected: wa?.connection_status === 'connected',
    qualityRating: wa?.quality_rating ? (QUALITY[wa.quality_rating] ?? wa.quality_rating) : null,
    messagingTier: wa?.messaging_tier ? (TIER[wa.messaging_tier] ?? wa.messaging_tier) : null,
    unreadCount: (convRes.data ?? []).reduce((sum, r: any) => sum + (r.unread_count ?? 0), 0),
    notifications: (notifRes.data ?? []) as ShellContext['notifications'],
  }

  return <AppShell ctx={ctx}>{children}</AppShell>
}
