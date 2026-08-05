'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Button, Card, CardTitle, EmptyState, ErrorState, Input, Modal, Page, PageHeader, Pill, Select,
  Table, TableSkeleton, Td, Th, Toggle, ToastProvider, money, num, relTime, useToast,
} from '@/components/ui'
import { IconCatalog, IconPlus, IconRefresh, IconSearch, IconTrash } from '@/components/icons'
import { formatPhone } from '@/lib/phone'

export default function CatalogPage() {
  return (
    <ToastProvider>
      <CatalogScreen />
    </ToastProvider>
  )
}

function CatalogScreen() {
  const toast = useToast()
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [discountModal, setDiscountModal] = useState<any>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const url = new URL('/api/catalog', window.location.origin)
      if (q) url.searchParams.set('q', q)
      const res = await fetch(url, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setData(json)
    } catch (e: any) {
      setError(e.message)
    }
  }, [q])

  useEffect(() => {
    const t = setTimeout(load, 300)
    return () => clearTimeout(t)
  }, [load])

  async function sync() {
    setSyncing(true)
    try {
      const res = await fetch('/api/shopify/sync', { method: 'POST' })
      const json = await res.json()
      // Never report a cheerful zero: if a resource failed, say which and why.
      toast(
        !res.ok
          ? json.error
          : json.errors?.length
            ? json.errors.join(' · ')
            : `Synced ${json.products} products, ${json.orders} orders, ${json.checkouts} carts`,
        res.ok && !json.errors?.length ? 'green' : 'red'
      )
      load()
    } finally {
      setSyncing(false)
    }
  }

  async function generateCode(discountId: string) {
    const res = await fetch('/api/discounts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discount_id: discountId }),
    })
    const json = await res.json()
    toast(res.ok ? `Generated ${json.code}` : json.error, res.ok ? 'green' : 'red')
    load()
  }

  async function removeDiscount(id: string) {
    if (!confirm('Delete this discount definition? Codes already issued keep working in Shopify.')) return
    await fetch(`/api/discounts?id=${id}`, { method: 'DELETE' })
    toast('Discount deleted')
    load()
  }

  const connected = data?.config?.connection_status === 'connected'
  const missingScope = data?.config?.scopes && !data.config.scopes.includes('write_discounts')

  return (
    <Page>
      <PageHeader
        title="Catalog & Commerce"
        subtitle="Shopify products, chat carts, orders and discount codes"
        actions={
          <Button onClick={sync} loading={syncing} disabled={!connected}>
            <IconRefresh size={13} /> Sync now
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      {data && !connected && (
        <Card className="mb-4" style={{ background: 'var(--w-ambertint)', borderColor: '#FDE68A' }}>
          <div className="text-[13px] font-semibold" style={{ color: '#92400E' }}>
            Shopify is not connected
          </div>
          <div className="mt-1 text-[12.5px]" style={{ color: '#92400E' }}>
            Connect your store on the Integrations screen to sync products, orders and carts.{' '}
            <a href="/integrations">Go to Integrations →</a>
          </div>
        </Card>
      )}

      {!data ? (
        <TableSkeleton rows={8} cols={6} />
      ) : (
        <>
          {connected && (
            <Card padding={12} className="mb-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-2 text-[12.5px] font-semibold" style={{ color: '#16A34A' }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: '#22C55E' }} />
                  Catalog synced · {num(data.productCount)} products
                </span>
                <span className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
                  {data.config.last_sync_at ? `last sync ${relTime(data.config.last_sync_at)}` : 'never synced'}
                </span>
                <div
                  className="ml-auto flex min-w-[200px] items-center gap-2 rounded-lg border px-3 py-1.5"
                  style={{ background: 'var(--w-canvas)', borderColor: 'var(--w-border)' }}
                >
                  <IconSearch size={14} style={{ color: '#6B7280' }} />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search products…"
                    className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none"
                  />
                </div>
              </div>
            </Card>
          )}

          {/* products */}
          <Card padding={0} className="mb-4">
            <div className="px-5 pb-1 pt-5">
              <CardTitle title="Product sync status" sub="Mirrored from Shopify by the nightly job and manual syncs" />
            </div>
            {data.products.length === 0 ? (
              <EmptyState
                icon={<IconCatalog size={30} />}
                title="No products yet"
                body={connected ? 'Run a sync to pull your catalog from Shopify.' : 'Connect Shopify first.'}
                action={connected ? <Button variant="primary" onClick={sync}>Sync now</Button> : null}
              />
            ) : (
              <Table minWidth={760}>
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th>Vendor</Th>
                    <Th align="right">Price</Th>
                    <Th align="right">Stock</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((p: any) => (
                    <tr key={p.id}>
                      <Td>
                        <span className="flex items-center gap-2">
                          {p.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.image_url} alt="" className="h-8 w-8 rounded object-cover" />
                          ) : (
                            <span
                              className="flex h-8 w-8 items-center justify-center rounded"
                              style={{ background: 'var(--w-card2)' }}
                            >
                              <IconCatalog size={14} style={{ color: 'var(--w-muted)' }} />
                            </span>
                          )}
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{p.title}</span>
                            {p.sku && (
                              <span
                                className="block text-[11px]"
                                style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--w-muted)' }}
                              >
                                {p.sku}
                              </span>
                            )}
                          </span>
                        </span>
                      </Td>
                      <Td style={{ color: 'var(--w-muted)' }}>{p.vendor || '—'}</Td>
                      <Td align="right">{p.price != null ? money(p.price, p.currency ?? 'EUR') : '—'}</Td>
                      <Td align="right" style={{ color: (p.inventory_quantity ?? 0) <= 0 ? '#EF4444' : undefined }}>
                        {p.inventory_quantity ?? '—'}
                      </Td>
                      <Td>
                        <Pill
                          tone={
                            p.catalog_sync_status === 'synced'
                              ? 'green'
                              : p.catalog_sync_status === 'failed'
                                ? 'red'
                                : 'gray'
                          }
                        >
                          {p.catalog_sync_status}
                        </Pill>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <div data-r="grid" className="mb-4 grid gap-3.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
            {/* chat carts */}
            <Card padding={0}>
              <div className="px-5 pb-1 pt-5">
                <CardTitle title="Cart-in-chat sessions" sub="Carts an agent built inside a conversation" />
              </div>
              {data.carts.length === 0 ? (
                <div className="px-5 pb-5 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                  No chat carts yet. Build one from a conversation to send a checkout link.
                </div>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Customer</Th>
                      <Th align="right">Value</Th>
                      <Th>Status</Th>
                      <Th align="right">Updated</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.carts.map((c: any) => (
                      <tr key={c.id}>
                        <Td>{c.contacts?.name || formatPhone(c.contacts?.phone)}</Td>
                        <Td align="right">{money(c.total_value, c.currency)}</Td>
                        <Td>
                          <Pill tone={c.status === 'paid' ? 'green' : c.status === 'open' ? 'blue' : 'gray'}>
                            {c.status.replace('_', ' ')}
                          </Pill>
                        </Td>
                        <Td align="right" style={{ color: 'var(--w-muted)', fontSize: 12 }}>
                          {relTime(c.updated_at)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            {/* orders */}
            <Card padding={0}>
              <div className="px-5 pb-1 pt-5">
                <CardTitle title="Recent orders" sub="Mirrored from Shopify" />
              </div>
              {data.orders.length === 0 ? (
                <div className="px-5 pb-5 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                  No orders mirrored yet.
                </div>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Order</Th>
                      <Th>Customer</Th>
                      <Th align="right">Total</Th>
                      <Th>Payment</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orders.map((o: any) => (
                      <tr key={o.id}>
                        <Td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                          {o.order_number || o.id.slice(0, 8)}
                        </Td>
                        <Td className="truncate">{o.customer_name || '—'}</Td>
                        <Td align="right">{money(o.total_price, o.currency)}</Td>
                        <Td>
                          <Pill tone={o.financial_status === 'paid' ? 'green' : o.is_cod ? 'amber' : 'gray'}>
                            {o.is_cod ? 'COD' : o.financial_status || 'pending'}
                          </Pill>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>

          {/* discounts */}
          <Card padding={0}>
            <div className="px-5 pb-1 pt-5">
              <CardTitle
                title="Discount codes"
                sub="Single-use codes minted per customer for cart recovery and campaigns"
                right={
                  <Button size="sm" variant="primary" onClick={() => setDiscountModal({})}>
                    <IconPlus size={12} /> Discount
                  </Button>
                }
              />
            </div>

            {missingScope && (
              <div
                className="mx-5 mb-3 rounded-lg px-3 py-2 text-[12.5px]"
                style={{ background: 'var(--w-ambertint)', color: '#92400E' }}
              >
                The <b>write_discounts</b> scope was not granted, so codes cannot be created. Reconnect the store
                to approve it — widening scopes always needs the merchant to re-consent.{' '}
                <a href="/integrations">Reconnect →</a>
              </div>
            )}

            {data.discounts.length === 0 ? (
              <EmptyState
                title="No discounts defined"
                body="Define a discount once (e.g. 10% off, expires in 7 days, minimum €30). Cart recovery reminders then mint a unique single-use code per customer."
                action={
                  <Button variant="primary" onClick={() => setDiscountModal({})}>
                    Create a discount
                  </Button>
                }
              />
            ) : (
              <Table minWidth={640}>
                <thead>
                  <tr>
                    <Th>Label</Th>
                    <Th>Value</Th>
                    <Th align="right">Expires</Th>
                    <Th align="right">Min order</Th>
                    <Th>Status</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {data.discounts.map((d: any) => (
                    <tr key={d.id}>
                      <Td className="font-medium">{d.label}</Td>
                      <Td>
                        {d.discount_type === 'fixed_amount' ? money(d.amount, d.currency) : `${d.percentage}%`}
                      </Td>
                      <Td align="right">{d.expiry_days} days</Td>
                      <Td align="right">{d.min_order_amount ? money(d.min_order_amount) : '—'}</Td>
                      <Td>
                        <Pill tone={d.enabled ? 'green' : 'gray'}>{d.enabled ? 'Enabled' : 'Off'}</Pill>
                      </Td>
                      <Td align="right">
                        <span className="flex justify-end gap-1">
                          <Button size="sm" onClick={() => generateCode(d.id)} disabled={!connected}>
                            Test code
                          </Button>
                          <Button size="sm" onClick={() => setDiscountModal(d)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => removeDiscount(d.id)}>
                            <IconTrash size={13} />
                          </Button>
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}

            {data.codes.length > 0 && (
              <>
                <div
                  className="px-5 pb-1.5 pt-4 text-[11px] font-bold uppercase tracking-[.05em]"
                  style={{ color: 'var(--w-muted)' }}
                >
                  Generated codes
                </div>
                <Table minWidth={520}>
                  <thead>
                    <tr>
                      <Th>Code</Th>
                      <Th>Customer</Th>
                      <Th>Status</Th>
                      <Th align="right">Created</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.codes.map((c: any) => (
                      <tr key={c.id}>
                        <Td style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{c.code}</Td>
                        <Td>{c.contacts?.name || formatPhone(c.contacts?.phone) || '—'}</Td>
                        <Td>
                          <Pill tone={c.status === 'used' ? 'green' : c.status === 'active' ? 'blue' : 'gray'}>
                            {c.status}
                          </Pill>
                        </Td>
                        <Td align="right" style={{ color: 'var(--w-muted)', fontSize: 12 }}>
                          {relTime(c.created_at)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            )}
          </Card>
        </>
      )}

      {discountModal && (
        <DiscountModal
          discount={discountModal}
          onClose={() => setDiscountModal(null)}
          onSaved={() => {
            setDiscountModal(null)
            load()
            toast('Discount saved')
          }}
        />
      )}
    </Page>
  )
}

function DiscountModal({
  discount,
  onClose,
  onSaved,
}: {
  discount: any
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    id: discount.id,
    label: discount.label ?? '',
    discount_type: discount.discount_type ?? 'percentage',
    percentage: discount.percentage ?? 10,
    amount: discount.amount ?? 10,
    expiry_days: discount.expiry_days ?? 7,
    min_order_amount: discount.min_order_amount ?? '',
    enabled: discount.enabled ?? true,
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/discounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error)
        return
      }
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={discount.id ? 'Edit discount' : 'New discount'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!form.label.trim()}>
            Save discount
          </Button>
        </>
      }
    >
      <Input
        label="Label"
        value={form.label}
        onChange={(e) => setForm({ ...form, label: e.target.value })}
        placeholder="Cart recovery 10%"
        className="mb-3"
      />

      <div className="mb-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Select
          label="Type"
          value={form.discount_type}
          onChange={(e) => setForm({ ...form, discount_type: e.target.value })}
        >
          <option value="percentage">Percentage off</option>
          <option value="fixed_amount">Fixed amount off</option>
        </Select>

        {form.discount_type === 'percentage' ? (
          <Input
            label="Percentage"
            type="number"
            value={String(form.percentage)}
            onChange={(e) => setForm({ ...form, percentage: Number(e.target.value) })}
          />
        ) : (
          <Input
            label="Amount (€)"
            type="number"
            value={String(form.amount)}
            onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
          />
        )}
      </div>

      <div className="mb-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Input
          label="Expires after (days)"
          type="number"
          value={String(form.expiry_days)}
          onChange={(e) => setForm({ ...form, expiry_days: Number(e.target.value) })}
        />
        <Input
          label="Minimum order (optional)"
          type="number"
          value={String(form.min_order_amount)}
          onChange={(e) => setForm({ ...form, min_order_amount: e.target.value })}
        />
      </div>

      <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Enabled" />

      <div className="mt-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--w-muted)' }}>
        Codes are minted in Shopify with a usage limit of 1 and applied once per customer. A customer who
        receives several cart reminders gets the same code each time.
      </div>

      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}
