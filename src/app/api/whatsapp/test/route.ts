import { withAuth, jsonBody, badRequest } from '@/lib/api'
import { sendWhatsApp } from '@/lib/whatsapp/send'
import { sanitizePhone, isValidPhone } from '@/lib/phone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Send a one-off test message to prove the pipe works end to end. */
export async function POST(request: Request) {
  return withAuth(async ({ userId }) => {
    const { phone, template_name } = await jsonBody<{ phone: string; template_name?: string }>(request)

    const digits = sanitizePhone(phone)
    if (!isValidPhone(digits)) badRequest('Enter a valid number with its country code')

    // Outside a 24h window only a template will be accepted, so prefer one.
    const result = template_name
      ? await sendWhatsApp(userId, digits, { kind: 'template', name: template_name, language: 'es' })
      : await sendWhatsApp(userId, digits, {
          kind: 'text',
          body: 'Test message from Wasify — your WhatsApp connection works. ✅',
        })

    if (!result.ok) {
      badRequest(
        result.code === 131047 || result.code === 470
          ? 'Meta refused a free-text message because the 24-hour window is closed. Send a test using an approved template instead.'
          : result.error
      )
    }

    return { ok: true, wamid: result.wamid, sentTo: result.usedPhone }
  })
}
