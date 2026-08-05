import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function base({ size = 20, ...rest }: P) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  }
}

export const IconDashboard = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />
  </svg>
)

export const IconInbox = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

export const IconContacts = (p: P) => (
  <svg {...base(p)}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
  </svg>
)

export const IconSegments = (p: P) => (
  <svg {...base(p)}>
    <path d="M22 3H2l8 9.46V19l4 2v-8.54z" />
  </svg>
)

export const IconBroadcasts = (p: P) => (
  <svg {...base(p)}>
    <path d="m3 11 18-8-8 18-2-7z" />
  </svg>
)

export const IconTemplates = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 21V9" />
  </svg>
)

export const IconFlows = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="15" y="15" width="6" height="6" rx="1" />
    <path d="M6 9v6a3 3 0 0 0 3 3h6" />
  </svg>
)

export const IconChatbot = (p: P) => (
  <svg {...base(p)}>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 4v4M9 14h.01M15 14h.01M2 13v2M22 13v2" />
  </svg>
)

export const IconCatalog = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 7h18l-1.5 12.2a2 2 0 0 1-2 1.8H6.5a2 2 0 0 1-2-1.8z" />
    <path d="M8.5 7V5.5a3.5 3.5 0 0 1 7 0V7" />
  </svg>
)

/** A cart left behind — the trolley with a clock. */
export const IconCarts = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.5 3.5h2l2.3 10.4a1.6 1.6 0 0 0 1.6 1.3h7.2" />
    <path d="M6.2 6.5h13l-1.4 6H7.5" />
    <circle cx="17.5" cy="18.5" r="3" />
    <path d="M17.5 17v1.6l1.1.7" />
    <circle cx="9" cy="19.5" r="1" />
  </svg>
)

export const IconPipelines = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="11" rx="1" />
    <rect x="17" y="4" width="4" height="7" rx="1" />
  </svg>
)

export const IconAnalytics = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 3v18h18" />
    <path d="m7 14 3-4 3 3 5-7" />
  </svg>
)

export const IconIntegrations = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 3v6H4v6h6v6M14 21v-6h6V9h-6V3" />
  </svg>
)

export const IconSettings = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.7H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9.4a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
)

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4-4" />
  </svg>
)

export const IconBell = (p: P) => (
  <svg {...base(p)}>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
)

export const IconChevronDown = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const IconChevronLeft = (p: P) => (
  <svg {...base(p)}>
    <path d="m15 6-6 6 6 6" />
  </svg>
)

export const IconChevronRight = (p: P) => (
  <svg {...base(p)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
)

export const IconMoon = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
  </svg>
)

export const IconSun = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    <circle cx="12" cy="12" r="4" />
  </svg>
)

export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconX = (p: P) => (
  <svg {...base(p)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export const IconSend = (p: P) => (
  <svg {...base(p)}>
    <path d="m3 11 18-8-8 18-2-7z" />
  </svg>
)

export const IconPaperclip = (p: P) => (
  <svg {...base(p)}>
    <path d="M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 0 1 5.18 5.18l-9.2 9.2a1.83 1.83 0 0 1-2.59-2.6l8.5-8.49" />
  </svg>
)

export const IconSmile = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" />
  </svg>
)

export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
)

export const IconEdit = (p: P) => (
  <svg {...base(p)}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
  </svg>
)

export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
)

export const IconDownload = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </svg>
)

export const IconUpload = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </svg>
)

export const IconFilter = (p: P) => (
  <svg {...base(p)}>
    <path d="M22 3H2l8 9.46V19l4 2v-8.54z" />
  </svg>
)

export const IconClock = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const IconAlert = (p: P) => (
  <svg {...base(p)}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
)

export const IconWhatsApp = ({ size = 20, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...rest}>
    <path
      d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.7-1.2A9 9 0 1 0 12 3Z"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
    />
    <path
      d="M8.5 10.5c.5 2.5 2.5 4.5 5 5l1.5-1.5 2 1c-.5 1.5-2 2-3.5 1.5-3-1-5.5-3.5-6.5-6.5C6.5 8.5 7 7 8.5 6.5l1 2-1 2Z"
      fill="currentColor"
    />
  </svg>
)

export const IconShopify = ({ size = 20, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
    <path d="M15.3 4.2c-.1 0-.3.1-.5.1l-.4-1c-.4-.8-1-1.2-1.7-1.2h-.2C12 1.5 11.4 1.2 10.7 1.2c-1.9 0-2.9 2.4-3.2 3.6l-1.4.4c-.4.1-.5.2-.5.6L4 20.6l10.1 1.9V4.1c-.1 0-.1.1-.2.1zM12 3.6l-1.6.5c.2-.9.6-1.8 1.3-2 .2.3.3.9.3 1.5zm-1.3-2c.2 0 .3 0 .4.1-.7.4-1.4 1.4-1.7 3l-1.3.4c.4-1.2 1.2-3.5 2.6-3.5zm3 1.9-.2.1c0-.6-.1-1.2-.3-1.6.4.1.7.7.9 1.5h-.4zM15.6 22.5l4.4-1.1L18 5.3c0-.2-.1-.3-.3-.3h-1.4c-.1 0-.4.1-.7.3v17.2z" />
  </svg>
)

export const IconMeta = ({ size = 20, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
    <path d="M6.9 5c-2.1 0-3.4 2-3.4 5.2 0 3.4 1.5 5.3 3.3 5.3 1.3 0 2.2-.7 3.4-2.6l1.1-1.9c.3-.6.6-1 .8-1.4.3.5.6 1 .9 1.6l1 1.7c1.4 2.3 2.3 2.6 3.4 2.6 1.9 0 3.1-1.9 3.1-5.4C20.5 6.9 19.2 5 17 5c-1.2 0-2.2.9-3.3 2.4-.8-1-1.5-1.6-2.2-2-.8-.3-1.6-.4-2.3-.4zm.2 2c.6 0 1.2.2 1.9.9.4.4.9 1 1.4 1.8l-.9 1.4c-1 1.6-1.5 2-2.2 2-.8 0-1.6-.9-1.6-3.1C5.7 8 6.3 7 7.1 7zm9.7 0c.9 0 1.6 1 1.6 3.2 0 2.2-.6 3-1.4 3-.7 0-1.2-.4-2.2-2l-.9-1.5c.4-.7.9-1.4 1.3-1.8.5-.6 1-.9 1.6-.9z" />
  </svg>
)
