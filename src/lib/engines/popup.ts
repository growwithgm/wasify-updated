/**
 * Popup / consent-capture logic — the pure half.
 *
 * The popup exists to build the WhatsApp MARKETING opt-in list that the
 * recovery gate (skipped_no_consent) makes mandatory. Everything the
 * storefront shows comes from shopify_config.popup_* via the config
 * endpoint — the theme extension carries NO content, so the merchant's
 * admin edits are live on the next page load.
 */

/**
 * A path as the matcher sees it: lowercase, no origin, no query/hash,
 * leading slash, no trailing slash (except the root itself). Both the
 * visitor's path and the merchant's rules go through this, so
 * "/Collections/Sale/?x=1" and "collections/sale" meet in the middle.
 */
export function normalizePath(input: string | null | undefined): string {
  let path = (input ?? '').trim()
  if (!path) return '/'
  // Strip an accidental full URL down to its path.
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname
  } catch {
    /* keep as-is */
  }
  path = path.split(/[?#]/)[0]
  if (!path.startsWith('/')) path = `/${path}`
  if (path.length > 1) path = path.replace(/\/+$/, '')
  return path.toLowerCase()
}

/** One rule ('/collections/*', '*', '/pages/contact') against one path. */
export function matchesRule(path: string, rule: string): boolean {
  const cleanRule = normalizePath(rule.replace(/\*/g, '\u0000')).replace(/\u0000/g, '*')
  // A bare '*' normalises to '/*': the merchant meant "everywhere".
  if (cleanRule === '/*') return true
  const regex = new RegExp(
    `^${cleanRule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
  )
  return regex.test(normalizePath(path))
}

/**
 * Server-side page targeting. EXCLUDE wins over include; an empty include
 * list (or ['*']) means everywhere. The client never hides the popup itself
 * — it asks, and a "show: false" answer means it was never rendered, so
 * nothing flashes on cart/checkout.
 */
export function pageAllowed(
  path: string,
  includes: unknown,
  excludes: unknown
): boolean {
  const inc = (Array.isArray(includes) ? includes : []).map(String).filter((s) => s.trim())
  const exc = (Array.isArray(excludes) ? excludes : []).map(String).filter((s) => s.trim())

  if (exc.some((rule) => matchesRule(path, rule))) return false
  if (inc.length === 0) return true
  return inc.some((rule) => matchesRule(path, rule))
}

/**
 * Why the popup cannot go live, or null when it can. Shown in the ADMIN —
 * the public endpoint answers a bare "show: false" and never leaks config.
 *
 * Consent text and button text are functional: a checkbox with no label is
 * not consent, and a form with no button does not submit. A discount
 * without a template would generate codes nobody ever receives.
 */
export function popupBlockReason(config: any): string | null {
  if (!config?.popup_enabled) return 'The popup is switched off.'
  if (!String(config.popup_consent_text ?? '').trim()) {
    return 'Consent text is empty — the checkbox must say what the customer is agreeing to.'
  }
  if (!String(config.popup_button_text ?? '').trim()) {
    return 'Button text is empty.'
  }
  if (config.popup_discount_id && !String(config.popup_template ?? '').trim()) {
    return 'A discount is selected but no WhatsApp template is set to deliver the code.'
  }
  return null
}

/**
 * The payload the storefront receives. Content fields pass through EMPTY
 * when the merchant cleared them — the popup hides that element instead of
 * breaking. No length limits anywhere, by design.
 */
export function popupPublicConfig(config: any, discount: any | null) {
  return {
    trigger: {
      kind: ['delay', 'exit_intent', 'scroll'].includes(config.popup_trigger)
        ? config.popup_trigger
        : 'delay',
      value: Number(config.popup_trigger_value ?? 5),
    },
    frequency: { dismiss_days: Number(config.popup_dismiss_days ?? 7) },
    content: {
      heading: String(config.popup_heading ?? ''),
      subheading: String(config.popup_subheading ?? ''),
      button: String(config.popup_button_text ?? ''),
      success: String(config.popup_success_text ?? ''),
      consent: String(config.popup_consent_text ?? ''),
      disclaimer: String(config.popup_disclaimer ?? ''),
    },
    discount: discount
      ? {
          type: discount.discount_type ?? 'percentage',
          percentage: discount.percentage != null ? Number(discount.percentage) : null,
          amount: discount.amount != null ? Number(discount.amount) : null,
          currency: discount.currency ?? 'EUR',
        }
      : null,
  }
}
