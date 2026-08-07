import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * COD + cart-recovery feature configuration.
 *
 * Deliberately allow-listed: this endpoint must never be able to write
 * access_token, store_domain or any other credential column.
 */
const EDITABLE = [
  'cod_enabled', 'cod_gateways', 'cod_confirm_template', 'cod_confirm_var_map',
  'cod_reminder_count', 'cod_reminder1_hours', 'cod_reminder1_template', 'cod_reminder1_var_map',
  'cod_reminder2_hours', 'cod_reminder2_template', 'cod_reminder2_var_map',
  'cod_no_reply_hours', 'cod_no_reply_template', 'cod_no_reply_var_map',
  'cod_confirmed_template', 'cod_confirmed_var_map', 'cod_cancelled_template', 'cod_cancelled_var_map',
  'cod_tag_pending', 'cod_tag_confirmed', 'cod_tag_cancelled',
  'cod_yes_keywords', 'cod_no_keywords', 'cod_confirmed_reply', 'cod_cancelled_reply',

  'recovery_enabled', 'recovery_delay1_minutes', 'recovery_delay2_minutes', 'recovery_delay3_minutes',
  'recovery_cooldown_days', 'recovery_max_age_hours', 'recovery_stop_keywords',
  'recovery_r1_template_es', 'recovery_r1_template_en', 'recovery_r1_var_map', 'recovery_r1_discount_id',
  'recovery_r2_template_es', 'recovery_r2_template_en', 'recovery_r2_var_map', 'recovery_r2_discount_id',
  'recovery_r3_template_es', 'recovery_r3_template_en', 'recovery_r3_var_map', 'recovery_r3_discount_id',

  'orderconf_enabled', 'orderconf_template', 'orderconf_language', 'orderconf_track_clicks',

  'bis_enabled', 'bis_template_es', 'bis_template_en',
]

export async function PATCH(request: Request) {
  return withAuth(async ({ supabase }) => {
    const body = await jsonBody<any>(request)

    const patch: Record<string, unknown> = {}
    for (const key of EDITABLE) if (key in body) patch[key] = body[key]

    if (Object.keys(patch).length === 0) badRequest('Nothing to update')

    const { data, error } = await supabase
      .from('shopify_config')
      .update(patch)
      .not('id', 'is', null)
      .select('id')
      .maybeSingle()

    if (error) badRequest(error.message)
    if (!data) badRequest('Connect a Shopify store first')

    return { ok: true }
  })
}
