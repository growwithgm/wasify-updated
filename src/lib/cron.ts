import { safeEqual } from '@/lib/crypto'

/**
 * Cron authentication.
 *
 * Two variables are accepted, and each pairs with ONE specific header —
 * mixing them is the most common setup mistake, so `cronAuthHint()` below
 * reports the right one and the 401 body says it out loud:
 *
 *   CRON_SECRET             ->  Authorization: Bearer <value>
 *   AUTOMATION_CRON_SECRET  ->  x-cron-secret: <value>
 *
 * Set either one. Comparison is timing-safe, and if neither is configured the
 * endpoint refuses everything rather than being left open.
 */

export function isAuthorizedCron(request: Request): boolean {
  const bearer = process.env.CRON_SECRET
  const custom = process.env.AUTOMATION_CRON_SECRET

  if (!bearer && !custom) return false

  const auth = request.headers.get('authorization') ?? ''
  if (bearer && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), bearer)) return true

  const supplied = request.headers.get('x-cron-secret') ?? ''
  if (custom && safeEqual(supplied, custom)) return true

  return false
}

/**
 * What the caller should be sending, given what is actually configured.
 * Used by the 401 response and by /api/health so a misconfigured scheduler
 * diagnoses itself instead of silently never running.
 */
export function cronAuthHint(): { configured: boolean; header: string; example: string } {
  const hasBearer = !!process.env.CRON_SECRET
  const hasCustom = !!process.env.AUTOMATION_CRON_SECRET

  if (hasBearer) {
    return {
      configured: true,
      header: 'Authorization',
      example: 'Authorization: Bearer <your CRON_SECRET>',
    }
  }

  if (hasCustom) {
    return {
      configured: true,
      header: 'x-cron-secret',
      example: 'x-cron-secret: <your AUTOMATION_CRON_SECRET>',
    }
  }

  return {
    configured: false,
    header: '—',
    example: 'Set CRON_SECRET (then use Authorization: Bearer …) or AUTOMATION_CRON_SECRET (then use x-cron-secret: …)',
  }
}

/** Body returned on a rejected cron call — tells the operator how to fix it. */
export function cronUnauthorizedBody() {
  const hint = cronAuthHint()

  return {
    error: hint.configured
      ? 'Unauthorized — the request did not carry the expected header, or the value did not match.'
      : 'Unauthorized — no cron secret is configured on the server.',
    expectedHeader: hint.example,
    hint: hint.configured
      ? `This deployment authenticates with the "${hint.header}" header. Add it to your scheduler exactly as shown above.`
      : 'Add CRON_SECRET (or AUTOMATION_CRON_SECRET) to your Vercel environment variables and redeploy.',
  }
}
