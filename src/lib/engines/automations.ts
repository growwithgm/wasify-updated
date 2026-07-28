import { sendWhatsApp, sendTemplate } from '@/lib/whatsapp/send'
import { canSendFreeText } from '@/lib/window'
import { matchesKeyword, normalize, recordOutbound, type InboundCtx } from './types'

/**
 * Step-list automations (the pre-Flows engine, kept because tenants rely on it).
 *
 * Triggers: new_contact_created, first_inbound_message, new_message_received,
 * keyword_match, tag_added, order_created.
 *
 * The webhook suppresses content triggers when a Flow already consumed the
 * message, so a customer never receives two answers.
 */

export async function runAutomationsForInbound(ctx: InboundCtx) {
  const { db, userId } = ctx

  const { data: automations } = await db
    .from('automations')
    .select('id, name, trigger_type, trigger_config')
    .eq('user_id', userId)
    .eq('is_active', true)
    .in('trigger_type', ['first_inbound_message', 'new_message_received', 'keyword_match'])

  if (!automations?.length) return

  const isFirst = await isFirstInboundMessage(ctx)

  for (const automation of automations) {
    if (!inboundTriggerMatches(automation, ctx, isFirst)) continue
    await runAutomation(ctx, automation.id)
  }
}

/** Fired by the Shopify order webhook and the contact-created path. */
export async function runAutomationsForEvent(
  ctx: InboundCtx,
  triggerType: 'new_contact_created' | 'order_created' | 'tag_added',
  meta: Record<string, unknown> = {}
) {
  const { data: automations } = await ctx.db
    .from('automations')
    .select('id, trigger_type, trigger_config')
    .eq('user_id', ctx.userId)
    .eq('is_active', true)
    .eq('trigger_type', triggerType)

  for (const automation of automations ?? []) {
    if (triggerType === 'tag_added') {
      const wanted = automation.trigger_config?.tag_id
      if (wanted && wanted !== meta.tagId) continue
    }
    await runAutomation(ctx, automation.id)
  }
}

function inboundTriggerMatches(automation: any, ctx: InboundCtx, isFirst: boolean): boolean {
  if (automation.trigger_type === 'first_inbound_message') return isFirst
  if (automation.trigger_type === 'new_message_received') return true

  if (automation.trigger_type === 'keyword_match') {
    const config = automation.trigger_config ?? {}
    const keywords: string[] = config.keywords ?? []
    const mode = config.match ?? 'contains'
    return keywords.some((k) => {
      if (mode === 'exact') return normalize(ctx.text) === normalize(k)
      if (mode === 'starts_with') return normalize(ctx.text).startsWith(normalize(k))
      return matchesKeyword(ctx.text, k)
    })
  }

  return false
}

async function isFirstInboundMessage(ctx: InboundCtx): Promise<boolean> {
  const { count } = await ctx.db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', ctx.conversationId)
    .eq('sender_type', 'customer')
  return (count ?? 0) <= 1
}

/** Execute an automation's steps in order, parking on the first `wait`. */
export async function runAutomation(ctx: InboundCtx, automationId: string, fromStep = 0) {
  const { db, userId } = ctx

  const { data: steps } = await db
    .from('automation_steps')
    .select('position, action_type, config')
    .eq('automation_id', automationId)
    .order('position')

  if (!steps?.length) return

  for (const step of steps) {
    if (step.position < fromStep) continue

    try {
      const parked = await runStep(ctx, automationId, step)
      if (parked) return
    } catch (e: any) {
      await db.from('automation_logs').insert({
        user_id: userId,
        automation_id: automationId,
        contact_id: ctx.contactId,
        status: 'failed',
        detail: `${step.action_type}: ${e?.message ?? e}`,
      })
      return
    }
  }

  const { data: automation } = await db
    .from('automations')
    .select('run_count')
    .eq('id', automationId)
    .maybeSingle()

  await db
    .from('automations')
    .update({ run_count: (automation?.run_count ?? 0) + 1, last_run_at: new Date().toISOString() })
    .eq('id', automationId)

  await db.from('automation_logs').insert({
    user_id: userId,
    automation_id: automationId,
    contact_id: ctx.contactId,
    status: 'success',
    detail: `${steps.length} steps completed`,
  })
}

/** Returns true when the automation should stop here and resume later. */
async function runStep(ctx: InboundCtx, automationId: string, step: any): Promise<boolean> {
  const { db, userId } = ctx
  const config = step.config ?? {}

  switch (step.action_type) {
    case 'send_message': {
      const body = renderTokens(config.body ?? '', ctx)
      if (!body) return false

      const { data: conv } = await db
        .from('conversations')
        .select('last_inbound_at')
        .eq('id', ctx.conversationId)
        .maybeSingle()

      if (!canSendFreeText(conv?.last_inbound_at)) {
        await db.from('automation_logs').insert({
          user_id: userId,
          automation_id: automationId,
          contact_id: ctx.contactId,
          status: 'skipped',
          detail: '24h window closed — free text not allowed',
        })
        return false
      }

      const res = await sendWhatsApp(userId, ctx.phone, { kind: 'text', body })
      await recordOutbound(ctx, { content: body, wamid: res.ok ? res.wamid : undefined })
      return false
    }

    case 'send_template': {
      if (!config.template_name) return false
      const res = await sendTemplate(
        userId,
        ctx.phone,
        config.template_name,
        undefined,
        config.template_language
      )
      await recordOutbound(ctx, {
        content: config.preview ?? `Template: ${config.template_name}`,
        contentType: 'template',
        templateName: config.template_name,
        wamid: res.ok ? res.wamid : undefined,
      })
      return false
    }

    case 'add_tag': {
      if (config.tag_id) {
        await db.from('contact_tags').upsert(
          { user_id: userId, contact_id: ctx.contactId, tag_id: config.tag_id },
          { onConflict: 'contact_id,tag_id' }
        )
      }
      return false
    }

    case 'remove_tag': {
      if (config.tag_id) {
        await db
          .from('contact_tags')
          .delete()
          .eq('contact_id', ctx.contactId)
          .eq('tag_id', config.tag_id)
      }
      return false
    }

    case 'assign_agent': {
      await db
        .from('conversations')
        .update({ assigned_to: config.agent_id ?? null })
        .eq('id', ctx.conversationId)
      return false
    }

    case 'set_status': {
      if (['open', 'pending', 'closed'].includes(config.status)) {
        await db.from('conversations').update({ status: config.status }).eq('id', ctx.conversationId)
      }
      return false
    }

    case 'create_deal': {
      const { data: stage } = await db
        .from('pipeline_stages')
        .select('id, pipeline_id')
        .eq('user_id', userId)
        .order('position')
        .limit(1)
        .maybeSingle()

      if (stage) {
        await db.from('deals').insert({
          user_id: userId,
          pipeline_id: stage.pipeline_id,
          stage_id: stage.id,
          contact_id: ctx.contactId,
          title: renderTokens(config.title ?? 'New deal', ctx),
          value: Number(config.value ?? 0),
        })
      }
      return false
    }

    case 'wait': {
      const minutes = Number(config.minutes ?? 0)
      await db.from('automation_pending').insert({
        user_id: userId,
        automation_id: automationId,
        contact_id: ctx.contactId,
        next_step: step.position + 1,
        run_after: new Date(Date.now() + minutes * 60_000).toISOString(),
      })
      return true
    }

    case 'webhook': {
      if (config.url) {
        await fetch(config.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact_id: ctx.contactId, text: ctx.text, phone: ctx.phone }),
        }).catch(() => {})
      }
      return false
    }

    default:
      return false
  }
}

/** {{name}} / {{phone}} substitution in automation copy. */
function renderTokens(template: string, ctx: InboundCtx): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    if (key === 'phone') return ctx.phone
    return ''
  })
}

/** Drain automations parked on a `wait` step. Called by the cron tick. */
export async function runDueAutomations(db: any): Promise<number> {
  const { data: due } = await db
    .from('automation_pending')
    .select('id, user_id, automation_id, contact_id, next_step')
    .lte('run_after', new Date().toISOString())
    .limit(200)

  let ran = 0

  for (const row of due ?? []) {
    // Delete first: if the steps below throw, we must not retry forever.
    await db.from('automation_pending').delete().eq('id', row.id)

    const { data: contact } = await db.from('contacts').select('phone').eq('id', row.contact_id).maybeSingle()
    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('user_id', row.user_id)
      .eq('contact_id', row.contact_id)
      .maybeSingle()

    if (!contact || !conv) continue

    await runAutomation(
      {
        db,
        userId: row.user_id,
        contactId: row.contact_id,
        conversationId: conv.id,
        phone: contact.phone,
        text: '',
        interactiveReplyId: null,
      },
      row.automation_id,
      row.next_step
    )
    ran++
  }

  return ran
}
