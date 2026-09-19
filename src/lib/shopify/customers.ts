import { adminGraphql, configByStoreDomain } from './admin'
import { bisTags } from '@/lib/flow/stock-alerts'

/**
 * Mirror a signup into Shopify as a customer + tags, so Shopify Flow can run
 * store-side automation on it ("Customer tags added").
 *
 * This exists because the theme cannot do it: the native customer form
 * submits `contact[phone]` but Shopify never maps it onto the record — a
 * known platform issue — and this whole system runs on phone. Admin API only.
 *
 * Two hard rules, both GDPR-shaped:
 *   · NEVER touch emailMarketingConsent or smsMarketingConsent. Wasify holds
 *     WHATSAPP consent, not SMS or email consent — and Klaviyo syncs Shopify
 *     customers, so a wrongly-set consent leaks straight into email/SMS
 *     campaigns. Only tags are written.
 *   · This must never fail the signup that triggered it. It reports ok/error
 *     instead of throwing, and the caller decides (the popup queues a retry).
 *
 * Requires the `write_customers` scope and Protected Customer Data (Level 2)
 * approval — see SETUP.md.
 */
export async function upsertShopifyCustomer(
  shop: string,
  person: { email?: string | null; phone: string; name?: string | null; tags: string[] }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const config = await configByStoreDomain(shop)
    if (!config) return { ok: false, error: `No connected store for ${shop}` }

    const e164 = `+${person.phone}`
    const email = (person.email ?? '').trim().toLowerCase()

    /* ------------------------------ find ------------------------------ */
    // Email first — it is the stabler identifier in Shopify — then phone.
    const search = email ? `email:"${email}"` : `phone:${e164}`
    const found = await adminGraphql<{ customers: { nodes: Array<{ id: string; phone: string | null }> } }>(
      config.store_domain,
      config.token,
      `query Find($q: String!) { customers(first: 1, query: $q) { nodes { id phone } } }`,
      { q: search }
    )
    if (!found.ok) {
      return { ok: false, error: `search failed: ${found.error}` }
    }

    let customerId = found.data.customers.nodes[0]?.id ?? null
    const existingPhone = found.data.customers.nodes[0]?.phone ?? null

    /* ------------------------- create / update ------------------------ */
    if (!customerId) {
      const created = await adminGraphql<any>(
        config.store_domain,
        config.token,
        `mutation Create($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id }
            userErrors { field message }
          }
        }`,
        {
          input: {
            ...(email ? { email } : {}),
            phone: e164,
            ...(person.name?.trim() ? { firstName: person.name.trim() } : {}),
          },
        }
      )
      const errors = created.ok ? (created.data?.customerCreate?.userErrors ?? []) : []
      customerId = created.ok ? (created.data?.customerCreate?.customer?.id ?? null) : null
      if (!customerId) {
        // A phone already on ANOTHER customer is the common failure — retry
        // the create without the phone rather than losing the tag entirely.
        if (email && errors.some((e: any) => /phone/i.test(String(e.message)))) {
          const retry = await adminGraphql<any>(
            config.store_domain,
            config.token,
            `mutation Create($input: CustomerInput!) {
              customerCreate(input: $input) {
                customer { id }
                userErrors { field message }
              }
            }`,
            { input: { email, ...(person.name?.trim() ? { firstName: person.name.trim() } : {}) } }
          )
          customerId = retry.ok ? (retry.data?.customerCreate?.customer?.id ?? null) : null
        }
        if (!customerId) {
          return {
            ok: false,
            error: `create failed: ${created.ok ? JSON.stringify(errors) : created.error}`,
          }
        }
      }
    } else if (!existingPhone) {
      // Existing record found by email but with no phone — add it. If the
      // phone is taken elsewhere this errors; log and keep going, the tag
      // still matters more than the field.
      const updated = await adminGraphql<any>(
        config.store_domain,
        config.token,
        `mutation Update($input: CustomerInput!) {
          customerUpdate(input: $input) { userErrors { field message } }
        }`,
        { input: { id: customerId, phone: e164 } }
      )
      const errors = updated.ok ? (updated.data?.customerUpdate?.userErrors ?? []) : []
      if (errors.length) console.error('[shopify-customer] phone update refused', JSON.stringify(errors))
    }

    /* ------------------------------ tags ------------------------------ */
    // tagsAdd is idempotent — repeat signups never duplicate a tag.
    const tagged = await adminGraphql<any>(
      config.store_domain,
      config.token,
      `mutation Tag($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { message } }
      }`,
      { id: customerId, tags: person.tags }
    )
    const tagErrors = tagged.ok ? (tagged.data?.tagsAdd?.userErrors ?? []) : []
    if (!tagged.ok || tagErrors.length) {
      return {
        ok: false,
        error: `tagging failed: ${tagged.ok ? JSON.stringify(tagErrors) : tagged.error}`,
      }
    }

    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** Back-in-stock wrapper: fire-and-forget, tags derived from the variants. */
export async function upsertBisCustomer(
  shop: string,
  signup: { email?: string | null; phone: string; name?: string | null; variantIds: Array<string | number> }
): Promise<void> {
  const res = await upsertShopifyCustomer(shop, {
    email: signup.email,
    phone: signup.phone,
    name: signup.name,
    tags: bisTags(signup.variantIds),
  })
  if (!res.ok) console.error('[bis-customer]', res.error)
}
