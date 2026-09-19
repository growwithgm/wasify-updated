'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, Card, CardTitle, ErrorState, Input, Page, PageHeader, Select, Textarea, Toggle,
  ToastProvider, num, useToast,
} from '@/components/ui'
import { popupBlockReason, pageAllowed, normalizePath } from '@/lib/engines/popup'

/**
 * Popup admin — its own section, not a modal, because the merchant edits
 * this constantly. Every field here is read by the storefront through the
 * proxy config endpoint on each page load: SAVE = LIVE. No deploy, no theme
 * edit, no cache to clear.
 */

/** Representative storefront paths the rule tester evaluates against —
 *  including locale-prefixed ones, because 15 of 16 markets carry a prefix. */
const SAMPLE_PATHS = [
  '/',
  '/de',
  '/products/summer-dress',
  '/en-es/products/summer-dress',
  '/fr/collections/sale',
  '/collections/sale',
  '/pages/contact',
  '/cart',
  '/checkouts/c/12345',
]

export default function PopupPage() {
  return (
    <ToastProvider>
      <PopupScreen />
    </ToastProvider>
  )
}

const BLANK = {
  popup_enabled: false,
  popup_include_paths: ['/', '/products/*'] as string[],
  popup_exclude_paths: ['/cart*', '/checkout*', '/checkouts*'] as string[],
  popup_strip_locale: true,
  popup_heading: '',
  popup_subheading: '',
  popup_button_text: '',
  popup_success_text: '',
  popup_success_note: '',
  popup_success_button: '',
  popup_consent_text: '',
  popup_disclaimer: '',
  popup_trigger_exit: false,
  popup_trigger_delay: true,
  popup_trigger_delay_seconds: 5,
  popup_trigger_scroll: false,
  popup_trigger_scroll_pct: 40,
  popup_trigger_all: false,
  popup_dismiss_days: 7,
  popup_teaser_enabled: true,
  popup_teaser_text: 'Get your discount',
  popup_teaser_position: 'bottom-right',
  popup_devices: 'all',
  popup_discount_id: null as string | null,
  popup_template: '',
}

function PopupScreen() {
  const toast = useToast()
  const [form, setForm] = useState<any>(BLANK)
  const [loaded, setLoaded] = useState(false)
  const [noStore, setNoStore] = useState(false)
  const [error, setError] = useState('')
  const [discounts, setDiscounts] = useState<any[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [stats, setStats] = useState<{ impressions: number; submits: number }>({ impressions: 0, submits: 0 })
  const [saving, setSaving] = useState(false)
  const [testPath, setTestPath] = useState('/products/summer-dress')

  // Inline discount creator — the merchant should not have to leave this
  // page (Catalog) just to have a code the popup can hand out.
  const [creatingDiscount, setCreatingDiscount] = useState(false)
  const [discountSaving, setDiscountSaving] = useState(false)
  const [newDiscount, setNewDiscount] = useState({
    label: 'Popup welcome',
    discount_type: 'percentage',
    percentage: 10,
    amount: 10,
    expiry_days: 2,
  })

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/popup', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      if (!json.config) {
        setNoStore(true)
      } else {
        setForm({ ...BLANK, ...json.config })
      }
      setDiscounts(json.discounts ?? [])
      setTemplates(json.templates ?? [])
      setStats(json.stats ?? { impressions: 0, submits: 0 })
      setLoaded(true)
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }))

  async function save() {
    setSaving(true)
    try {
      const payload: any = Object.fromEntries(
        Object.entries(form).filter(([k]) => k.startsWith('popup_'))
      )
      // Blank lines from mid-edit textareas never reach the rules.
      payload.popup_include_paths = (form.popup_include_paths ?? []).map((s: string) => s.trim()).filter(Boolean)
      payload.popup_exclude_paths = (form.popup_exclude_paths ?? []).map((s: string) => s.trim()).filter(Boolean)

      const res = await fetch('/api/settings/shopify', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      toast(res.ok ? 'Saved — live on the storefront now' : json.error, res.ok ? 'green' : 'red')
    } finally {
      setSaving(false)
    }
  }

  async function createDiscount() {
    if (!newDiscount.label.trim()) {
      toast('Give the discount a label', 'red')
      return
    }
    setDiscountSaving(true)
    try {
      const res = await fetch('/api/discounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newDiscount, enabled: true }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast(json.error ?? 'Could not create the discount', 'red')
        return
      }
      // Straight into the list AND selected — but only saved with the page's
      // own Save button, like every other field here.
      setDiscounts((list) => [...list, json.discount])
      set('popup_discount_id', json.discount.id)
      setCreatingDiscount(false)
      toast('Discount created and selected — remember to Save', 'green')
    } finally {
      setDiscountSaving(false)
    }
  }

  const blockReason = popupBlockReason(form)
  const conversion = stats.impressions > 0 ? (stats.submits / stats.impressions) * 100 : 0

  const includes = form.popup_include_paths ?? []
  const excludes = form.popup_exclude_paths ?? []

  const sampleResults = useMemo(
    () =>
      SAMPLE_PATHS.map((p) => ({
        path: p,
        shown: pageAllowed(p, includes, excludes, { stripLocale: form.popup_strip_locale ?? true }),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(includes), JSON.stringify(excludes), form.popup_strip_locale]
  )

  if (noStore) {
    return (
      <Page>
        <PageHeader title="Popup" subtitle="WhatsApp opt-in popup" />
        <Card>
          <div className="py-6 text-center text-[13px]" style={{ color: 'var(--w-muted)' }}>
            Connect a Shopify store first (Integrations) — the popup runs on your storefront.
          </div>
        </Card>
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader
        title="Popup"
        subtitle="WhatsApp opt-in popup — every save is live on the storefront immediately"
        actions={
          <Button variant="primary" loading={saving} onClick={save} disabled={!loaded}>
            Save changes
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: 'minmax(0, 1fr) 380px' }}>
        {/* ---------------- left: settings ---------------- */}
        <div className="min-w-0">
          <Card className="mb-4">
            <Toggle
              checked={form.popup_enabled ?? false}
              onChange={(v: boolean) => set('popup_enabled', v)}
              label="Popup enabled"
              sub="Signups keep working either way — this controls whether the popup appears at all"
            />
            {form.popup_enabled && blockReason && (
              <div
                className="mt-3 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed"
                style={{ background: 'var(--w-ambertint)', color: '#92400E' }}
              >
                <b>Not live yet:</b> {blockReason} This reason never reaches the storefront — visitors
                simply see nothing.
              </div>
            )}
            {form.popup_enabled && !blockReason && (
              <div
                className="mt-3 rounded-lg px-3 py-2 text-[12.5px]"
                style={{ background: 'var(--w-greentint)', color: '#15803D' }}
              >
                Live — visitors on matching pages will see the popup on their next page load.
              </div>
            )}
          </Card>

          <Card className="mb-4">
            <CardTitle title="Content" sub="No length limits. An empty field simply hides that part of the popup — nothing breaks." />
            <div className="grid gap-3">
              <Input label="Heading" value={form.popup_heading ?? ''} onChange={(e) => set('popup_heading', e.target.value)} />
              <Textarea label="Subheading" rows={2} value={form.popup_subheading ?? ''} onChange={(e) => set('popup_subheading', e.target.value)} />
              <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <Input label="Button text" value={form.popup_button_text ?? ''} onChange={(e) => set('popup_button_text', e.target.value)} />
                <Input label="Success message" value={form.popup_success_text ?? ''} onChange={(e) => set('popup_success_text', e.target.value)} />
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 200px' }}>
                <Input
                  label="Success note"
                  value={form.popup_success_note ?? ''}
                  onChange={(e) => set('popup_success_note', e.target.value)}
                  hint="Small line under the code on the success screen."
                />
                <Input
                  label="Success screen button"
                  value={form.popup_success_button ?? ''}
                  onChange={(e) => set('popup_success_button', e.target.value)}
                  hint="Closes the popup."
                />
              </div>
              <Textarea
                label="Consent checkbox text"
                rows={3}
                value={form.popup_consent_text ?? ''}
                onChange={(e) => set('popup_consent_text', e.target.value)}
                hint="The legal text. Exactly what the visitor sees here is copied into every consent record — write it with your brand name and the word WhatsApp. Never truncated."
              />
              <Input
                label="Disclaimer line"
                value={form.popup_disclaimer ?? ''}
                onChange={(e) => set('popup_disclaimer', e.target.value)}
                hint="Small print under the button."
              />
            </div>
          </Card>

          <Card className="mb-4">
            <CardTitle
              title="Page targeting"
              sub="One rule per line, * is a wildcard. Exclude wins over include. Decided on the SERVER — the popup never flashes on an excluded page."
            />
            <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Textarea
                label="Show on (include)"
                rows={4}
                value={(includes as string[]).join('\n')}
                onChange={(e) => set('popup_include_paths', e.target.value.split('\n'))}
                hint="Empty (or *) = everywhere."
              />
              <Textarea
                label="Never on (exclude)"
                rows={4}
                value={(excludes as string[]).join('\n')}
                onChange={(e) => set('popup_exclude_paths', e.target.value.split('\n'))}
                hint="Cart/checkout excluded by default."
              />
            </div>

            <div className="mt-3">
              <Toggle
                checked={form.popup_strip_locale ?? true}
                onChange={(v: boolean) => set('popup_strip_locale', v)}
                label="Ignore locale prefixes (/de/…, /en-es/…)"
                sub="Multi-market stores prefix every path with a locale. ON = rules written without the prefix work on all markets. Turn OFF only if you have a real two-letter page like /tv."
              />
            </div>

            {/* Live rule tester — so a bad rule is caught BEFORE saving. */}
            <div className="mt-3 rounded-[10px] border p-3" style={{ borderColor: 'var(--w-border)', background: 'var(--w-card2)' }}>
              <div className="mb-2 text-[12.5px] font-semibold">Where would it show right now?</div>
              <div className="flex flex-wrap gap-1.5">
                {sampleResults.map((r) => (
                  <span
                    key={r.path}
                    className="rounded-full border px-2 py-[3px] text-[11.5px] font-medium"
                    style={{
                      background: r.shown ? 'var(--w-greentint)' : 'var(--w-errortint)',
                      color: r.shown ? '#15803D' : '#B91C1C',
                      borderColor: r.shown ? '#BBF7D0' : '#FCA5A5',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {r.shown ? '✓' : '✗'} {r.path}
                  </span>
                ))}
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                <input
                  value={testPath}
                  onChange={(e) => setTestPath(e.target.value)}
                  placeholder="/collections/anything"
                  className="min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-[12.5px] outline-none"
                  style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)', fontFamily: "'JetBrains Mono', monospace" }}
                />
                <span
                  className="shrink-0 rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold"
                  style={{
                    background: pageAllowed(testPath, includes, excludes, { stripLocale: form.popup_strip_locale ?? true })
                      ? 'var(--w-greentint)'
                      : 'var(--w-errortint)',
                    color: pageAllowed(testPath, includes, excludes, { stripLocale: form.popup_strip_locale ?? true })
                      ? '#15803D'
                      : '#B91C1C',
                  }}
                >
                  {pageAllowed(testPath, includes, excludes, { stripLocale: form.popup_strip_locale ?? true })
                    ? `Shows on ${normalizePath(testPath)}`
                    : `Hidden on ${normalizePath(testPath)}`}
                </span>
              </div>
            </div>
          </Card>

          <Card className="mb-4">
            <CardTitle
              title="Triggers"
              sub="Any combination can be on at once. Default is OR — whichever fires first opens the popup."
            />
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Toggle
                  checked={form.popup_trigger_delay ?? true}
                  onChange={(v: boolean) => set('popup_trigger_delay', v)}
                  label="Time delay"
                  sub="Open after N seconds on the page"
                />
                {form.popup_trigger_delay && (
                  <Input
                    label="Seconds"
                    type="number"
                    value={String(form.popup_trigger_delay_seconds ?? 5)}
                    onChange={(e) => set('popup_trigger_delay_seconds', Number(e.target.value))}
                  />
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <Toggle
                  checked={form.popup_trigger_scroll ?? false}
                  onChange={(v: boolean) => set('popup_trigger_scroll', v)}
                  label="Scroll depth"
                  sub="Open once the visitor has scrolled this far"
                />
                {form.popup_trigger_scroll && (
                  <Input
                    label="Depth (%)"
                    type="number"
                    value={String(form.popup_trigger_scroll_pct ?? 40)}
                    onChange={(e) => set('popup_trigger_scroll_pct', Number(e.target.value))}
                  />
                )}
              </div>

              <Toggle
                checked={form.popup_trigger_exit ?? false}
                onChange={(v: boolean) => set('popup_trigger_exit', v)}
                label="Exit intent"
                sub="Cursor leaves toward the top of the window. Phones have no cursor — there it falls back to the delay."
              />

              <div className="rounded-lg px-3 py-2" style={{ background: 'var(--w-card2)' }}>
                <Toggle
                  checked={form.popup_trigger_all ?? false}
                  onChange={(v: boolean) => set('popup_trigger_all', v)}
                  label="Only show if ALL selected conditions are met"
                  sub="OFF = OR (first one wins). ON = AND (every enabled trigger must happen first)."
                />
              </div>
            </div>
          </Card>

          <Card className="mb-4">
            <CardTitle
              title="Frequency, teaser & devices"
              sub="After subscribing, the popup never shows again on that browser."
            />
            <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Input
                label="After dismiss, hide popup for (days)"
                type="number"
                value={String(form.popup_dismiss_days ?? 7)}
                onChange={(e) => set('popup_dismiss_days', Number(e.target.value))}
              />
              <Select
                label="Devices"
                value={form.popup_devices ?? 'all'}
                onChange={(e) => set('popup_devices', e.target.value)}
              >
                <option value="all">All devices</option>
                <option value="desktop">Desktop only</option>
                <option value="mobile">Mobile only</option>
              </Select>
            </div>
            <div className="mt-1.5 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
              The device decision is made on the server from the visitor&apos;s browser — nothing loads
              on the wrong device.
            </div>

            <div className="mt-4">
              <Toggle
                checked={form.popup_teaser_enabled ?? true}
                onChange={(v: boolean) => set('popup_teaser_enabled', v)}
                label="Teaser tab after dismiss"
                sub="A small tab stays on the screen edge so the visitor can reopen the popup themselves. Frequency rules bind the popup, never the teaser."
              />
              {form.popup_teaser_enabled && (
                <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: '1fr 200px' }}>
                  <Input
                    label="Teaser text"
                    value={form.popup_teaser_text ?? ''}
                    onChange={(e) => set('popup_teaser_text', e.target.value)}
                    hint="Empty text = no teaser; nothing breaks."
                  />
                  <Select
                    label="Position"
                    value={form.popup_teaser_position ?? 'bottom-right'}
                    onChange={(e) => set('popup_teaser_position', e.target.value)}
                  >
                    <option value="bottom-right">Bottom right</option>
                    <option value="bottom-left">Bottom left</option>
                  </Select>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardTitle title="Discount & delivery" sub="The code is unique per contact, generated at signup, and sent on WhatsApp." />
            <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Select
                label="Discount"
                value={form.popup_discount_id ?? ''}
                onChange={(e) => set('popup_discount_id', e.target.value || null)}
              >
                <option value="">No discount — list building only</option>
                {discounts.filter((d) => d.enabled).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label} —{' '}
                    {d.discount_type === 'fixed_amount' ? `${d.amount} ${d.currency}` : `${d.percentage}%`}, expires in{' '}
                    {d.expiry_days}d
                  </option>
                ))}
              </Select>
              <Select label="WhatsApp template" value={form.popup_template ?? ''} onChange={(e) => set('popup_template', e.target.value)}>
                <option value="">Pick a template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name} ({t.language})
                  </option>
                ))}
              </Select>
            </div>
            {!creatingDiscount ? (
              <div className="mt-2">
                <Button variant="ghost" onClick={() => setCreatingDiscount(true)}>
                  + New discount
                </Button>
              </div>
            ) : (
              <div
                className="mt-3 rounded-[10px] border p-3"
                style={{ borderColor: 'var(--w-border)', background: 'var(--w-card2)' }}
              >
                <div className="mb-2 text-[12.5px] font-semibold">New discount</div>
                <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  <Input
                    label="Label"
                    value={newDiscount.label}
                    onChange={(e) => setNewDiscount((d) => ({ ...d, label: e.target.value }))}
                  />
                  <Select
                    label="Type"
                    value={newDiscount.discount_type}
                    onChange={(e) => setNewDiscount((d) => ({ ...d, discount_type: e.target.value }))}
                  >
                    <option value="percentage">Percentage off</option>
                    <option value="fixed_amount">Fixed amount off</option>
                  </Select>
                  {newDiscount.discount_type === 'fixed_amount' ? (
                    <Input
                      label="Amount"
                      type="number"
                      value={String(newDiscount.amount)}
                      onChange={(e) => setNewDiscount((d) => ({ ...d, amount: Number(e.target.value) }))}
                    />
                  ) : (
                    <Input
                      label="Percentage (%)"
                      type="number"
                      value={String(newDiscount.percentage)}
                      onChange={(e) => setNewDiscount((d) => ({ ...d, percentage: Number(e.target.value) }))}
                    />
                  )}
                  <Input
                    label="Expires after (days)"
                    type="number"
                    value={String(newDiscount.expiry_days)}
                    onChange={(e) => setNewDiscount((d) => ({ ...d, expiry_days: Number(e.target.value) }))}
                  />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="primary" loading={discountSaving} onClick={createDiscount}>
                    Create &amp; select
                  </Button>
                  <Button variant="ghost" onClick={() => setCreatingDiscount(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            <div className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--w-muted)' }}>
              Template contract: <code style={{ fontFamily: "'JetBrains Mono', monospace" }}>{'{{1}}'}</code> = the
              discount code (or none, for a plain welcome). A &ldquo;copy code&rdquo; button gets the customer&rsquo;s own
              code automatically.
            </div>
          </Card>
        </div>

        {/* ---------------- right: preview + stats ---------------- */}
        <div className="min-w-0">
          <Card className="mb-4">
            <CardTitle title="Live preview" sub="Rendered from the values on this page — exactly what the visitor gets." />
            {/* The storefront popup is fixed monochrome, so the preview uses
                the design's real colors, not the admin theme. */}
            <div className="rounded-xl p-4" style={{ background: 'var(--w-card2)' }}>
              <div
                className="mx-auto max-w-[320px] rounded-[4px] p-6 text-center shadow-lg"
                style={{ background: '#FFFFFF', color: '#111111' }}
              >
                {String(form.popup_heading ?? '').trim() && (
                  <div
                    className="text-[20px] leading-snug"
                    style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
                  >
                    {form.popup_heading}
                  </div>
                )}
                {String(form.popup_subheading ?? '').trim() && (
                  <div className="mt-2 text-[12px] leading-relaxed" style={{ color: '#555555' }}>
                    {form.popup_subheading}
                  </div>
                )}
                <div
                  className="mt-3.5 flex items-stretch overflow-hidden rounded-[3px] text-left"
                  style={{ border: '1px solid #111111' }}
                >
                  <span
                    className="flex items-center px-2.5 text-[13px]"
                    style={{ background: '#F7F7F5', borderRight: '1px solid #E3E3E0' }}
                  >
                    +34
                  </span>
                  <span className="flex-1 px-2.5 py-2 text-[13px]" style={{ color: '#A8A8A6' }}>
                    600 123 456
                  </span>
                </div>
                {String(form.popup_consent_text ?? '').trim() && (
                  <label
                    className="mt-3 flex items-start gap-2 text-left text-[10.5px] leading-relaxed"
                    style={{ color: '#555555' }}
                  >
                    <input type="checkbox" className="mt-0.5" readOnly checked={false} style={{ accentColor: '#111111' }} />
                    <span>{form.popup_consent_text}</span>
                  </label>
                )}
                {String(form.popup_button_text ?? '').trim() && (
                  <div
                    className="mt-3.5 rounded-[3px] py-2.5 text-center text-[12px] font-semibold uppercase text-white"
                    style={{ background: '#111111', letterSpacing: '0.12em' }}
                  >
                    {form.popup_button_text}
                  </div>
                )}
                {String(form.popup_disclaimer ?? '').trim() && (
                  <div className="mt-2.5 text-center text-[10.5px]" style={{ color: '#A8A8A6' }}>
                    {form.popup_disclaimer}
                  </div>
                )}
              </div>

              {/* After submit: the dark success screen. */}
              <div
                className="mx-auto mt-4 max-w-[320px] rounded-[4px] p-6 text-center shadow-lg"
                style={{ background: '#0A0A0A', color: '#FFFFFF' }}
              >
                <div
                  className="mx-auto flex h-9 w-9 items-center justify-center rounded-full text-[18px] font-bold"
                  style={{ background: '#FFFFFF', color: '#0A0A0A' }}
                >
                  ✓
                </div>
                {String(form.popup_success_text ?? '').trim() && (
                  <div
                    className="mt-3 text-[18px] leading-snug"
                    style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
                  >
                    {form.popup_success_text}
                  </div>
                )}
                <div className="mt-3.5 rounded-[3px] p-3" style={{ border: '1px dashed #4A4A48' }}>
                  <div
                    className="text-[16px] font-bold"
                    style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.22em' }}
                  >
                    WELCOME10
                  </div>
                  <div
                    className="mx-auto mt-2 inline-block rounded-[3px] px-3.5 py-1 text-[11px]"
                    style={{ border: '1px solid #4A4A48' }}
                  >
                    Copy
                  </div>
                </div>
                {String(form.popup_success_note ?? '').trim() && (
                  <div className="mt-3 text-[11px] leading-relaxed" style={{ color: '#A8A8A6' }}>
                    {form.popup_success_note}
                  </div>
                )}
                {String(form.popup_success_button ?? '').trim() && (
                  <div
                    className="mt-3.5 rounded-[3px] py-2.5 text-center text-[12px] font-semibold uppercase"
                    style={{ background: '#FFFFFF', color: '#0A0A0A', letterSpacing: '0.12em' }}
                  >
                    {form.popup_success_button}
                  </div>
                )}
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle title="Stats" sub="Impressions count only real renders — pages where the popup actually appeared." />
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {[
                ['Impressions', num(stats.impressions), 'var(--w-text)'],
                ['Submits', num(stats.submits), '#16A34A'],
                ['Conversion', `${conversion.toFixed(1)}%`, '#2563EB'],
              ].map(([label, value, color]) => (
                <div
                  key={label as string}
                  className="rounded-lg border p-3 text-center"
                  style={{ borderColor: 'var(--w-border)', background: 'var(--w-card2)' }}
                >
                  <div className="text-[18px] font-bold" style={{ color: color as string }}>
                    {value as string}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--w-muted)' }}>
                    {label as string}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </Page>
  )
}
