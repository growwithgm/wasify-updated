import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { sanitizePhone, isValidPhone } from '@/lib/phone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const { phone, reason } = await jsonBody<{ phone: string; reason?: string }>(request)
    const digits = sanitizePhone(phone)
    if (!isValidPhone(digits)) badRequest('Enter a valid number with its country code')

    await supabase
      .from('suppression_list')
      .upsert(
        { user_id: userId, phone: digits, reason: reason || 'manual', source: 'settings' },
        { onConflict: 'user_id,phone' }
      )

    return { ok: true }
  })
}

/**
 * Removing a suppression is a consent decision, so it also clears the
 * contact's opted-out flag and records why.
 */
export async function DELETE(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) badRequest('id is required')

    const { data: row } = await supabase
      .from('suppression_list')
      .select('contact_id')
      .eq('id', id)
      .maybeSingle()

    await supabase.from('suppression_list').delete().eq('id', id)

    if (row?.contact_id) {
      await supabase
        .from('contacts')
        .update({ opt_in_status: 'unknown', opt_out_at: null })
        .eq('id', row.contact_id)

      await supabase.from('consent_events').insert({
        user_id: userId,
        contact_id: row.contact_id,
        event: 'resubscribe',
        source: 'manual',
        detail: 'Removed from the suppression list in Settings',
      })
    }

    return { ok: true }
  })
}
