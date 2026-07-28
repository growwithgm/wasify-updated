import { withAuth, jsonBody, badRequest, notFound } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase }) => {
    const [flow, nodes, runs] = await Promise.all([
      supabase.from('flows').select('*').eq('id', id).maybeSingle(),
      supabase.from('flow_nodes').select('*').eq('flow_id', id).order('position'),
      supabase
        .from('flow_runs')
        .select('id, status, current_node, started_at, ended_at, contacts:contact_id (name, phone)')
        .eq('flow_id', id)
        .order('started_at', { ascending: false })
        .limit(30),
    ])
    if (!flow.data) notFound('Flow not found')
    return { flow: flow.data, nodes: nodes.data ?? [], runs: runs.data ?? [] }
  })
}

/** Replace the whole node list transactionally-ish; validate before activating. */
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase, userId }) => {
    const body = await jsonBody<any>(request)

    if (body.nodes) {
      const issues = validateNodes(body.nodes)
      if (body.status === 'active' && issues.length) {
        badRequest('Fix the validation issues before activating this flow', { issues })
      }

      await supabase.from('flow_nodes').delete().eq('flow_id', id)
      if (body.nodes.length) {
        await supabase.from('flow_nodes').insert(
          body.nodes.map((n: any, i: number) => ({
            user_id: userId,
            flow_id: id,
            node_key: n.node_key,
            position: i,
            node_type: n.node_type,
            config: n.config ?? {},
          }))
        )
      }
    }

    const patch: Record<string, unknown> = {}
    for (const k of ['name', 'description', 'status', 'trigger_type', 'trigger_config']) {
      if (k in body) patch[k] = body[k]
    }
    if (body.nodes) patch.version = (body.version ?? 1) + 1

    const { data, error } = await supabase.from('flows').update(patch).eq('id', id).select('*').single()
    if (error) badRequest(error.message)

    return { flow: data, issues: body.nodes ? validateNodes(body.nodes) : [] }
  })
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params
  return withAuth(async ({ supabase }) => {
    const { error } = await supabase.from('flows').delete().eq('id', id)
    if (error) badRequest(error.message)
    return { ok: true }
  })
}

/** Structural checks the editor surfaces as clickable issues. */
export function validateNodes(nodes: any[]): Array<{ node_key: string; message: string }> {
  const issues: Array<{ node_key: string; message: string }> = []
  const keys = new Set(nodes.map((n) => n.node_key))

  for (const n of nodes) {
    const c = n.config ?? {}

    if (n.node_type === 'message' && !c.body?.trim()) {
      issues.push({ node_key: n.node_key, message: 'Message node has no text' })
    }
    if (n.node_type === 'template' && !c.template_name) {
      issues.push({ node_key: n.node_key, message: 'Template node has no template selected' })
    }
    if (n.node_type === 'buttons') {
      if (!c.body?.trim()) issues.push({ node_key: n.node_key, message: 'Button node has no question text' })
      if (!(c.buttons ?? []).length) {
        issues.push({ node_key: n.node_key, message: 'Button node has no buttons' })
      }
      for (const b of c.buttons ?? []) {
        if (!b.title?.trim()) issues.push({ node_key: n.node_key, message: 'A button has no label' })
        if (b.next && !keys.has(b.next)) {
          issues.push({ node_key: n.node_key, message: `Button "${b.title}" points at a missing step` })
        }
      }
    }
    if (n.node_type === 'delay' && !Number(c.delay_minutes)) {
      issues.push({ node_key: n.node_key, message: 'Delay node has no duration' })
    }
    if (c.next && !keys.has(c.next)) {
      issues.push({ node_key: n.node_key, message: 'Next step points at a missing node' })
    }
  }

  return issues
}
