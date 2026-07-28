import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return withAuth(async ({ supabase }) => {
    const { data } = await supabase
      .from('tags')
      .select('id, name, color, contact_tags(count)')
      .order('name')
    return {
      tags: (data ?? []).map((t: any) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        count: t.contact_tags?.[0]?.count ?? 0,
      })),
    }
  })
}

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const { name, color } = await jsonBody<{ name: string; color?: string }>(request)
    const label = (name ?? '').trim()
    if (!label) badRequest('Tag name is required')

    const { data, error } = await supabase
      .from('tags')
      .insert({ user_id: userId, name: label, color: color || '#16A34A' })
      .select('*')
      .single()

    if (error) badRequest(error.code === '23505' ? 'That tag already exists' : error.message)
    return { tag: data }
  })
}
