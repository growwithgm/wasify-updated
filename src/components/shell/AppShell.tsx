'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sidebar, NAV_ITEMS } from './Sidebar'
import { Topbar, type ShellNotification } from './Topbar'
import { supabaseBrowser } from '@/lib/supabase/client'

export type ShellContext = {
  userName: string
  userEmail: string
  storeName: string | null
  storeDomain: string | null
  whatsappConnected: boolean
  qualityRating: string | null
  messagingTier: string | null
  unreadCount: number
  notifications: ShellNotification[]
}

export function AppShell({ ctx, children }: { ctx: ShellContext; children: React.ReactNode }) {
  const pathname = usePathname()
  const [expanded, setExpanded] = useState(true)
  const [dark, setDark] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [unread, setUnread] = useState(ctx.unreadCount)
  const [notifs, setNotifs] = useState<ShellNotification[]>(ctx.notifications)

  // Collapse the rail on narrow desktop, exactly like the prototype.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1280px)')
    const apply = () => setExpanded(!mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  // Restore the theme before first paint of the app area.
  useEffect(() => {
    const saved = localStorage.getItem('wasify-theme')
    const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches
    const isDark = saved ? saved === 'dark' : prefers
    setDark(isDark)
    document.documentElement.toggleAttribute('data-dark', isDark)
  }, [])

  const toggleDark = useCallback(() => {
    setDark((prev) => {
      const next = !prev
      document.documentElement.toggleAttribute('data-dark', next)
      localStorage.setItem('wasify-theme', next ? 'dark' : 'light')
      return next
    })
  }, [])

  useEffect(() => setMenuOpen(false), [pathname])

  // Live unread badge + notification bell.
  useEffect(() => {
    const sb = supabaseBrowser()

    const refreshUnread = async () => {
      const { data } = await sb.from('conversations').select('unread_count')
      setUnread((data ?? []).reduce((sum: number, r: any) => sum + (r.unread_count ?? 0), 0))
    }

    const channel = sb
      .channel('shell')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, refreshUnread)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, (payload) => {
        setNotifs((prev) => [payload.new as ShellNotification, ...prev].slice(0, 20))
      })
      .subscribe()

    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshUnread()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      sb.removeChannel(channel)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const currentLabel = useMemo(
    () => NAV_ITEMS.find((n) => pathname.startsWith(n.href))?.label ?? 'Wasify',
    [pathname]
  )

  return (
    <div className="flex h-screen w-full overflow-hidden" style={{ background: 'var(--w-canvas)' }}>
      <Sidebar expanded={expanded} onToggle={() => setExpanded((v) => !v)} unread={unread} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          storeName={ctx.storeName}
          storeDomain={ctx.storeDomain}
          connected={ctx.whatsappConnected}
          qualityRating={ctx.qualityRating}
          messagingTier={ctx.messagingTier}
          userName={ctx.userName}
          userEmail={ctx.userEmail}
          notifications={notifs}
          dark={dark}
          onToggleDark={toggleDark}
          onOpenMobileNav={() => setMenuOpen((v) => !v)}
          currentLabel={currentLabel}
        />

        {menuOpen && (
          <>
            <div
              onClick={() => setMenuOpen(false)}
              className="fixed inset-x-0 bottom-0 top-14 z-[70]"
              style={{ background: 'rgba(15,23,42,.4)' }}
            />
            <div
              className="fixed left-2 right-2 top-14 z-[75] max-h-[calc(100vh-76px)] overflow-y-auto rounded-2xl border p-2"
              style={{
                background: 'var(--w-card)',
                borderColor: 'var(--w-border)',
                boxShadow: '0 16px 40px rgba(16,24,40,.25)',
              }}
            >
              <div
                className="px-2.5 pt-2 pb-1 text-[10.5px] font-bold uppercase tracking-[.06em]"
                style={{ color: 'var(--w-muted)' }}
              >
                Screens
              </div>
              {NAV_ITEMS.map(({ href, label, Icon, badgeKey }) => {
                const active = pathname.startsWith(href)
                const badge = badgeKey === 'unread' && unread > 0 ? String(unread) : null
                return (
                  <Link
                    key={href}
                    href={href}
                    className="flex min-h-11 items-center gap-[11px] rounded-[9px] px-3 py-[11px] text-sm no-underline"
                    style={{
                      background: active ? 'var(--w-greentint)' : 'transparent',
                      color: active ? '#15803D' : 'var(--w-text)',
                      fontWeight: active ? 700 : 500,
                    }}
                  >
                    <span className="flex w-5 min-w-5" style={{ color: active ? '#16A34A' : 'var(--w-muted)' }}>
                      <Icon size={20} />
                    </span>
                    <span className="flex-1">{label}</span>
                    {badge && (
                      <span
                        className="rounded-full px-2 py-px text-[11px] font-bold text-white"
                        style={{ background: '#22C55E' }}
                      >
                        {badge}
                      </span>
                    )}
                  </Link>
                )
              })}
              <div
                className="mt-1.5 px-3 pb-1.5 pt-2.5 text-[11.5px] leading-relaxed"
                style={{ borderTop: '1px solid var(--w-border)', color: 'var(--w-muted)' }}
              >
                <span className="flex items-center gap-[7px] font-semibold" style={{ color: '#16A34A' }}>
                  <span
                    className="h-[7px] w-[7px] rounded-full"
                    style={{ background: ctx.whatsappConnected ? '#22C55E' : '#EF4444' }}
                  />
                  {ctx.whatsappConnected
                    ? `Connected · Quality ${ctx.qualityRating || '—'} · Tier ${ctx.messagingTier || '—'}`
                    : 'WhatsApp not connected'}
                </span>
                <span className="mt-1 block">
                  Store: <b style={{ color: 'var(--w-text)' }}>{ctx.storeName || 'not connected'}</b>
                </span>
              </div>
            </div>
          </>
        )}

        <div id="w-screen-area" className="flex min-h-0 min-w-0 flex-1">
          {children}
        </div>
      </div>
    </div>
  )
}
