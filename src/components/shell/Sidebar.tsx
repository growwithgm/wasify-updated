'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  IconAnalytics, IconBroadcasts, IconCarts, IconCatalog, IconChatbot, IconChevronLeft, IconChevronRight,
  IconContacts, IconDashboard, IconFlows, IconInbox, IconIntegrations, IconPipelines,
  IconSegments, IconSettings, IconTemplates, IconWhatsApp,
} from '@/components/icons'

export const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', Icon: IconDashboard },
  { href: '/inbox', label: 'Inbox', Icon: IconInbox, badgeKey: 'unread' as const },
  { href: '/contacts', label: 'Contacts', Icon: IconContacts },
  { href: '/segments', label: 'Segments', Icon: IconSegments },
  { href: '/broadcasts', label: 'Broadcasts', Icon: IconBroadcasts },
  { href: '/templates', label: 'Templates', Icon: IconTemplates },
  { href: '/flows', label: 'Flows', Icon: IconFlows },
  { href: '/chatbot', label: 'AI Chatbot', Icon: IconChatbot },
  { href: '/carts', label: 'Abandoned carts', Icon: IconCarts },
  { href: '/catalog', label: 'Catalog', Icon: IconCatalog },
  { href: '/pipelines', label: 'Pipelines', Icon: IconPipelines },
  { href: '/analytics', label: 'Analytics', Icon: IconAnalytics },
  { href: '/integrations', label: 'Integrations', Icon: IconIntegrations },
  { href: '/settings', label: 'Settings', Icon: IconSettings },
]

export function Sidebar({
  expanded,
  onToggle,
  unread,
}: {
  expanded: boolean
  onToggle: () => void
  unread: number
}) {
  const pathname = usePathname()

  return (
    <div
      data-r="rail"
      className="flex flex-col overflow-hidden transition-[width,min-width] duration-200"
      style={{ width: expanded ? 232 : 64, minWidth: expanded ? 232 : 64, background: '#0B1F16' }}
    >
      <div className="flex items-center gap-2.5 px-4 pt-[18px] pb-3.5">
        <div
          className="flex h-8 w-8 min-w-8 items-center justify-center rounded-[9px]"
          style={{ background: '#16A34A' }}
        >
          <IconWhatsApp size={18} style={{ color: '#fff' }} />
        </div>
        {expanded && (
          <div
            className="text-[19px] font-extrabold tracking-[-0.02em] text-white"
            style={{ fontFamily: "'Manrope', sans-serif" }}
          >
            Wasify
          </div>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 py-1.5 w-noscroll">
        {NAV_ITEMS.map(({ href, label, Icon, badgeKey }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`)
          const badge = badgeKey === 'unread' && unread > 0 ? (unread > 99 ? '99+' : String(unread)) : null
          return (
            <Link
              key={href}
              href={href}
              title={expanded ? undefined : label}
              className="flex items-center gap-[11px] rounded-lg px-2.5 py-[9px] text-[13.5px] whitespace-nowrap no-underline transition-colors hover:!text-white"
              style={{
                background: active ? 'rgba(255,255,255,.1)' : 'transparent',
                color: active ? '#FFFFFF' : '#9CA3AF',
                fontWeight: active ? 600 : 500,
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = 'rgba(255,255,255,.08)'
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent'
              }}
            >
              <span className="flex w-5 min-w-5">
                <Icon size={20} />
              </span>
              {expanded && (
                <>
                  <span className="flex-1">{label}</span>
                  {badge && (
                    <span
                      className="rounded-full px-[7px] py-px text-[11px] font-bold text-white"
                      style={{ background: '#22C55E' }}
                    >
                      {badge}
                    </span>
                  )}
                </>
              )}
            </Link>
          )
        })}
      </nav>

      <button
        onClick={onToggle}
        className="flex cursor-pointer items-center gap-2.5 border-0 bg-transparent px-4 py-3 text-[12.5px] transition-colors hover:text-white"
        style={{ borderTop: '1px solid rgba(255,255,255,.08)', color: '#9CA3AF' }}
      >
        {expanded ? <IconChevronLeft size={18} /> : <IconChevronRight size={18} />}
        {expanded && <span>Collapse</span>}
      </button>
    </div>
  )
}
