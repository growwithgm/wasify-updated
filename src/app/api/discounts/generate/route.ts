import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { createServiceClient } from '@/lib/supabase/server'
import { generateDiscountCodeForContact } from '@/lib/engines/discounts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** "Generate test code" — mints a real single-use Shopify code. */
export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const { discount_id, contact_id } = await jsonBody<{ discount_id: string; contact_id?: string }>(request)
    if (!discount_id) badRequest('Pick a discount')

    let contactId = contact_id
    if (!contactId) {
      const { data } = await supabase.from('contacts').select('id').limit(1).maybeSingle()
      if (!data) badRequest('Add at least one contact first — codes are minted per customer')
      contactId = data.id
    }

    const code = await generateDiscountCodeForContact(createServiceClient(), userId, discount_id, contactId!)
    if (!code) {
      badRequest(
        'Could not create the code. Check the store is connected and that the write_discounts scope was granted.'
      )
    }

    return { code }
  })
}
