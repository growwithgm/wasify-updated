import { adminGraphql, getShopifyConfig } from '@/lib/shopify/admin'

/**
 * Mint a unique, single-use Shopify discount code for one contact.
 *
 * Reuses an existing active code for the same contact + discount rather than
 * minting a new one on every reminder, so a customer who gets three cart
 * reminders sees the same code each time.
 *
 * Requires the write_discounts scope. Any failure returns null — callers must
 * treat a missing code as "send without a discount", never as a hard error.
 */

const CREATE_MUTATION = `
mutation CreateBasicCode($input: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $input) {
    codeDiscountNode { id }
    userErrors { field message }
  }
}`

export async function generateDiscountCodeForContact(
  db: any,
  userId: string,
  discountId: string,
  contactId: string
): Promise<string | null> {
  const { data: discount } = await db
    .from('discounts')
    .select('*')
    .eq('user_id', userId)
    .eq('id', discountId)
    .maybeSingle()

  if (!discount?.enabled) return null

  /* ---- reuse an existing active code for this contact ---- */
  const { data: existing } = await db
    .from('discount_codes')
    .select('code, expires_at')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .eq('discount_id', discountId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing && (!existing.expires_at || new Date(existing.expires_at) > new Date())) {
    return existing.code
  }

  const config = await getShopifyConfig(userId)
  if (!config) return null

  if (config.scopes && !config.scopes.includes('write_discounts')) {
    console.warn('[discounts] write_discounts scope missing — reconnect the store')
    return null
  }

  const { data: contact } = await db.from('contacts').select('name, phone').eq('id', contactId).maybeSingle()
  const code = buildCode(config.store_name ?? 'WASIFY', contact?.name ?? contact?.phone ?? '')

  const startsAt = new Date().toISOString()
  const endsAt = new Date(Date.now() + (discount.expiry_days ?? 7) * 86400_000).toISOString()

  const customerGets =
    discount.discount_type === 'fixed_amount'
      ? {
          value: {
            discountAmount: { amount: String(discount.amount ?? 0), appliesOnEachItem: false },
          },
          items: { all: true },
        }
      : {
          value: { percentage: Number(discount.percentage ?? 0) / 100 },
          items: { all: true },
        }

  const input: Record<string, unknown> = {
    title: `${discount.label} — ${code}`,
    code,
    startsAt,
    endsAt,
    customerSelection: { all: true },
    customerGets,
    appliesOncePerCustomer: true,
    usageLimit: 1,
  }

  if (discount.min_order_amount) {
    ;(input as any).minimumRequirement = {
      subtotal: { greaterThanOrEqualToSubtotal: String(discount.min_order_amount) },
    }
  }

  const res = await adminGraphql<any>(config.store_domain, config.token, CREATE_MUTATION, { input })

  if (!res.ok) {
    console.error('[discounts] Shopify rejected the code', res.error)
    return null
  }

  const errors = res.data?.discountCodeBasicCreate?.userErrors ?? []
  if (errors.length) {
    console.error('[discounts] userErrors', errors)
    return null
  }

  const nodeId = res.data?.discountCodeBasicCreate?.codeDiscountNode?.id ?? null

  await db.from('discount_codes').insert({
    user_id: userId,
    discount_id: discountId,
    contact_id: contactId,
    code,
    shopify_discount_id: nodeId,
    status: 'active',
    expires_at: endsAt,
  })

  return code
}

/** e.g. VELA-MARIA-8F3K — readable, unguessable enough for single use. */
function buildCode(storeName: string, personName: string): string {
  const clean = (input: string) =>
    input
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()

  const store = clean(storeName).slice(0, 5) || 'SHOP'
  const person = clean(personName.split(' ')[0] ?? '').slice(0, 6) || 'VIP'
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()

  return `${store}-${person}-${suffix}`
}
