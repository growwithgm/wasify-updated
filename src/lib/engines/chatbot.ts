import { sendWhatsApp } from '@/lib/whatsapp/send'
import { canSendFreeText } from '@/lib/window'
import { matchesKeyword, normalize, recordOutbound, type InboundCtx } from './types'

/**
 * Deterministic chatbot: keyword rules first, then FAQ matching.
 *
 * The AI agent (LLM persona, intent classification, confidence-threshold
 * handoff) is deliberately NOT wired up yet — `chatbot_config.ai_enabled`
 * gates it and defaults to false, so no model is ever called. The columns and
 * the settings UI exist so turning it on later is a config change, not a
 * migration. Everything below works with zero API keys and zero per-message cost.
 */

export async function runChatbotForInbound(ctx: InboundCtx): Promise<boolean> {
  const { db, userId } = ctx
  if (!ctx.text?.trim()) return false

  const { data: config } = await db
    .from('chatbot_config')
    .select('rules_enabled, faq_enabled, ai_enabled, business_hours_only')
    .eq('user_id', userId)
    .maybeSingle()

  if (!config) return false

  // Never reply into a closed window — that would be a policy violation.
  const { data: conv } = await db
    .from('conversations')
    .select('last_inbound_at, assigned_to')
    .eq('id', ctx.conversationId)
    .maybeSingle()

  if (!canSendFreeText(conv?.last_inbound_at)) return false

  // A human already owns this conversation — stay out of it.
  if (conv?.assigned_to) return false

  if (config.business_hours_only && !(await isWithinBusinessHours(db, userId))) return false

  /* ------------------------------ rules ------------------------------ */
  if (config.rules_enabled) {
    const { data: rules } = await db
      .from('chatbot_rules')
      .select('id, keywords, match_type, reply_text, hit_count')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('priority', { ascending: false })

    for (const rule of rules ?? []) {
      if (!ruleMatches(rule, ctx.text)) continue

      const res = await sendWhatsApp(userId, ctx.phone, { kind: 'text', body: rule.reply_text })
      await recordOutbound(ctx, { content: rule.reply_text, wamid: res.ok ? res.wamid : undefined })

      await db
        .from('chatbot_rules')
        .update({ hit_count: (rule.hit_count ?? 0) + 1, last_hit_at: new Date().toISOString() })
        .eq('id', rule.id)

      return true
    }
  }

  /* ------------------------------- FAQ ------------------------------- */
  if (config.faq_enabled) {
    const { data: faqs } = await db
      .from('chatbot_faqs')
      .select('id, question, answer, keywords, used_count')
      .eq('user_id', userId)
      .eq('is_active', true)

    const best = bestFaq(faqs ?? [], ctx.text)
    if (best) {
      const res = await sendWhatsApp(userId, ctx.phone, { kind: 'text', body: best.faq.answer })
      await recordOutbound(ctx, { content: best.faq.answer, wamid: res.ok ? res.wamid : undefined })

      await db
        .from('chatbot_faqs')
        .update({ used_count: (best.faq.used_count ?? 0) + 1 })
        .eq('id', best.faq.id)

      return true
    }
  }

  // AI fallback would go here once ai_enabled is switched on.
  return false
}

function ruleMatches(rule: any, text: string): boolean {
  const keywords: string[] = rule.keywords ?? []
  if (!keywords.length) return false

  const haystack = normalize(text)

  return keywords.some((k) => {
    const needle = normalize(k)
    switch (rule.match_type) {
      case 'exact':
        return haystack === needle
      case 'starts_with':
        return haystack.startsWith(needle)
      case 'regex':
        try {
          return new RegExp(k, 'i').test(text)
        } catch {
          return false
        }
      default:
        return matchesKeyword(text, k)
    }
  })
}

/**
 * Token-overlap scoring — no embeddings, no API call. A FAQ wins when it
 * shares enough distinctive words with the question. The threshold is
 * deliberately conservative: a wrong answer is worse than no answer.
 */
const MIN_SCORE = 0.45
/** Score awarded when one of the FAQ's curated keywords matches as a whole word. */
const KEYWORD_SCORE = 0.8
const STOPWORDS = new Set([
  'que', 'como', 'para', 'con', 'los', 'las', 'del', 'una', 'uno', 'por', 'the', 'and',
  'you', 'your', 'for', 'are', 'can', 'have', 'this', 'what', 'how', 'when', 'does', 'hola',
])

function tokenize(input: string): string[] {
  return normalize(input)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
}

export function bestFaq(faqs: any[], question: string): { faq: any; score: number } | null {
  const asked = new Set(tokenize(question))
  if (asked.size === 0) return null

  let winner: { faq: any; score: number } | null = null

  for (const faq of faqs) {
    // An explicit keyword is a curated signal — the merchant added it precisely
    // to catch phrasings the question text does not contain, so a whole-word
    // hit on one counts for far more than an incidental word in common.
    const keywordHit = (faq.keywords ?? []).some((k: string) => matchesKeyword(question, k))

    const candidate = new Set(tokenize(faq.question))
    let shared = 0
    for (const word of asked) if (candidate.has(word)) shared++

    // Normalise by the shorter side so a long FAQ is not penalised.
    const overlap = candidate.size ? shared / Math.min(asked.size, candidate.size) : 0
    const score = keywordHit ? Math.max(KEYWORD_SCORE, overlap) : overlap

    if (score >= MIN_SCORE && (!winner || score > winner.score)) {
      winner = { faq, score }
    }
  }

  return winner
}

async function isWithinBusinessHours(db: any, userId: string): Promise<boolean> {
  const { data: settings } = await db
    .from('settings')
    .select('business_hours, timezone')
    .eq('user_id', userId)
    .maybeSingle()

  const hours = settings?.business_hours ?? []
  if (!Array.isArray(hours) || hours.length === 0) return true

  const tz = settings?.timezone || 'Europe/Madrid'
  const now = new Date()

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const weekdayName = parts.find((p) => p.type === 'weekday')?.value ?? ''
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)

  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName)
  const today = hours.find((h: any) => Number(h.day) === dayIndex)

  if (!today || today.closed) return false

  const minutes = hour * 60 + minute
  const [openH, openM] = String(today.open ?? '09:00').split(':').map(Number)
  const [closeH, closeM] = String(today.close ?? '18:00').split(':').map(Number)

  return minutes >= openH * 60 + openM && minutes <= closeH * 60 + closeM
}
