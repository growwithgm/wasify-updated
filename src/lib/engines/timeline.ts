/**
 * Timeline — which SYSTEM produced an outbound send.
 *
 * There is no `source` column to lean on, and the merchant asked for no new
 * tables: every engine already stamps a stable, human-readable prefix into
 * messages.content when it mirrors a send into the inbox, so the system is
 * read from THAT. Broadcasts never mirror into messages — they keep their
 * own per-recipient rows — so the timeline API unions the two sources and
 * this classifier only handles the messages side.
 *
 * A new engine must add its prefix here to appear under its own name;
 * unknown template sends fall back to 'flow' rather than disappearing.
 */

export type TimelineSystem = 'popup' | 'recovery' | 'cod' | 'back_in_stock' | 'flow' | 'broadcast'

export const SYSTEM_LABELS: Record<TimelineSystem, string> = {
  popup: 'Popup welcome',
  recovery: 'Recovery',
  cod: 'COD',
  back_in_stock: 'Back in stock',
  flow: 'Flow',
  broadcast: 'Broadcast',
}

export function classifySend(content: string | null | undefined): {
  system: TimelineSystem
  detail: string | null
} {
  const c = (content ?? '').trim()
  if (/^popup welcome/i.test(c)) return { system: 'popup', detail: null }
  // Rows written before the stage number joined the mirror text still
  // classify as recovery — they just carry no R1/R2/R3 tag.
  const recovery = c.match(/^cart recovery reminder(?:\s+(\d))?/i)
  if (recovery) return { system: 'recovery', detail: recovery[1] ? `R${recovery[1]}` : null }
  if (/^cod confirmation/i.test(c)) return { system: 'cod', detail: null }
  if (/^back in stock/i.test(c)) return { system: 'back_in_stock', detail: null }
  if (/^order confirmation/i.test(c)) return { system: 'flow', detail: 'Order confirmation' }
  return { system: 'flow', detail: null }
}
