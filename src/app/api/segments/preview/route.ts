import { withAuth, jsonBody } from '@/lib/api'
import { previewDefinition } from '@/lib/engines/segments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Live count + sample rows for the segment builder, without saving. */
export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const { definition } = await jsonBody<{ definition: any }>(request)
    const contacts = await previewDefinition(supabase, userId, definition ?? { op: 'and', groups: [] })
    return {
      count: contacts.length,
      sample: contacts.slice(0, 20).map((c: any) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        lifetime_spent: c.lifetime_spent,
        orders_count: c.orders_count,
        rfm_segment: c.rfm_segment,
      })),
    }
  })
}
