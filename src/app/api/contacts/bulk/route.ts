import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Bulk tag / untag / opt-out / delete from the Contacts selection bar. */
export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const { ids, action, tag_id } = await jsonBody<{
      ids: string[]
      action: 'tag' | 'untag' | 'opt_out' | 'delete'
      tag_id?: string
    }>(request)

    if (!Array.isArray(ids) || ids.length === 0) badRequest('No contacts selected')

    switch (action) {
      case 'tag': {
        if (!tag_id) badRequest('Pick a tag')
        const rows = ids.map((contact_id) => ({ user_id: userId, contact_id, tag_id }))
        for (let i = 0; i < rows.length; i += 500) {
          await supabase
            .from('contact_tags')
            .upsert(rows.slice(i, i + 500), { onConflict: 'contact_id,tag_id' })
        }
        break
      }

      case 'untag': {
        if (!tag_id) badRequest('Pick a tag')
        await supabase.from('contact_tags').delete().eq('tag_id', tag_id).in('contact_id', ids)
        break
      }

      case 'opt_out': {
        const now = new Date().toISOString()
        await supabase
          .from('contacts')
          .update({ opt_in_status: 'opted_out', opt_out_at: now, accepts_marketing: false })
          .in('id', ids)

        // Suppress the numbers too, so a broadcast can never reach them.
        const { data: contacts } = await supabase.from('contacts').select('id, phone').in('id', ids)
        const rows = (contacts ?? []).map((c: any) => ({
          user_id: userId,
          phone: c.phone,
          contact_id: c.id,
          reason: 'opt_out',
          source: 'bulk action',
        }))
        if (rows.length) {
          await supabase.from('suppression_list').upsert(rows, { onConflict: 'user_id,phone' })
        }

        await supabase.from('consent_events').insert(
          ids.map((contact_id) => ({
            user_id: userId,
            contact_id,
            event: 'opt_out',
            source: 'manual',
            detail: 'Bulk opt-out from the Contacts screen',
          }))
        )
        break
      }

      case 'delete': {
        await supabase.from('contacts').delete().in('id', ids)
        break
      }

      default:
        badRequest(`Unknown action "${action}"`)
    }

    return { ok: true, count: ids.length }
  })
}
