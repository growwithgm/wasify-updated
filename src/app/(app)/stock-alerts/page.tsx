'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Button, Card, EmptyState, ErrorState, Page, PageHeader, Pill,
  Table, TableSkeleton, Td, Th, ToastProvider, num, relTime,
} from '@/components/ui'
import { formatPhone } from '@/lib/phone'
import { variantLabel } from '@/lib/flow/stock-alerts'

export default function StockAlertsPage() {
  return (
    <ToastProvider>
      <StockAlertsScreen />
    </ToastProvider>
  )
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Waiting' },
  { key: 'sent', label: 'Notified' },
  { key: 'failed', label: 'Failed' },
] as const

function statusPill(status: string): { text: string; tone: 'green' | 'amber' | 'red' | 'gray' } {
  switch (status) {
    case 'sent':
      return { text: 'Notified', tone: 'green' }
    case 'failed':
      return { text: 'Failed', tone: 'red' }
    default:
      return { text: 'Waiting for restock', tone: 'amber' }
  }
}

function StockAlertsScreen() {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<string>('all')
  const [page, setPage] = useState(0)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`/api/stock-alerts?filter=${filter}&page=${page}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setData(json)
    } catch (e: any) {
      setError(e.message)
      setData(null)
    }
  }, [filter, page])

  useEffect(() => {
    load()
  }, [load])

  const alerts: any[] = data?.alerts ?? []
  const counts = data?.counts ?? { pending: 0, sent: 0, failed: 0 }
  const pages = Math.ceil((data?.total ?? 0) / 50)

  return (
    <Page>
      <PageHeader
        title="Stock alerts"
        subtitle={
          data
            ? `${num(counts.pending)} waiting · ${num(counts.sent)} notified · ${num(counts.failed)} failed`
            : 'Back-in-stock requests from the store'
        }
      />

      <Card padding={12} className="mb-3.5">
        <div className="flex flex-wrap items-center gap-1.5" data-r="wrap">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setFilter(f.key)
                setPage(0)
              }}
              className="cursor-pointer rounded-full border px-3 py-[5px] text-[12.5px] font-medium"
              style={{
                background: filter === f.key ? 'var(--w-green)' : 'var(--w-card)',
                color: filter === f.key ? '#fff' : 'var(--w-muted)',
                borderColor: filter === f.key ? 'var(--w-green)' : 'var(--w-border)',
              }}
            >
              {f.label}
            </button>
          ))}
          <span className="ml-auto text-[12px]" style={{ color: 'var(--w-muted)' }}>
            Sending is controlled in Integrations → Back in stock
          </span>
        </div>
      </Card>

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      <Card padding={0}>
        {!data ? (
          <TableSkeleton rows={8} cols={5} />
        ) : alerts.length === 0 ? (
          <EmptyState
            title="No requests yet"
            body="When a customer taps “Notify me” on a sold-out product, their request appears here. They are messaged automatically when Shopify Flow reports the restock."
          />
        ) : (
          <div data-r="scroll">
            <Table minWidth={860}>
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Wants</Th>
                  <Th>Status</Th>
                  <Th>Requested</Th>
                  <Th>Notified</Th>
                  <Th>Opened link</Th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => {
                  const pill = statusPill(a.status)
                  return (
                    <tr key={a.id}>
                      <Td>
                        <span className="block text-[13px] font-medium">{a.name || 'Unnamed'}</span>
                        <span
                          className="block text-[11.5px]"
                          style={{ color: 'var(--w-muted)', fontFamily: "'JetBrains Mono', monospace" }}
                        >
                          {formatPhone(a.phone)}
                        </span>
                        {a.email && (
                          <span className="block text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                            {a.email}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <a
                          href={a.product_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[12.5px] font-medium"
                        >
                          {variantLabel(a.product_title, a.variant_title)}
                        </a>
                      </Td>
                      <Td>
                        <Pill tone={pill.tone}>{pill.text}</Pill>
                      </Td>
                      <Td style={{ color: 'var(--w-muted)' }}>{relTime(a.created_at)}</Td>
                      <Td style={{ color: 'var(--w-muted)' }}>{a.notified_at ? relTime(a.notified_at) : '—'}</Td>
                      <Td>{a.clicked_at ? <Pill tone="green">✓ clicked</Pill> : '—'}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
            Page {page + 1} of {pages}
          </span>
          <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </Page>
  )
}
