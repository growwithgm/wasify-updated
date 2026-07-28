import crypto from 'crypto'

/**
 * Token encryption for WhatsApp + Shopify credentials.
 *
 * Format: `iv:ciphertext:authTag` (all hex), AES-256-GCM.
 * ENCRYPTION_KEY must be 64 hex chars (32 bytes) — `openssl rand -hex 32`.
 *
 * The legacy production app briefly stored AES-256-CBC values as `iv:ct`.
 * decrypt() still understands those so old rows keep working; callers that
 * notice a legacy value should re-encrypt it on next write (self-heal).
 */

const ALGO = 'aes-256-gcm'
const LEGACY_ALGO = 'aes-256-cbc'

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY is not set')
  const k = Buffer.from(raw.trim(), 'hex')
  if (k.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 64 hex chars (32 bytes), got ${k.length} bytes`)
  }
  return k
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`
}

export function decrypt(stored: string): string {
  if (!stored) return ''
  const parts = stored.split(':')

  if (parts.length === 3) {
    const [ivHex, ctHex, tagHex] = parts
    const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8')
  }

  if (parts.length === 2) {
    // legacy CBC
    const [ivHex, ctHex] = parts
    const decipher = crypto.createDecipheriv(LEGACY_ALGO, key(), Buffer.from(ivHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8')
  }

  throw new Error('Unrecognised encrypted value format')
}

/** True when the stored value uses the legacy CBC layout and should be re-encrypted. */
export function isLegacyFormat(stored: string): boolean {
  return !!stored && stored.split(':').length === 2
}

/** Never send a real token to the browser — show this instead. */
export function maskToken(plain: string): string {
  if (!plain) return ''
  if (plain.length <= 8) return '•'.repeat(plain.length)
  return `${plain.slice(0, 4)}${'•'.repeat(Math.min(24, plain.length - 8))}${plain.slice(-4)}`
}

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a || '', 'utf8')
  const bb = Buffer.from(b || '', 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** HMAC-SHA256 of raw bytes, hex — used by the Meta webhook signature check. */
export function hmacHex(secret: string, raw: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex')
}

/** HMAC-SHA256 of raw bytes, base64 — used by the Shopify webhook signature check. */
export function hmacBase64(secret: string, raw: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(raw).digest('base64')
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('hex')
}
