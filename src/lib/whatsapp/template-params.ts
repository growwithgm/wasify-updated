/**
 * What a template *requires*, read from the components Meta returned at sync.
 *
 * Meta rejects a send whose parameters do not match the approved template with
 * error #132012 — "Parameter format does not match format in the created
 * template". It says nothing about which component was wrong, and it is raised
 * per recipient, so a broadcast to 5,000 people fails 5,000 times over one
 * missing value.
 *
 * Every mismatch this module can detect is therefore caught before the first
 * send, and named.
 */

export type TemplateShape = {
  headerFormat: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | null
  headerVars: number
  bodyVars: number
  /** Positional index within the BUTTONS block for each URL button taking a suffix. */
  dynamicUrlButtons: number[]
}

/** Highest {{n}} in a string — the count Meta expects, not the number of distinct uses. */
export function countVariables(text: string | null | undefined): number {
  const found = [...(text ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]))
  return found.length ? Math.max(...found) : 0
}

/**
 * NAMED placeholders — {{first_name}} instead of {{1}}.
 *
 * Meta's template builder can create these, and they are invisible to every
 * numeric check here: countVariables sees 0, the send carries 0 parameters,
 * and Meta rejects each message with #131008 "Required parameter is missing".
 * Callers that only speak positional parameters must detect and refuse them.
 */
export function namedVariables(text: string | null | undefined): string[] {
  return [...(text ?? '').matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1])
}

export function templateShape(components: any): TemplateShape {
  const list: any[] = Array.isArray(components) ? components : []
  const header = list.find((c) => String(c?.type).toUpperCase() === 'HEADER')
  const body = list.find((c) => String(c?.type).toUpperCase() === 'BODY')
  const buttons = list.find((c) => String(c?.type).toUpperCase() === 'BUTTONS')

  const format = header ? (String(header.format ?? 'TEXT').toUpperCase() as TemplateShape['headerFormat']) : null

  return {
    headerFormat: format,
    headerVars: format === 'TEXT' ? countVariables(header?.text) : 0,
    bodyVars: countVariables(body?.text),
    dynamicUrlButtons: (buttons?.buttons ?? [])
      .map((b: any, i: number) => (String(b?.type).toUpperCase() === 'URL' && countVariables(b?.url) > 0 ? i : -1))
      .filter((i: number) => i >= 0),
  }
}

/**
 * Why this send would be rejected, or null if the parameters line up.
 *
 * `bodyValues` is what the caller is about to send. Empty strings count as
 * missing: Meta treats a blank parameter as a format error, and a message
 * reading "Hi ," was never the intent anyway.
 */
export function paramMismatch(
  shape: TemplateShape,
  bodyValues: string[],
  opts: { hasHeaderValue?: boolean; urlSuffixes?: number } = {}
): string | null {
  if (bodyValues.length !== shape.bodyVars) {
    return `This template expects ${shape.bodyVars} variable${shape.bodyVars === 1 ? '' : 's'} in its body, but ${bodyValues.length} ${bodyValues.length === 1 ? 'was' : 'were'} supplied.`
  }

  const blank = bodyValues.findIndex((v) => !v || !v.trim())
  if (blank >= 0) {
    return `Variable {{${blank + 1}}} is empty. Every variable needs a value — Meta rejects a blank one.`
  }

  if (shape.headerVars > 0 && !opts.hasHeaderValue) {
    return `This template has a variable in its header, which is not supported here. Use a template whose header is fixed text, or none.`
  }

  if (shape.headerFormat && shape.headerFormat !== 'TEXT' && !opts.hasHeaderValue) {
    return `This template has a ${shape.headerFormat.toLowerCase()} header, which needs a media file to be supplied on every send. Use a text-only template.`
  }

  const suffixes = opts.urlSuffixes ?? 0
  if (shape.dynamicUrlButtons.length !== suffixes) {
    return `This template has ${shape.dynamicUrlButtons.length} button(s) with a dynamic URL, but ${suffixes} link value(s) were supplied.`
  }

  return null
}

/** Human summary for the UI — "1 body variable, fixed header". */
export function describeShape(shape: TemplateShape): string {
  const parts: string[] = []
  parts.push(`${shape.bodyVars} body variable${shape.bodyVars === 1 ? '' : 's'}`)
  if (shape.headerFormat === 'TEXT' && shape.headerVars > 0) parts.push(`${shape.headerVars} header variable(s)`)
  else if (shape.headerFormat && shape.headerFormat !== 'TEXT') parts.push(`${shape.headerFormat.toLowerCase()} header`)
  if (shape.dynamicUrlButtons.length) parts.push(`${shape.dynamicUrlButtons.length} dynamic URL button(s)`)
  return parts.join(', ')
}

/** Meta error codes worth translating — the raw text sends people in circles. */
export const META_ERROR_HINTS: Record<string, string> = {
  '131008':
    'The approved template expects more values than were sent — usually it was edited on Meta after ' +
    'the last sync, has a header/button variable, or uses named {{variables}}. ' +
    'Run Templates → Sync from Meta and rebuild this campaign.',
  '132012':
    'The variables sent did not match the approved template — usually a missing or blank value, ' +
    'or a template whose header or button also needs one.',
  '132001': 'The template name or language does not match an approved template. Re-sync templates from Meta.',
  '132000': 'The number of variables sent does not match the template.',
  '131030': 'That number is not on the allowed list for a test number.',
  '131047': 'More than 24 hours since the customer last wrote — only a template can be sent.',
  '131026': 'The number cannot receive WhatsApp messages.',
}

/** Append the plain-language cause to a raw Meta error, once. */
export function explainMetaError(message: string, code?: string | number | null): string {
  const hint = code != null ? META_ERROR_HINTS[String(code)] : undefined
  if (!hint || message.includes(hint)) return message
  return `${message} — ${hint}`
}
