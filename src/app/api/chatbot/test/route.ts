import { withAuth, jsonBody } from '@/lib/api'
import { bestFaq } from '@/lib/engines/chatbot'
import { matchesKeyword, normalize } from '@/lib/engines/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Dry-run the bot against a message without sending anything.
 * Runs the exact same matchers the webhook uses, so what you see here is
 * what a real customer would get.
 */
export async function POST(request: Request) {
  return withAuth(async ({ supabase }) => {
    const { text } = await jsonBody<{ text: string }>(request)

    const [rulesRes, faqRes] = await Promise.all([
      supabase.from('chatbot_rules').select('*').eq('is_active', true).order('priority', { ascending: false }),
      supabase.from('chatbot_faqs').select('*').eq('is_active', true),
    ])

    for (const rule of rulesRes.data ?? []) {
      const hit = (rule.keywords ?? []).some((k: string) => {
        if (rule.match_type === 'exact') return normalize(text) === normalize(k)
        if (rule.match_type === 'starts_with') return normalize(text).startsWith(normalize(k))
        if (rule.match_type === 'regex') {
          try {
            return new RegExp(k, 'i').test(text)
          } catch {
            return false
          }
        }
        return matchesKeyword(text, k)
      })
      if (hit) {
        return { matched: 'rule', reply: rule.reply_text, keywords: rule.keywords, ruleId: rule.id }
      }
    }

    const faq = bestFaq(faqRes.data ?? [], text)
    if (faq) {
      return {
        matched: 'faq',
        reply: faq.faq.answer,
        question: faq.faq.question,
        score: Number(faq.score.toFixed(2)),
        faqId: faq.faq.id,
      }
    }

    return { matched: 'none', reply: null }
  })
}
