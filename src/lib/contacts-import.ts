import { sanitizePhone, isValidPhone } from '@/lib/phone'

/**
 * The in-memory half of the CSV import.
 *
 * The old import walked the file one row at a time, paying three sequential
 * database round trips per contact — ~2,500 for an 800-row file, which took
 * minutes, and past ~4,000 rows blew through the function's time limit and
 * died mid-file with no report. Everything here exists to let the route
 * touch the database in BULK: validate, normalise and collapse the rows
 * first, so each batch becomes a handful of set-based statements instead of
 * a statement per row.
 */

export type ImportRow = Record<string, string>
export type ColumnMapping = Record<string, string>
export type RowError = { row: number; phone: string; reason: string }

export type PreparedRow = {
  /** Identity key: last-8 digits when long enough, else the full number. */
  key: string
  digits: string
  /** 1-based line in the original file, counting the header. */
  rowNumber: number
  seed: Record<string, string>
  tagNames: string[]
}

/**
 * The only contact columns a CSV may write. The mapping comes from the
 * browser, and the insert spreads the seed straight into the row — without
 * this list a crafted mapping could set opt_in_status or lifetime_spent.
 */
export const SEED_FIELDS = ['name', 'email', 'company', 'country', 'city', 'postcode', 'locale'] as const

/**
 * Tag names for one row.
 *
 * Every column mapped to "tag" is read, not just the first, and a cell may
 * hold several names separated by a comma, semicolon or pipe — "VIP, Madrid"
 * is two tags, which is what anyone writing it meant. Duplicates within a row
 * collapse case-insensitively.
 */
export function rowTagNames(row: ImportRow, tagColumns: string[]): string[] {
  const seen = new Map<string, string>()
  for (const column of tagColumns) {
    for (const part of (row[column] ?? '').split(/[,;|]/)) {
      const name = part.trim()
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name)
    }
  }
  return [...seen.values()]
}

/** Same identity rule as phonesMatch: exact, or last-8 when both are long. */
export function phoneKey(digits: string): string {
  return digits.length >= 8 ? digits.slice(-8) : digits
}

/**
 * Validate and collapse a slice of the file before the database sees it.
 *
 * Rows sharing one phone (by the phonesMatch identity rule) merge into a
 * single prepared row — first non-empty value wins per field, tag names
 * union — because two inserts for one person in the same batch would create
 * the duplicate the import promises not to. `duplicates` counts the rows
 * that collapsed, so the summary can report them as merged, same as when
 * they had been imported one by one.
 *
 * `rowOffset` is how many data rows earlier requests already carried, so
 * error line numbers keep pointing at the real spreadsheet line.
 */
export function prepareRows(
  rows: ImportRow[],
  mapping: ColumnMapping,
  rowOffset = 0
): { prepared: PreparedRow[]; errors: RowError[]; duplicates: number } {
  const phoneColumn = Object.entries(mapping).find(([, field]) => field === 'phone')?.[0] ?? ''
  const tagColumns = Object.entries(mapping)
    .filter(([, field]) => field === 'tag')
    .map(([column]) => column)

  const byKey = new Map<string, PreparedRow>()
  const errors: RowError[] = []
  let duplicates = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNumber = rowOffset + i + 2 // 1-indexed plus the header line
    const rawPhone = row[phoneColumn] ?? ''
    const digits = sanitizePhone(rawPhone)

    if (!isValidPhone(digits)) {
      errors.push({
        row: rowNumber,
        phone: rawPhone,
        reason: !digits
          ? 'Phone is empty'
          : digits[0] === '0'
            ? 'Missing country code (starts with 0)'
            : 'Not 7–15 digits',
      })
      continue
    }

    const seed: Record<string, string> = {}
    for (const [column, field] of Object.entries(mapping)) {
      if (!(SEED_FIELDS as readonly string[]).includes(field)) continue
      const value = (row[column] ?? '').trim()
      if (value) seed[field] = value
    }

    const key = phoneKey(digits)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { key, digits, rowNumber, seed, tagNames: rowTagNames(row, tagColumns) })
      continue
    }

    duplicates++
    for (const [field, value] of Object.entries(seed)) {
      if (!existing.seed[field]) existing.seed[field] = value
    }
    const known = new Set(existing.tagNames.map((t) => t.toLowerCase()))
    for (const name of rowTagNames(row, tagColumns)) {
      if (!known.has(name.toLowerCase())) existing.tagNames.push(name)
    }
  }

  return { prepared: [...byKey.values()], errors, duplicates }
}

/**
 * Index database candidates by the same identity rule, so matching a
 * prepared row is one Map lookup instead of a scan per row.
 */
export function phoneIndex<T extends { phone: string }>(candidates: T[]): Map<string, T> {
  const index = new Map<string, T>()
  for (const c of candidates) {
    const digits = sanitizePhone(c.phone)
    if (!digits) continue
    const key = phoneKey(digits)
    if (!index.has(key)) index.set(key, c)
  }
  return index
}

/**
 * Backfill only the fields the stored contact is missing — never overwrite
 * good data. The same rule findOrCreateContact applies one row at a time.
 */
export function backfillPatch(
  existing: Record<string, unknown>,
  seed: Record<string, string>
): Record<string, string> {
  const patch: Record<string, string> = {}
  for (const [field, value] of Object.entries(seed)) {
    if (value && !existing[field]) patch[field] = value
  }
  return patch
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
