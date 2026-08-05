import { customAlphabet } from 'nanoid'
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js'

/**
 * Helpers for the Shopify Flow → WhatsApp order confirmation.
 *
 * Pure functions only — the route stays thin and these stay testable.
 */

/**
 * Lowercase + digits with every lookalike removed (0/o, 1/l/i), because this
 * code ends up in a WhatsApp button URL a customer might read aloud or retype.
 */
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

export const makeCode = customAlphabet(CODE_ALPHABET, 8)

export function isValidCode(code: string): boolean {
  return /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(code)
}

/**
 * Digits-only E.164, which is the shape Meta wants — no plus sign.
 * Returns null for anything libphonenumber cannot make a valid number of;
 * the caller answers 200 { skipped } so Shopify Flow never retries a phone
 * that will be exactly as invalid the fifth time.
 */
export function toMetaPhone(raw: string | null | undefined, countryCode?: string | null): string | null {
  if (!raw?.trim()) return null
  const region = ((countryCode ?? '').trim().toUpperCase() || 'ES') as CountryCode
  const parsed = parsePhoneNumberFromString(raw.trim(), { defaultCountry: region })
  if (!parsed?.isValid()) return null
  return parsed.number.replace('+', '')
}

/**
 * "48.9 EUR" → "€48,90". Currencies keep their local decimal convention —
 * euro amounts read with a comma, pound and dollar with a point.
 */
export function formatOrderTotal(total: string | number | null | undefined, currency?: string | null): string {
  const value = Number(total ?? 0)
  const cur = (currency ?? 'EUR').toUpperCase()

  switch (cur) {
    case 'EUR':
      return `€${value.toFixed(2).replace('.', ',')}`
    case 'GBP':
      return `£${value.toFixed(2)}`
    case 'USD':
      return `$${value.toFixed(2)}`
    default:
      return `${value.toFixed(2)} ${cur}`
  }
}
