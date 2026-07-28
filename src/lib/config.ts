/**
 * Runtime configuration checks shared by /api/health and the routes that
 * would otherwise crash on a missing value.
 *
 * These live here, rather than inline in each route, so the health check and
 * the code path it is meant to predict can never disagree. A health check that
 * says "all good" while the OAuth callback throws is worse than no check.
 */

export type ConfigStatus = { ok: true; message: null } | { ok: false; message: string }

const OK: ConfigStatus = { ok: true, message: null }

export function isHex64(value: string | undefined): boolean {
  return !!value && /^[0-9a-fA-F]{64}$/.test(value.trim())
}

/**
 * encrypt() throws when this is absent or the wrong length, and it is called
 * on the happy path of both OAuth callbacks — after the handshake has already
 * succeeded and a single-use code has been spent.
 */
export function encryptionKeyStatus(raw = process.env.ENCRYPTION_KEY): ConfigStatus {
  if (!raw) {
    return {
      ok: false,
      message:
        'ENCRYPTION_KEY is not set, so the access token cannot be stored. ' +
        'Generate one with: openssl rand -hex 32 — then add it in Vercel → Settings → Environment Variables.',
    }
  }
  if (!isHex64(raw)) {
    return {
      ok: false,
      message:
        'ENCRYPTION_KEY is set but invalid — it must be exactly 64 hex characters (openssl rand -hex 32). ' +
        'Check for a stray space or newline in the pasted value.',
    }
  }
  return OK
}

/**
 * createServiceClient() throws without these. Webhooks, cron and both OAuth
 * callbacks all use it, so a missing value shows up as a bare 500.
 */
export function serviceRoleStatus(
  url = process.env.NEXT_PUBLIC_SUPABASE_URL,
  key = process.env.SUPABASE_SERVICE_ROLE_KEY
): ConfigStatus {
  if (!url) {
    return { ok: false, message: 'NEXT_PUBLIC_SUPABASE_URL is not set — Supabase → Project Settings → Data API.' }
  }
  if (!key) {
    return {
      ok: false,
      message:
        'SUPABASE_SERVICE_ROLE_KEY is not set, so nothing can be written to the database. ' +
        'Supabase → Project Settings → API keys → service_role (secret). Server-side only — never NEXT_PUBLIC_.',
    }
  }
  return OK
}

/**
 * Everything an OAuth callback needs in order to *finish*. Checked before the
 * token exchange on purpose: the authorization code is single-use, so failing
 * after spending it forces the merchant to start over for no reason.
 */
export function canPersistTokens(): ConfigStatus {
  const encryption = encryptionKeyStatus()
  if (!encryption.ok) return encryption
  return serviceRoleStatus()
}
