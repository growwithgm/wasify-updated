import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return withAuth(async ({ supabase }) => {
    const [pipelines, stages, deals, agents] = await Promise.all([
      supabase.from('pipelines').select('*').order('created_at'),
      supabase.from('pipeline_stages').select('*').order('position'),
      supabase
        .from('deals')
        .select('*, contacts:contact_id (id, name, phone)')
        .is('closed_at', null)
        .order('position'),
      supabase.from('agents').select('id, name'),
    ])

    return {
      pipelines: pipelines.data ?? [],
      stages: stages.data ?? [],
      deals: deals.data ?? [],
      agents: agents.data ?? [],
    }
  })
}

export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const { name } = await jsonBody<{ name: string }>(request)
    if (!name?.trim()) badRequest('Pipeline name is required')

    const { data, error } = await supabase
      .from('pipelines')
      .insert({ user_id: userId, name })
      .select('*')
      .single()
    if (error) badRequest(error.message)

    await supabase.from('pipeline_stages').insert(
      [
        ['New lead', 10, false, false],
        ['Qualified', 30, false, false],
        ['Quote sent', 55, false, false],
        ['Negotiation', 75, false, false],
        ['Won', 100, true, false],
        ['Lost', 0, false, true],
      ].map(([name, prob, won, lost], i) => ({
        user_id: userId,
        pipeline_id: data.id,
        name,
        position: i,
        win_probability: prob,
        is_won: won,
        is_lost: lost,
      }))
    )

    return { pipeline: data }
  })
}
