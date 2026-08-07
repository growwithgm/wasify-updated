import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { sendWhatsApp, resolveApprovedTemplate } from '@/lib/whatsapp/send'
import { templateShape, paramMismatch, explainMetaError } from '@/lib/whatsapp/template-params'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/contacts'
import { normalizeShopDomain } from '@/app/api/shopify/connect/route'
import { flowAuthOk } from '@/lib/flow/order-confirmation'
import { variantLabel, restockCap } from '@/lib/flow/stock-alerts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Restock fan-out, driven by Shopify Flow's inventory trigger.
 *
 * Same contract as /api/flow/order-confirmation: bearer FLOW_SECRET, and
 * anything a Flow retry cannot change answers 200 with a `skipped` reason.
 *
 * The cap is the heart of it: at most three messages per restocked unit,
 * FIFO. The rest STAY pending for the next restock — see restockCap() for
 * why messaging all 200 subscribers about 5 units ends in a quality-rating
 * downgrade.
 */
export async function POST(request: Request) {
  const secret = process.env.FLOW_SECRET
  if (!secret) {
    console.error('[flow-restock] FLOW_SECRET is not set — refusing all traffic')
    return new NextResponse('FLOW_SECRET is not configured', { status: 503 })
  }

  if (!flowAuthOk(request.headers.get('authorization'), secret)) {
    return NextResponse.json(
      {
        error: 'Unauthorized',
        hint: 'The Authorization header must carry FLOW_SECRET — either "Bearer <secret>" or the bare secret.',
      },
      { status: 401 }
    )
  }

  let body: { variant_id?: string | number; product_id?: string | number; available?: string | number; shop?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const variantId = body.variant_id != null ? String(body.variant_id) : ''
  const shop = normalizeShopDomain(body.shop ?? '')
  if (!variantId || !shop) {
    return NextResponse.json({ error: 'variant_id and shop are required' }, { status: 400 })
  }

  const available = Number(body.available ?? 0)
  if (!Number.isFinite(available) || available <= 0) {
    return NextResponse.json({ skipped: true, reason: 'nothing available' })
  }

  const db = createServiceClient()

  const { data: config } = await db
    .from('shopify_config')
    .select('user_id, bis_enabled, bis_template_es, bis_template_en')
    .eq('store_domain', shop)
    .maybeSingle()
  if (!config) return NextResponse.json({ skipped: true, reason: 'unknown_shop' })

  // The merchant's master switch (Integrations → Back in stock). Signups keep
  // collecting either way — only SENDING is gated, same rule as recovery.
  if (!config.bis_enabled) return NextResponse.json({ skipped: true, reason: 'disabled' })

  // FIFO — the customer who signed up first is told first.
  const { data: pending } = await db
    .from('stock_alerts')
    .select('*')
    .eq('shop', shop)
    .eq('variant_id', variantId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  if (!pending?.length) return NextResponse.json({ sent: 0, remaining: 0 })

  const batch = pending.slice(0, restockCap(pending.length, available))

  // Resolve each language's template ONCE, not per subscriber.
  const templates = new Map<string, { tpl: any; shape: ReturnType<typeof templateShape> } | null>()
  async function templateFor(locale: string) {
    const lang = locale.toLowerCase().startsWith('es') ? 'es' : 'en'
    if (!templates.has(lang)) {
      const name =
        (lang === 'es' ? config!.bis_template_es : config!.bis_template_en) || `back_in_stock_${lang}`
      const tpl = await resolveApprovedTemplate(config!.user_id, name, lang)
      templates.set(lang, tpl ? { tpl, shape: templateShape(tpl.components) } : null)
    }
    return templates.get(lang) ?? null
  }

  let sent = 0
  let failed = 0

  for (const row of batch) {
    // One bad row must never stop the rest of the batch.
    try {
      const resolved = await templateFor(row.locale ?? 'es')
      if (!resolved) {
        await db
          .from('stock_alerts')
          .update({ status: 'failed', notified_at: new Date().toISOString() })
          .eq('id', row.id)
        failed++
        continue
      }

      const vars = [(row.name ?? '').trim() || 'Hola', variantLabel(row.product_title, row.variant_title)]
      const mismatch = paramMismatch(resolved.shape, vars, {
        urlSuffixes: resolved.shape.dynamicUrlButtons.length ? 1 : 0,
      })
      if (mismatch) {
        await db.from('stock_alerts').update({ status: 'failed' }).eq('id', row.id)
        failed++
        continue
      }

      const components: any[] = [
        { type: 'body', parameters: vars.map((t) => ({ type: 'text' as const, text: t })) },
      ]
      if (resolved.shape.dynamicUrlButtons.length) {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: String(resolved.shape.dynamicUrlButtons[0]),
          parameters: [{ type: 'text', text: row.short_code }],
        })
      }

      const res = await sendWhatsApp(config.user_id, row.phone, {
        kind: 'template',
        name: resolved.tpl.name,
        language: resolved.tpl.language,
        components,
      })

      await db
        .from('stock_alerts')
        .update(
          res.ok
            ? { status: 'sent', notified_at: new Date().toISOString() }
            : { status: 'failed', notified_at: new Date().toISOString() }
        )
        .eq('id', row.id)

      if (res.ok) {
        sent++
        // Mirror into the inbox thread, like every other outbound.
        try {
          const contact = await findOrCreateContact(db, config.user_id, row.phone, {
            name: row.name,
            email: row.email,
            locale: row.locale,
            source: 'shopify',
          })
          if (contact) {
            const conversationId = await findOrCreateConversation(db, config.user_id, contact.id)
            if (conversationId) {
              await db.from('messages').insert({
                user_id: config.user_id,
                conversation_id: conversationId,
                contact_id: contact.id,
                sender_type: 'bot',
                content_type: 'template',
                content: `Back in stock — ${variantLabel(row.product_title, row.variant_title)}`,
                template_name: resolved.tpl.name,
                message_id: res.wamid ?? null,
                status: 'sent',
              })
            }
          }
        } catch (e) {
          console.error('[flow-restock] mirror failed', e)
        }
      } else {
        failed++
        console.error('[flow-restock]', row.id, explainMetaError(res.error, res.code))
      }
    } catch (e) {
      failed++
      console.error('[flow-restock] row failed', row.id, e)
    }
  }

  return NextResponse.json({
    sent,
    failed,
    // Still pending, by design — first in line when the next restock lands.
    remaining: pending.length - batch.length,
  })
}
