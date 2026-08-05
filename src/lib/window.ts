/**
 * The 24-hour customer-service window.
 *
 * Meta only allows free-form messages within 24h of the customer's LAST
 * INBOUND message. Outbound messages never extend it — that mistake is what
 * gets accounts flagged, so the rule lives in exactly one place.
 */

export const WINDOW_MS = 24 * 60 * 60 * 1000

export type WindowState = {
  open: boolean
  msRemaining: number
  /** "22h 14m" while open, "expired" once closed, "no messages" if never contacted. */
  label: string
}

export function sessionWindow(lastInboundAt: string | null | undefined): WindowState {
  if (!lastInboundAt) return { open: false, msRemaining: 0, label: 'no reply yet' }

  const elapsed = Date.now() - new Date(lastInboundAt).getTime()
  const remaining = WINDOW_MS - elapsed

  if (remaining <= 0) return { open: false, msRemaining: 0, label: 'expired' }

  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  return {
    open: true,
    msRemaining: remaining,
    label: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
  }
}

/** Can we send free text right now, or must it be a template? */
/**
 * Append a saved message to a thread exactly once.
 *
 * A send produces the row TWICE on the client: the realtime INSERT arrives,
 * and the POST returns the same row. The free-text path guarded against that;
 * the template path did not, so every template appeared twice in the inbox
 * while the customer had received it once.
 *
 * `replaceId` drops an optimistic placeholder in the same pass.
 */
export function appendMessage<T extends { id: string }>(
  prev: T[],
  message: T | null | undefined,
  replaceId?: string
): T[] {
  const base = replaceId ? prev.filter((m) => m.id !== replaceId) : prev
  if (!message) return base
  return base.some((m) => m.id === message.id) ? base : [...base, message]
}

export function canSendFreeText(lastInboundAt: string | null | undefined): boolean {
  return sessionWindow(lastInboundAt).open
}
