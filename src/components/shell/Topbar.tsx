'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { IconBell, IconChevronDown, IconMoon, IconSearch, IconSun, IconWhatsApp } from '@/components/icons'
import { NAV_ITEMS } from './Sidebar'
import { initialsOf } from '@/lib/phone'

export type ShellNotification = {
  id: string
  kind: 'info' | 'success' | 'warning' | 'error'
  text: string
  created_at: string
  read_at: string | null
}

const DOT: Record<string, string> = {
  success: '#22C55E',
  info: '#2563EB',
  warning: '#F59E0B',
  error: '#EF4444',
}

function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export function Topbar({
  storeName,
  storeDomain,
  connected,
  qualityRating,
  messagingTier,
  userName,
  userEmail,
  notifications,
  dark,
  onToggleDark,
  onOpenMobileNav,
  currentLabel,
}: {
  storeName: string | null
  storeDomain: string | null
  connected: boolean
  qualityRating: string | null
  messagingTier: string | null
  userName: string
  userEmail: string
  notifications: ShellNotification[]
  dark: boolean
  onToggleDark: () => void
  onOpenMobileNav: () => void
  currentLabel: string
}) {
  const router = useRouter()
  const [storeOpen, setStoreOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const unreadNotifs = notifications.filter((n) => !n.read_at).length

  // ⌘K / Ctrl-K focuses search, Escape closes every popover.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'Escape') {
        setStoreOpen(false)
        setNotifOpen(false)
        setAvatarOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Any outside click dismisses the open popover.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-popover]')) {
        setStoreOpen(false)
        setNotifOpen(false)
        setAvatarOpen(false)
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  async function signOut() {
    await supabaseBrowser().auth.signOut()
    router.push('/login')
    router.refresh()
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (q) router.push(`/contacts?q=${encodeURIComponent(q)}`)
  }

  const popover =
    'absolute top-[42px] rounded-xl p-1.5 z-[60] border' as const
  const popoverStyle = {
    background: 'var(--w-card)',
    borderColor: 'var(--w-border)',
    boxShadow: '0 8px 24px rgba(16,24,40,.12)',
  }

  return (
    <div
      className="relative z-40 flex h-14 min-h-14 items-center gap-3 px-5"
      style={{ background: 'var(--w-card)', borderBottom: '1px solid var(--w-border)' }}
    >
      {/* mobile: logo + screen dropdown */}
      <div data-r="mobileonly" className="hidden items-center gap-[9px]">
        <span
          className="flex h-7 w-7 min-w-7 items-center justify-center rounded-lg"
          style={{ background: '#16A34A' }}
        >
          <IconWhatsApp size={16} style={{ color: '#fff' }} />
        </span>
        <button
          onClick={onOpenMobileNav}
          className="flex cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-lg border bg-transparent px-[11px] py-1.5 text-[13px] font-bold"
          style={{ borderColor: 'var(--w-border)', color: 'var(--w-text)' }}
        >
          {currentLabel}
          <IconChevronDown size={13} />
        </button>
      </div>

      <form
        onSubmit={submitSearch}
        data-r="search"
        className="flex w-[320px] items-center gap-2 rounded-lg border px-3 py-[7px]"
        style={{ background: 'var(--w-canvas)', borderColor: 'var(--w-border)' }}
      >
        <IconSearch size={15} style={{ color: '#6B7280' }} />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search contacts, orders, messages…"
          className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none"
        />
        <span
          data-r="hide"
          className="rounded border px-[5px] py-px text-[10.5px]"
          style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--w-muted)', borderColor: 'var(--w-border)' }}
        >
          ⌘K
        </span>
      </form>

      {/* store switcher */}
      <div data-r="hide" data-popover className="relative">
        <button
          onClick={() => {
            setStoreOpen((v) => !v)
            setNotifOpen(false)
            setAvatarOpen(false)
          }}
          className="flex cursor-pointer items-center gap-2 rounded-lg border bg-transparent px-[11px] py-1.5 text-[13px] font-semibold"
          style={{ borderColor: 'var(--w-border)', color: 'var(--w-text)' }}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: connected ? '#22C55E' : '#EF4444' }}
          />
          {storeName || 'No store connected'}
          <IconChevronDown size={13} />
        </button>
        {storeOpen && (
          <div className={`${popover} left-0 w-[260px]`} style={popoverStyle}>
            <div
              className="px-2.5 pt-2 pb-1 text-[11px] font-bold uppercase tracking-[.05em]"
              style={{ color: 'var(--w-muted)' }}
            >
              Shopify store
            </div>
            {storeDomain ? (
              <div
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
                style={{ background: 'var(--w-greentint)' }}
              >
                <span
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-bold"
                  style={{ background: '#fff', color: '#16A34A' }}
                >
                  {initialsOf(storeName)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{storeName}</span>
                  <span className="block truncate text-[11px]" style={{ color: 'var(--w-muted)' }}>
                    {storeDomain}
                  </span>
                </span>
              </div>
            ) : (
              <div className="px-2.5 py-2 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                No store connected yet.
              </div>
            )}
            <div className="mt-1.5 pt-1.5" style={{ borderTop: '1px solid var(--w-border)' }}>
              <a href="/integrations" className="block rounded-lg px-2.5 py-2 text-[12.5px] no-underline">
                Manage connection →
              </a>
              <div className="px-2.5 pb-1 text-[11px]" style={{ color: 'var(--w-muted)' }}>
                Multi-store is on the roadmap — one store per account today.
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* dark mode */}
      <button
        onClick={onToggleDark}
        title={dark ? 'Switch to light' : 'Switch to dark'}
        className="flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-lg border bg-transparent"
        style={{ borderColor: 'var(--w-border)', color: 'var(--w-muted)' }}
      >
        {dark ? <IconSun size={17} /> : <IconMoon size={17} />}
      </button>

      {/* bell */}
      <div data-popover className="relative">
        <button
          onClick={() => {
            setNotifOpen((v) => !v)
            setStoreOpen(false)
            setAvatarOpen(false)
          }}
          className="relative flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-lg border bg-transparent"
          style={{ borderColor: 'var(--w-border)', color: 'var(--w-muted)' }}
        >
          <IconBell size={17} />
          {unreadNotifs > 0 && (
            <span
              className="absolute right-1.5 top-[5px] h-2 w-2 rounded-full"
              style={{ background: '#EF4444', border: '2px solid var(--w-card)' }}
            />
          )}
        </button>
        {notifOpen && (
          <div className={`${popover} right-0 w-[330px]`} style={popoverStyle}>
            <div className="px-3 pt-2.5 pb-1.5 text-[13px] font-bold">Notifications</div>
            {notifications.length === 0 && (
              <div className="px-3 py-4 text-center text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                Nothing yet — you&apos;re all caught up.
              </div>
            )}
            {notifications.slice(0, 8).map((n) => (
              <div key={n.id} className="flex cursor-pointer gap-2.5 rounded-lg px-3 py-[9px]">
                <span
                  className="mt-[5px] h-2 w-2 min-w-2 rounded-full"
                  style={{ background: DOT[n.kind] ?? '#2563EB' }}
                />
                <span>
                  <span className="block text-[12.5px] font-medium">{n.text}</span>
                  <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--w-muted)' }}>
                    {timeAgo(n.created_at)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* avatar */}
      <div data-popover className="relative">
        <button
          onClick={() => {
            setAvatarOpen((v) => !v)
            setStoreOpen(false)
            setNotifOpen(false)
          }}
          className="flex cursor-pointer items-center gap-2 rounded-full border-0 bg-transparent p-0"
        >
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full text-[12.5px] font-bold text-white"
            style={{ background: '#16A34A' }}
          >
            {initialsOf(userName, userEmail)}
          </span>
        </button>
        {avatarOpen && (
          <div className={`${popover} right-0 w-[230px]`} style={popoverStyle}>
            <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--w-border)' }}>
              <span className="block text-[13px] font-bold">{userName}</span>
              <span className="block truncate text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                Owner · {userEmail}
              </span>
            </div>
            {connected && (
              <div className="px-3 py-2 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                Quality {qualityRating || '—'} · Tier {messagingTier || '—'}
              </div>
            )}
            <a href="/settings" className="block rounded-lg px-3 py-2 text-[13px] no-underline" style={{ color: 'var(--w-text)' }}>
              Profile &amp; business
            </a>
            <a href="/integrations" className="block rounded-lg px-3 py-2 text-[13px] no-underline" style={{ color: 'var(--w-text)' }}>
              Integrations
            </a>
            <button
              onClick={signOut}
              className="w-full cursor-pointer rounded-lg border-0 bg-transparent px-3 py-2 text-left text-[13px]"
              style={{ color: '#EF4444' }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export { NAV_ITEMS }
