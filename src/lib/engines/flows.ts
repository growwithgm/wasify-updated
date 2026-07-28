import { sendWhatsApp, sendTemplate } from '@/lib/whatsapp/send'
import { canSendFreeText } from '@/lib/window'
import { matchesKeyword, normalize, recordOutbound, type InboundCtx } from './types'
import type { FlowNodeConfig } from '@/lib/types'

/**
 * Button-driven flow runner.
 *
 * Contract with the webhook: returns TRUE when the message was consumed by a
 * flow. The webhook then skips automations and the chatbot so a customer never
 * gets two replies to one message.
 *
 * Only ONE run may be active per (tenant, contact) — enforced by a partial
 * unique index, so a race just loses the insert instead of double-messaging.
 */

const MAX_CHAIN = 12 // guard against a mis-wired flow looping forever

export async function runFlowForInbound(ctx: InboundCtx): Promise<boolean> {
  const { db, userId, contactId } = ctx

  // 1. Is a run already waiting on this contact?
  const { data: active } = await db
    .from('flow_runs')
    .select('id, flow_id, current_node, context')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .maybeSingle()

  if (active) return advanceRun(ctx, active)

  // 2. Otherwise, does an active flow's trigger match?
  const { data: flows } = await db
    .from('flows')
    .select('id, name, trigger_type, trigger_config')
    .eq('user_id', userId)
    .eq('status', 'active')

  for (const flow of flows ?? []) {
    if (!triggerMatches(flow, ctx)) continue
    return startRun(ctx, flow.id)
  }

  return false
}

function triggerMatches(flow: any, ctx: InboundCtx): boolean {
  const config = flow.trigger_config ?? {}

  if (flow.trigger_type === 'keyword') {
    const keywords: string[] = config.keywords ?? []
    const mode = config.match ?? 'contains'
    return keywords.some((k) => {
      if (mode === 'exact') return normalize(ctx.text) === normalize(k)
      if (mode === 'starts_with') return normalize(ctx.text).startsWith(normalize(k))
      return matchesKeyword(ctx.text, k)
    })
  }

  if (flow.trigger_type === 'first_message') {
    // Handled by the caller passing isFirstMessage; conservative default is no.
    return config.always === true
  }

  return false
}

async function startRun(ctx: InboundCtx, flowId: string): Promise<boolean> {
  const { db, userId, contactId } = ctx

  const { data: nodes } = await db
    .from('flow_nodes')
    .select('node_key, node_type, config, position')
    .eq('flow_id', flowId)
    .order('position')

  if (!nodes?.length) return false

  const { data: run, error } = await db
    .from('flow_runs')
    .insert({
      user_id: userId,
      flow_id: flowId,
      contact_id: contactId,
      status: 'active',
      current_node: nodes[0].node_key,
      context: {},
    })
    .select('id')
    .single()

  // Unique-index violation means another webhook won the race — let it drive.
  if (error || !run) return false

  await bumpCounter(db, flowId, 'entered_count')

  await execute(ctx, { runId: run.id, flowId, nodes, startKey: nodes[0].node_key })
  return true
}

async function advanceRun(ctx: InboundCtx, run: any): Promise<boolean> {
  const { db } = ctx

  const { data: nodes } = await db
    .from('flow_nodes')
    .select('node_key, node_type, config, position')
    .eq('flow_id', run.flow_id)
    .order('position')

  if (!nodes?.length) {
    await db.from('flow_runs').update({ status: 'failed', ended_at: new Date().toISOString() }).eq('id', run.id)
    return false
  }

  const current = nodes.find((n: any) => n.node_key === run.current_node)
  if (!current) {
    await db.from('flow_runs').update({ status: 'failed', ended_at: new Date().toISOString() }).eq('id', run.id)
    return false
  }

  const config = (current.config ?? {}) as FlowNodeConfig
  let nextKey: string | undefined

  if (current.node_type === 'buttons' || current.node_type === 'list') {
    // Branch on the button id the customer tapped; fall back to a title match.
    const buttons = config.buttons ?? []
    const tapped =
      buttons.find((b) => b.id === ctx.interactiveReplyId) ??
      buttons.find((b) => normalize(b.title) === normalize(ctx.text))

    if (!tapped) {
      // Free-text where a button was expected — leave the run parked so a
      // human can take over rather than replying with something confusing.
      await logEvent(ctx, run, current.node_key, 'skipped', 'Expected a button tap, got free text')
      return false
    }

    nextKey = tapped.next
    await db
      .from('flow_runs')
      .update({ context: { ...(run.context ?? {}), [current.node_key]: tapped.id } })
      .eq('id', run.id)
    await logEvent(ctx, run, current.node_key, 'branch', `Tapped "${tapped.title}"`)
  } else {
    nextKey = config.next
  }

  if (!nextKey) {
    await completeRun(ctx, run)
    return true
  }

  await execute(ctx, { runId: run.id, flowId: run.flow_id, nodes, startKey: nextKey })
  return true
}

/**
 * Walk forward from `startKey`, sending as it goes, until it hits a node
 * that waits for input (buttons/list), a delay, or the end.
 */
async function execute(
  ctx: InboundCtx,
  args: { runId: string; flowId: string; nodes: any[]; startKey: string }
) {
  const { db } = ctx
  const byKey = new Map(args.nodes.map((n) => [n.node_key, n]))

  let key: string | undefined = args.startKey

  for (let step = 0; step < MAX_CHAIN; step++) {
    if (!key) break
    const node = byKey.get(key)
    if (!node) break

    const config = (node.config ?? {}) as FlowNodeConfig
    await db.from('flow_runs').update({ current_node: node.node_key }).eq('id', args.runId)

    switch (node.node_type) {
      case 'message': {
        const body = config.body ?? ''
        if (body) await sendFree(ctx, body, args)
        key = config.next
        break
      }

      case 'template': {
        if (config.template_name) {
          const res = await sendTemplate(
            ctx.userId,
            ctx.phone,
            config.template_name,
            undefined,
            config.template_language
          )
          await recordOutbound(ctx, {
            content: config.body ?? `Template: ${config.template_name}`,
            contentType: 'template',
            templateName: config.template_name,
            wamid: res.ok ? res.wamid : undefined,
          })
          await logEvent(ctx, { id: args.runId, flow_id: args.flowId }, node.node_key, res.ok ? 'ok' : 'error', res.ok ? undefined : res.error)
        }
        key = config.next
        break
      }

      case 'buttons': {
        const buttons = (config.buttons ?? []).slice(0, 3)
        if (!buttons.length) {
          key = config.next
          break
        }
        const res = await sendWhatsApp(ctx.userId, ctx.phone, {
          kind: 'interactive-buttons',
          body: config.body ?? '',
          header: config.header,
          footer: config.footer,
          buttons: buttons.map((b) => ({ id: b.id, title: b.title })),
        })
        await recordOutbound(ctx, {
          content: config.body ?? '',
          contentType: 'interactive',
          buttons: buttons.map((b) => ({ id: b.id, title: b.title })),
          wamid: res.ok ? res.wamid : undefined,
        })
        await logEvent(ctx, { id: args.runId, flow_id: args.flowId }, node.node_key, res.ok ? 'ok' : 'error', res.ok ? undefined : res.error)
        return // wait for the customer to tap
      }

      case 'delay': {
        const minutes = Number(config.delay_minutes ?? 0)
        await db
          .from('flow_runs')
          .update({
            resume_after: new Date(Date.now() + minutes * 60_000).toISOString(),
            current_node: config.next ?? null,
          })
          .eq('id', args.runId)
        return // the cron tick resumes it
      }

      case 'tag': {
        if (config.tag_id) {
          await db.from('contact_tags').upsert(
            { user_id: ctx.userId, contact_id: ctx.contactId, tag_id: config.tag_id },
            { onConflict: 'contact_id,tag_id' }
          )
        }
        key = config.next
        break
      }

      case 'assign': {
        await db
          .from('conversations')
          .update({ assigned_to: config.agent_id ?? null })
          .eq('id', ctx.conversationId)
        key = config.next
        break
      }

      case 'end':
      default:
        key = undefined
        break
    }
  }

  await completeRun(ctx, { id: args.runId, flow_id: args.flowId })
}

async function sendFree(ctx: InboundCtx, body: string, args: { runId: string; flowId: string }) {
  // A flow reply is a response to an inbound message, so the window is open —
  // but re-check rather than assume, because a delay node can span hours.
  const { data: conv } = await ctx.db
    .from('conversations')
    .select('last_inbound_at')
    .eq('id', ctx.conversationId)
    .maybeSingle()

  if (!canSendFreeText(conv?.last_inbound_at)) {
    await logEvent(ctx, { id: args.runId, flow_id: args.flowId }, 'send', 'skipped', '24h window closed')
    return
  }

  const res = await sendWhatsApp(ctx.userId, ctx.phone, { kind: 'text', body })
  await recordOutbound(ctx, { content: body, wamid: res.ok ? res.wamid : undefined })
}

async function completeRun(ctx: InboundCtx, run: { id: string; flow_id: string }) {
  await ctx.db
    .from('flow_runs')
    .update({ status: 'completed', ended_at: new Date().toISOString() })
    .eq('id', run.id)
  await bumpCounter(ctx.db, run.flow_id, 'completed_count')
}

async function logEvent(
  ctx: InboundCtx,
  run: { id: string; flow_id: string },
  nodeKey: string,
  status: string,
  detail?: string
) {
  await ctx.db.from('flow_events').insert({
    user_id: ctx.userId,
    flow_id: run.flow_id,
    run_id: run.id,
    contact_id: ctx.contactId,
    node_key: nodeKey,
    status,
    detail: detail ?? null,
  })
}

async function bumpCounter(db: any, flowId: string, column: 'entered_count' | 'completed_count') {
  const { data } = await db.from('flows').select(column).eq('id', flowId).maybeSingle()
  if (data) await db.from('flows').update({ [column]: (data[column] ?? 0) + 1 }).eq('id', flowId)
}

/** Called by the cron tick to resume runs parked on a delay node. */
export async function resumeDueFlowRuns(db: any): Promise<number> {
  const { data: due } = await db
    .from('flow_runs')
    .select('id, user_id, flow_id, contact_id, current_node, context')
    .eq('status', 'active')
    .not('resume_after', 'is', null)
    .lte('resume_after', new Date().toISOString())
    .limit(200)

  let resumed = 0

  for (const run of due ?? []) {
    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('user_id', run.user_id)
      .eq('contact_id', run.contact_id)
      .maybeSingle()
    if (!conv) continue

    const { data: contact } = await db.from('contacts').select('phone').eq('id', run.contact_id).maybeSingle()
    if (!contact) continue

    const { data: nodes } = await db
      .from('flow_nodes')
      .select('node_key, node_type, config, position')
      .eq('flow_id', run.flow_id)
      .order('position')
    if (!nodes?.length || !run.current_node) continue

    await db.from('flow_runs').update({ resume_after: null }).eq('id', run.id)

    const ctx: InboundCtx = {
      db,
      userId: run.user_id,
      contactId: run.contact_id,
      conversationId: conv.id,
      phone: contact.phone,
      text: '',
      interactiveReplyId: null,
    }

    await execute(ctx, { runId: run.id, flowId: run.flow_id, nodes, startKey: run.current_node })
    resumed++
  }

  return resumed
}

/**
 * An agent sending manually PAUSES any active run for that contact — the
 * human is now driving and the bot must not talk over them.
 */
export async function pauseRunsForContact(db: any, userId: string, contactId: string) {
  await db
    .from('flow_runs')
    .update({ status: 'paused', ended_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
}
