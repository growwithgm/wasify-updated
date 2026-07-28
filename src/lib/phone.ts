/**
 * Phone handling. These rules are load-bearing: the webhook, new-chat,
 * COD replies and cart recovery must all agree on what "the same person"
 * means, otherwise conversation threads split.
 *
 * Storage rule: digits only, no '+', no spaces, country code included.
 */

/** Strip everything that is not a digit. */
export function sanitizePhone(input: string | null | undefined): string {
  return (input ?? '').replace(/\D/g, '')
}

/**
 * E.164-ish validity: 7–15 digits and the first digit is not 0
 * (a leading 0 means a trunk prefix was left on and the country code is missing).
 */
export function isValidPhone(input: string | null | undefined): boolean {
  const d = sanitizePhone(input)
  return d.length >= 7 && d.length <= 15 && d[0] !== '0'
}

/**
 * Do two numbers belong to the same person?
 * Exact digit match, or the last 8 digits agree — the latter absorbs
 * trunk-zero and country-code formatting differences without being so
 * loose that unrelated numbers collide.
 */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = sanitizePhone(a)
  const y = sanitizePhone(b)
  if (!x || !y) return false
  if (x === y) return true
  if (x.length < 8 || y.length < 8) return false
  return x.slice(-8) === y.slice(-8)
}

/**
 * Candidate numbers to retry a send with. Meta error #131030 (and some
 * sandbox setups) reject a number that only differs by a trunk zero, so we
 * try the alternates in order.
 */
export function phoneVariants(input: string): string[] {
  const d = sanitizePhone(input)
  if (!d) return []
  const out = new Set<string>([d])

  // Drop a trunk 0 that follows a 1–3 digit country code: 34 0 600… -> 34 600…
  for (let cc = 1; cc <= 3 && cc < d.length; cc++) {
    if (d[cc] === '0') out.add(d.slice(0, cc) + d.slice(cc + 1))
  }
  // …and the reverse, inserting a trunk 0 after a 2-digit country code.
  if (d.length >= 10) out.add(`${d.slice(0, 2)}0${d.slice(2)}`)

  return [...out]
}

/** Pretty form for the UI: +34 600 123 456 style grouping. */
export function formatPhone(input: string | null | undefined): string {
  const d = sanitizePhone(input)
  if (!d) return ''
  if (d.length <= 6) return `+${d}`
  const cc = d.length > 11 ? d.slice(0, 2) : d.slice(0, d.length - 9 > 0 ? d.length - 9 : 2)
  const rest = d.slice(cc.length)
  return `+${cc} ${rest.replace(/(\d{3})(?=\d)/g, '$1 ')}`.trim()
}

/**
 * Pull the best phone out of a Shopify order/checkout payload.
 * Shopify scatters the number across several optional places.
 */
export function extractShopifyPhone(payload: Record<string, unknown>): string {
  const p = payload as Record<string, any>
  const candidates = [
    p?.phone,
    p?.customer?.phone,
    p?.shipping_address?.phone,
    p?.billing_address?.phone,
    p?.customer?.default_address?.phone,
    p?.shipping_address?.phone_number,
  ]
  for (const c of candidates) {
    const d = sanitizePhone(typeof c === 'string' ? c : '')
    if (isValidPhone(d)) return d
  }
  return ''
}

/** Deterministic avatar colour so a contact keeps the same colour everywhere. */
const AVATAR_COLORS = [
  ['#F0FDF4', '#16A34A'],
  ['#EFF6FF', '#2563EB'],
  ['#FFFBEB', '#B45309'],
  ['#FDF2F8', '#DB2777'],
  ['#F5F3FF', '#7C3AED'],
  ['#ECFEFF', '#0891B2'],
  ['#FEF2F2', '#DC2626'],
  ['#F7FEE7', '#4D7C0F'],
] as const

export function avatarColors(seed: string): { bg: string; fg: string } {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const [bg, fg] = AVATAR_COLORS[h % AVATAR_COLORS.length]
  return { bg, fg }
}

export function initialsOf(name: string | null | undefined, phone?: string | null): string {
  const n = (name ?? '').trim()
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean)
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }
  const d = sanitizePhone(phone)
  return d ? d.slice(-2) : '??'
}
