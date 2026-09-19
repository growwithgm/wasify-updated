/**
 * In-memory per-IP rate limiting for the PUBLIC storefront endpoints.
 *
 * Each serverless instance counts separately and a cold start resets it —
 * acceptable, because it only needs to blunt bursts. The durable guards on
 * every public endpoint are the honeypot and the unique/consent constraints;
 * a patient attacker gains nothing but duplicate-key errors.
 */
export function makeRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>()

  return function rateLimited(ip: string): boolean {
    const now = Date.now()
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs)
    if (recent.length >= max) {
      hits.set(ip, recent)
      return true
    }
    recent.push(now)
    hits.set(ip, recent)
    // Bound the map so a wide botnet cannot balloon instance memory.
    if (hits.size > 10_000) hits.clear()
    return false
  }
}

/** The client IP as the proxy chain reports it. */
export function requestIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  )
}
