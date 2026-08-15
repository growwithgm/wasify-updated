import { withAuth, badRequest } from '@/lib/api'
import { getWhatsAppConfig, graphFetch, GRAPH_BASE } from '@/lib/whatsapp/graph'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Upload a template's sample header image to Meta.
 *
 * Submitting a template with an IMAGE header requires an `example.header_handle`
 * — without it Meta rejects the submission outright, which is why the builder's
 * Image option never worked. The handle comes from the RESUMABLE UPLOAD API,
 * which is app-scoped (hence the Meta App ID requirement), and the second leg
 * speaks its own dialect: raw bytes, an `OAuth` (not Bearer) Authorization
 * scheme, and a `file_offset` header.
 */
export async function POST(request: Request) {
  return withAuth(async ({ userId }) => {
    const config = await getWhatsAppConfig(userId)
    if (!config) badRequest('Connect WhatsApp first')
    if (!config.app_id) {
      badRequest(
        'Set your Meta App ID in Integrations → WhatsApp — sample images upload through the app-level Upload API'
      )
    }

    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) badRequest('Attach the image as a form field named "file"')
    if (file.size > 5 * 1024 * 1024) badRequest('Sample images must be 5 MB or smaller')
    const type = file.type || 'image/jpeg'
    if (!/^image\/(jpe?g|png)$/i.test(type)) badRequest('Meta accepts JPEG or PNG sample images')

    const bytes = Buffer.from(await file.arrayBuffer())

    const session = await graphFetch<{ id: string }>(`${config.app_id}/uploads`, config.token, {
      method: 'POST',
      query: { file_length: String(bytes.length), file_type: type },
    })
    if (!session.ok) badRequest(`Meta refused the upload session: ${session.error.message}`)

    let res: Response
    try {
      res = await fetch(`${GRAPH_BASE}/${session.data.id}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${config.token}`, file_offset: '0' },
        body: bytes as any,
      })
    } catch (e: any) {
      badRequest(`Network error uploading to Meta: ${e?.message ?? e}`)
    }

    const json: any = await res.json().catch(() => null)
    if (!res.ok || !json?.h) {
      badRequest(`Meta did not return an upload handle: ${json?.error?.message ?? `HTTP ${res.status}`}`)
    }

    return { handle: json.h }
  })
}
