import { withAuth, badRequest } from '@/lib/api'
import { getWhatsAppConfig, graphFetch } from '@/lib/whatsapp/graph'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

type MetaTemplate = {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: Array<{
    type: string
    format?: string
    text?: string
    buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>
    example?: Record<string, any>
  }>
  quality_score?: { score?: string }
  rejected_reason?: string
}

/**
 * Pull the tenant's templates from Meta into message_templates.
 *
 * Meta is the source of truth for name/language/status — sending a name the
 * Graph API doesn't recognise is the usual cause of error #132001, so every
 * send resolves against these synced rows.
 */
export async function POST() {
  return withAuth(async ({ supabase, userId }) => {
    const config = await getWhatsAppConfig(userId)
    if (!config) badRequest('Connect WhatsApp first')
    if (!config.waba_id) badRequest('Set your WhatsApp Business Account ID (WABA) in Integrations')

    let url: string | null = `${config.waba_id}/message_templates`
    let imported = 0
    const seen: string[] = []

    for (let page = 0; page < 10 && url; page++) {
      const res: any = await graphFetch<{ data: MetaTemplate[]; paging?: { next?: string } }>(
        url,
        config.token,
        page === 0
          ? { query: { limit: '100', fields: 'id,name,language,status,category,components,quality_score,rejected_reason' } }
          : {}
      )

      if (!res.ok) badRequest(`Meta rejected the sync: ${res.error.message}`)

      for (const tpl of res.data.data ?? []) {
        const parsed = parseComponents(tpl)
        seen.push(`${tpl.name}::${tpl.language}`)

        await supabase.from('message_templates').upsert(
          {
            user_id: userId,
            name: tpl.name,
            language: tpl.language,
            category: (tpl.category ?? 'MARKETING').toUpperCase(),
            status: (tpl.status ?? 'PENDING').toUpperCase(),
            rejected_reason: tpl.rejected_reason ?? null,
            quality_score: tpl.quality_score?.score ?? null,
            meta_template_id: tpl.id,
            components: tpl.components ?? null,
            synced_at: new Date().toISOString(),
            ...parsed,
          },
          { onConflict: 'user_id,name,language' }
        )
        imported++
      }

      url = res.data.paging?.next ?? null
    }

    // Anything we previously synced that Meta no longer returns was deleted there.
    const { data: local } = await supabase
      .from('message_templates')
      .select('id, name, language, status')
      .eq('user_id', userId)
      .not('meta_template_id', 'is', null)

    let removed = 0
    for (const row of local ?? []) {
      if (!seen.includes(`${row.name}::${row.language}`)) {
        await supabase.from('message_templates').update({ status: 'DISABLED' }).eq('id', row.id)
        removed++
      }
    }

    return { ok: true, imported, disabled: removed }
  })
}

/** Flatten Meta's component array into the columns the builder edits. */
function parseComponents(tpl: MetaTemplate) {
  const components = tpl.components ?? []
  const header = components.find((c) => c.type === 'HEADER')
  const body = components.find((c) => c.type === 'BODY')
  const footer = components.find((c) => c.type === 'FOOTER')
  const buttonsBlock = components.find((c) => c.type === 'BUTTONS')

  const buttons = (buttonsBlock?.buttons ?? []).map((b) => ({
    kind:
      b.type === 'QUICK_REPLY'
        ? 'quick_reply'
        : b.type === 'URL'
          ? 'url'
          : b.type === 'PHONE_NUMBER'
            ? 'phone'
            : 'copy_code',
    text: b.text,
    url: b.url ?? undefined,
    phone: b.phone_number ?? undefined,
    // A URL containing {{1}} is a Dynamic URL — the app supplies only a suffix.
    dynamic: b.type === 'URL' && !!b.url?.includes('{{1}}'),
  }))

  return {
    header_type: header ? (header.format ?? 'TEXT').toLowerCase() : 'none',
    header_text: header?.format === 'TEXT' ? (header.text ?? null) : null,
    body_text: body?.text ?? '',
    footer_text: footer?.text ?? null,
    buttons,
    sample_values: {
      body: body?.example?.body_text?.[0] ?? [],
      header: header?.example?.header_text ?? [],
    },
  }
}
