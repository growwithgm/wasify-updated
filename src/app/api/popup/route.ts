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
          // store_name feeds the admin's example-code preview; the popup_*
          // list must carry EVERY field the page edits, or saved values
          // silently reset to defaults on the next page load.
          'store_name, popup_enabled, popup_include_paths, popup_exclude_paths, popup_strip_locale, popup_heading, popup_subheading, popup_button_text, popup_success_text, popup_success_note, popup_success_button, popup_consent_text, popup_disclaimer, popup_trigger_exit, popup_trigger_delay, popup_trigger_delay_seconds, popup_trigger_scroll, popup_trigger_scroll_pct, popup_trigger_all, popup_dismiss_days, popup_teaser_enabled, popup_teaser_text, popup_teaser_position, popup_devices, popup_discount_id, popup_template, popup_code_mode, popup_fixed_code'
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
