import { withAuth, badRequest, notFound } from '@/lib/api'
import { getWhatsAppConfig, graphFetch } from '@/lib/whatsapp/graph'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** Submit a local draft to Meta for review. */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params

  return withAuth(async ({ supabase, userId }) => {
    const config = await getWhatsAppConfig(userId)
    if (!config) badRequest('Connect WhatsApp first')
    if (!config.waba_id) badRequest('Set your WhatsApp Business Account ID (WABA) in Integrations')

    const { data: tpl } = await supabase.from('message_templates').select('*').eq('id', id).maybeSingle()
    if (!tpl) notFound('Template not found')
    if (tpl.status !== 'DRAFT' && tpl.status !== 'REJECTED') {
      badRequest(`This template is ${tpl.status.toLowerCase()} — only drafts and rejected templates can be submitted`)
    }

    const issues = validateTemplate(tpl)
    if (issues.length) badRequest(issues[0], { issues })

    const components: any[] = []

    if (tpl.header_type && tpl.header_type !== 'none') {
      if (tpl.header_type === 'text') {
        const header: any = { type: 'HEADER', format: 'TEXT', text: tpl.header_text }
        const headerVars = countVariables(tpl.header_text ?? '')
        if (headerVars > 0) {
          header.example = { header_text: (tpl.sample_values?.header ?? []).slice(0, headerVars) }
        }
        components.push(header)
      } else {
        // Media headers are rejected without an example handle — the reason
        // image templates could never be submitted from here before.
        components.push({
          type: 'HEADER',
          format: tpl.header_type.toUpperCase(),
          example: { header_handle: [tpl.sample_values?.header_handle] },
        })
      }
    }

    const bodyVars = countVariables(tpl.body_text)
    const body: any = { type: 'BODY', text: tpl.body_text }
    if (bodyVars > 0) {
      body.example = { body_text: [(tpl.sample_values?.body ?? []).slice(0, bodyVars)] }
    }
    components.push(body)

    if (tpl.footer_text) components.push({ type: 'FOOTER', text: tpl.footer_text })

    if ((tpl.buttons ?? []).length) {
      components.push({
        type: 'BUTTONS',
        buttons: tpl.buttons.map((b: any) => {
          if (b.kind === 'url') {
            return {
              type: 'URL',
              text: b.text,
              url: b.url,
              // Meta only substitutes a suffix, so a dynamic button needs an example.
              ...(b.dynamic ? { example: [b.url.replace('{{1}}', 'cart/abc123')] } : {}),
            }
          }
          if (b.kind === 'phone') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone }
          if (b.kind === 'copy_code') return { type: 'COPY_CODE', example: b.text }
          return { type: 'QUICK_REPLY', text: b.text }
        }),
      })
    }

    const res = await graphFetch<{ id: string; status: string }>(
      `${config.waba_id}/message_templates`,
      config.token,
      {
        method: 'POST',
        body: JSON.stringify({
          name: tpl.name,
          language: tpl.language,
          category: tpl.category,
          components,
        }),
      }
    )

    if (!res.ok) {
      await supabase
        .from('message_templates')
        .update({ rejected_reason: res.error.message })
        .eq('id', id)
      badRequest(`Meta rejected the submission: ${res.error.message}`)
    }

    const { data: updated } = await supabase
      .from('message_templates')
      .update({
        status: (res.data.status ?? 'PENDING').toUpperCase(),
        meta_template_id: res.data.id,
        submitted_at: new Date().toISOString(),
        rejected_reason: null,
      })
      .eq('id', id)
      .select('*')
      .single()

    return { template: updated }
  })
}

function countVariables(text: string) {
  const found = [...(text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
  return found.length ? Math.max(...found) : 0
}

/** Pre-flight checks that mirror Meta's own rejection reasons. */
export function validateTemplate(tpl: any): string[] {
  const issues: string[] = []

  if (!/^[a-z0-9_]+$/.test(tpl.name ?? '')) {
    issues.push('Name may only contain lowercase letters, numbers and underscores')
  }
  if (!tpl.body_text?.trim()) issues.push('Body text is required')
  if ((tpl.body_text ?? '').length > 1024) issues.push('Body text must be 1024 characters or fewer')
  if ((tpl.footer_text ?? '').length > 60) issues.push('Footer must be 60 characters or fewer')
  if (tpl.header_type === 'text' && (tpl.header_text ?? '').length > 60) {
    issues.push('Text header must be 60 characters or fewer')
  }

  const bodyVars = countVariables(tpl.body_text ?? '')
  const samples = tpl.sample_values?.body ?? []
  if (bodyVars > 0 && samples.filter((s: string) => s?.trim()).length < bodyVars) {
    issues.push(`Meta requires a sample value for each of the ${bodyVars} body variables`)
  }

  // Meta refuses a media header without an uploaded sample for review.
  if (['image', 'video', 'document'].includes(tpl.header_type) && !tpl.sample_values?.header_handle) {
    issues.push(
      `A ${tpl.header_type} header needs a sample file — upload one in the builder before submitting`
    )
  }

  // Meta rejects a body that starts or ends with a variable.
  const trimmed = (tpl.body_text ?? '').trim()
  if (/^\{\{\d+\}\}/.test(trimmed)) issues.push('Body cannot start with a variable')
  if (/\{\{\d+\}\}$/.test(trimmed)) issues.push('Body cannot end with a variable')

  const buttons = tpl.buttons ?? []
  if (buttons.filter((b: any) => b.kind === 'quick_reply').length > 3) {
    issues.push('At most 3 quick-reply buttons are allowed')
  }
  if (buttons.filter((b: any) => b.kind === 'url').length > 2) {
    issues.push('At most 2 URL buttons are allowed')
  }
  for (const b of buttons) {
    if ((b.text ?? '').length > 25) issues.push(`Button "${b.text}" exceeds 25 characters`)
    if (b.kind === 'url' && !b.url) issues.push('URL buttons need a URL')
    if (b.kind === 'url' && b.dynamic && !b.url?.includes('{{1}}')) {
      issues.push('A dynamic URL button must contain {{1}} in the URL')
    }
  }

  return issues
}
