import { withAuth } from '@/lib/api'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Everything the popup admin page needs in one call: the popup config,
 * the discount + template options, and the stats.
 *
 * popup_events is service-role-only (RLS with no policy), so the counts go
 * through the service client with an EXPLICIT user_id filter — same pattern
 * as the stock-alerts page.
 */
export async function GET() {
  return withAuth(async ({ supabase, userId }) => {
    const service = createServiceClient()

    const [cfg, discounts, templates, impressions, submits] = await Promise.all([
      supabase
        .from('shopify_config')
        .select(
          'popup_enabled, popup_include_paths, popup_exclude_paths, popup_heading, popup_subheading, popup_button_text, popup_success_text, popup_consent_text, popup_disclaimer, popup_trigger, popup_trigger_value, popup_dismiss_days, popup_discount_id, popup_template'
        )
        .maybeSingle(),
      supabase
        .from('discounts')
        .select('id, label, discount_type, percentage, amount, currency, expiry_days, enabled')
        .order('created_at', { ascending: false }),
      supabase
        .from('message_templates')
        .select('id, name, language, body_text')
        .eq('status', 'APPROVED')
        .order('name'),
      service
        .from('popup_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('event', 'impression'),
      service
        .from('popup_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('event', 'submit'),
    ])

    return {
      config: cfg.data,
      discounts: discounts.data ?? [],
      templates: templates.data ?? [],
      stats: {
        impressions: impressions.count ?? 0,
        submits: submits.count ?? 0,
      },
    }
  })
}
