import { safeEqual } from '@/lib/crypto'

/**
 * Cron auth. Accepts either shape so Vercel's built-in scheme and a manual
 * curl both work:
 *   Authorization: Bearer $CRON_SECRET
 *   x-cron-secret: $AUTOMATION_CRON_SECRET
 *
 * Comparison is timing-safe. If neither secret is configured the endpoint is
 * refused outright rather than left open.
 */
export function isAuthorizedCron(request: Request): boolean {
  const bearer = process.env.CRON_SECRET
  const header = process.env.AUTOMATION_CRON_SECRET

  if (!bearer && !header) return false

  const auth = request.headers.get('authorization') ?? ''
  if (bearer && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), bearer)) return true

  const custom = request.headers.get('x-cron-secret') ?? ''
  if (header && safeEqual(custom, header)) return true

  return false
}
