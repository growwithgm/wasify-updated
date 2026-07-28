/**
 * The public origin this deployment is reachable at.
 *
 * Every URL handed to somebody *else* is built from it: the Shopify OAuth
 * `redirect_uri`, the two webhook callbacks, the cron endpoints. A wrong value
 * never fails here — it fails at the far end, hours later, with an error
 * message that does not mention this variable at all.
 *
 * The specific trap this module exists to close: `.env.example` ships
 * `https://your-app.vercel.app`, and pasting the example file into Vercel
 * wholesale carries the placeholder through as a real value. The app then
 * builds a perfectly well-formed OAuth URL pointing at a domain that is not
 * yours, and Shopify answers:
 *
 *     The redirect_uri is not whitelisted
 *
 * Nothing in that message says NEXT_PUBLIC_SITE_URL. So we refuse to build the
 * URL at all, and say which variable is wrong.
 *
 * Note that NEXT_PUBLIC_* values are inlined at BUILD time. Saving a new value
 * in Vercel changes nothing until the next deployment — which is why the
 * messages below say "redeploy" rather than "save".
 */

/**
 * Hosts that are obviously stand-ins rather than a real deployment. Kept
 * deliberately small: only values a person could plausibly copy from a
 * template, never a host somebody might legitimately own.
 */
export const PLACEHOLDER_SITE_HOSTS = [
  'your-app.vercel.app',
  'your-app.com',
  'your-domain.com',
  'www.your-domain.com',
  'example.com',
  'www.example.com',
  'yourdomain.com',
  'www.yourdomain.com',
] as const

export type SiteUrlProblem = 'missing' | 'placeholder' | 'malformed'

export type SiteUrlStatus =
  | { ok: true; url: string; problem: null; message: null }
  | { ok: false; url: null; problem: SiteUrlProblem; value: string | null; message: string }

/** Local development is exempt — a tunnel or localhost is a legitimate origin. */
function isLocal(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function siteUrlStatus(raw: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): SiteUrlStatus {
  const value = (raw ?? '').trim().replace(/\/+$/, '')

  if (!value) {
    return {
      ok: false,
      url: null,
      value: null,
      problem: 'missing',
      message:
        'NEXT_PUBLIC_SITE_URL is not set. Set it to this deployment’s own URL ' +
        '(Vercel → Settings → Environment Variables), then redeploy — the value is ' +
        'baked in at build time, so saving alone does not apply it.',
    }
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return {
      ok: false,
      url: null,
      value,
      problem: 'malformed',
      message: `NEXT_PUBLIC_SITE_URL is "${value}", which is not a URL. It must be a full origin including the scheme, e.g. https://my-app.vercel.app, with no trailing slash.`,
    }
  }

  const host = parsed.hostname.toLowerCase()

  if (parsed.protocol !== 'https:' && !isLocal(host)) {
    return {
      ok: false,
      url: null,
      value,
      problem: 'malformed',
      message: `NEXT_PUBLIC_SITE_URL is "${value}". Shopify and Meta both require https, so an http:// origin can never complete OAuth or receive a webhook.`,
    }
  }

  if ((PLACEHOLDER_SITE_HOSTS as readonly string[]).includes(host)) {
    return {
      ok: false,
      url: null,
      value,
      problem: 'placeholder',
      message:
        `NEXT_PUBLIC_SITE_URL is still the example value "${value}". That domain is not yours, ` +
        'so Shopify rejects the redirect with "The redirect_uri is not whitelisted". ' +
        'Set it to this deployment’s own URL in Vercel → Settings → Environment Variables, ' +
        'then redeploy — the value is baked in at build time, so saving alone does not apply it.',
    }
  }

  return { ok: true, url: value, problem: null, message: null }
}

/** The origin, or null when it is unset, malformed or still the placeholder. */
export function siteUrl(raw?: string): string | null {
  const status = siteUrlStatus(raw)
  return status.ok ? status.url : null
}
