'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, ErrorState, Input, Page, PageHeader, Select } from '@/components/ui'
import { SYSTEM_LABELS } from '@/lib/engines/timeline'

/**
 * Timeline — every automated send, one table: who, when, which system,
 * which template, and what happened to it. Built from messages +
 * broadcast_recipients; 3 days is only the default window.
 */

const SYSTEM_STYLE: Record<string, { bg: string; fg: string }> = {
  popup: { bg: '#DCFCE7', fg: '#15803D' },
  recovery: { bg: '#FEF3C7', fg: '#92400E' },
  cod: { bg: '#DBEAFE', fg: '#1D4ED8' },
  back_in_stock: { bg: '#EDE9FE', fg: '#6D28D9' },
  broadcast: { bg: '#FCE7F3', fg: '#BE185D' },
  flow: { bg: '#E5E7EB', fg: '#374151' },
}

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  sent: { bg: '#DBEAFE', fg: '#1D4ED8' },
  delivered: { bg: '#DCFCE7', fg: '#15803D' },
  read: { bg: '#CCFBF1', fg: '#0F766E' },
  replied: { bg: '#CCFBF1', fg: '#0F766E' },
  failed: { bg: '#FEE2E2', fg: '#B91C1C' },
  skipped: { bg: '#E5E7EB', fg: '#4B5563' },
  pending: { bg: '#FEF3C7', fg: '#92400E' },
}

function Badge({ text, style }: { text: string; style?: { bg: string; fg: string } }) {
  return (
    <span
      className="inline-block rounded-full px-2 py-[2px] text-[11px] font-semibold"
      style={{ background: style?.bg ?? '#E5E7EB', color: style?.fg ?? '#374151' }}
    >
      {text}
    </span>
  )
}

function dateInput(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86400_000)
  return d.toISOString().slice(0, 10)
}

export default function TimelinePage() {
  const [rows, setRows] = useState<any[]>([])
  const [contact, setContact] = useState<any>(null)
  const [shopifyPush, setShopifyPush] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [q, setQ] = useState('')
  const [system, setSystem] = useState('')
  const [status, setStatus] = useState('')
  const [fromDate, setFromDate] = useState(dateInput(3))
  const [toDate, setToDate] = useState(dateInput(0))
  const [contactId, setContactId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      params.set('from', new Date(`${fromDate}T00:00:00`).toISOString())
      params.set('to', new Date(`${toDate}T23:59:59.999`).toISOString())
      if (q.trim()) params.set('q', q.trim())
      if (system) params.set('system', system)
      if (status) params.set('status', status)
      if (contactId) params.set('contact_id', contactId)
      const res = await fetch(`/api/timeline?${params}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setRows(json.rows ?? [])
      setContact(json.contact ?? null)
      setShopifyPush(json.shopify_push ?? null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [q, system, status, fromDate, toDate, contactId])

  // Debounced: typing a number shouldn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, 350)
    return () => clearTimeout(t)
  }, [load])

  const pushBadge = (() => {
    if (!shopifyPush) return null
    if (shopifyPush.status === 'direct') return <Badge text="Shopify: pushed ✓" style={STATUS_STYLE.delivered} />
    if (shopifyPush.status === 'done') return <Badge text="Shopify: pushed after retry ✓" style={STATUS_STYLE.delivered} />
    if (shopifyPush.status === 'pending') return <Badge text="Shopify: queued — retries every 15 min" style={STATUS_STYLE.pending} />
    return <Badge text="Shopify: push FAILED" style={STATUS_STYLE.failed} />
  })()

  return (
    <Page>
      <PageHeader
        title="Timeline"
        subtitle="Every automated send — which system, which template, and what happened to it"
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      {/* Contact drill-down header */}
      {contactId && contact && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <div className="text-[14px] font-bold">{contact.name || 'No name'}</div>
              <div className="text-[12.5px]" style={{ color: 'var(--w-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                {contact.phone}
              </div>
            </div>
            <Badge
              text={contact.opt_in_status === 'opted_in' ? `Opted in (${contact.opt_in_source ?? '—'})` : contact.opt_in_status ?? 'unknown'}
              style={contact.opt_in_status === 'opted_in' ? STATUS_STYLE.delivered : STATUS_STYLE.skipped}
            />
            {pushBadge}
            {shopifyPush?.status === 'failed' && shopifyPush.error && (
              <span className="text-[12px]" style={{ color: '#B91C1C' }}>{shopifyPush.error}</span>
            )}
            <div className="ml-auto">
              <Button variant="ghost" onClick={() => setContactId('')}>
                ← Show everyone
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Filters */}
      <Card className="mb-4">
        <div className="grid gap-3" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr' }}>
          <Input
            label="Search customer"
            placeholder="Number or name…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setContactId('') }}
          />
          <Select label="System" value={system} onChange={(e) => setSystem(e.target.value)}>
            <option value="">All systems</option>
            {Object.entries(SYSTEM_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </Select>
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['sent', 'delivered', 'read', 'replied', 'failed', 'skipped', 'pending'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
          <Input label="From" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <Input label="To" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
      </Card>

      {/* Rows */}
      <Card>
        {loading && rows.length === 0 ? (
          <div className="py-8 text-center text-[13px]" style={{ color: 'var(--w-muted)' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-[13px]" style={{ color: 'var(--w-muted)' }}>
            No sends in this range — widen the dates or clear the filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead>
                <tr style={{ color: 'var(--w-muted)' }}>
                  <th className="py-2 pr-3 font-semibold">Time</th>
                  <th className="py-2 pr-3 font-semibold">Customer</th>
                  <th className="py-2 pr-3 font-semibold">System</th>
                  <th className="py-2 pr-3 font-semibold">Template</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t align-top" style={{ borderColor: 'var(--w-border)' }}>
                    <td className="whitespace-nowrap py-2.5 pr-3" style={{ color: 'var(--w-muted)' }}>
                      {new Date(r.at).toLocaleString(undefined, {
                        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                      })}
                    </td>
                    <td className="py-2.5 pr-3">
                      {r.contact_id ? (
                        <button
                          className="text-left"
                          onClick={() => { setContactId(r.contact_id); setQ('') }}
                          title="Show only this customer's timeline"
                        >
                          <span className="font-semibold underline decoration-dotted underline-offset-2">
                            {r.name || 'No name'}
                          </span>
                          <span className="block text-[11.5px]" style={{ color: 'var(--w-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                            {r.phone}
                          </span>
                        </button>
                      ) : (
                        <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{r.phone ?? '—'}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3">
                      <Badge
                        text={`${SYSTEM_LABELS[r.system as keyof typeof SYSTEM_LABELS] ?? r.system}${r.detail ? ` · ${r.detail}` : ''}`}
                        style={SYSTEM_STYLE[r.system]}
                      />
                    </td>
                    <td className="py-2.5 pr-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                      {r.template ?? '—'}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge text={r.status ?? '—'} style={STATUS_STYLE[r.status]} />
                      {r.error && (
                        <div className="mt-1 max-w-[320px] text-[11.5px] leading-snug" style={{ color: '#B91C1C' }}>
                          {r.error}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length >= 300 && (
              <div className="mt-2 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                Showing the latest {rows.length} rows — narrow the dates or filters to see the rest.
              </div>
            )}
          </div>
        )}
      </Card>
    </Page>
  )
}
