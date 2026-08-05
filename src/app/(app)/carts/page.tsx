'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Button, Card, EmptyState, ErrorState, Page, PageHeader, Pill,
  Table, TableSkeleton, Td, Th, ToastProvider, money, num, relTime,
} from '@/components/ui'
import { formatPhone } from '@/lib/phone'

export default function CartsPage() {
  return (
    <ToastProvider>
      <CartsScreen />
    </ToastProvider>
  )
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Still open' },
  { key: 'recovered', label: 'Recovered' },
] as const

/**
 * Describe what recovery has done for one cart.
 *
 * Deliberately says nothing about whether the customer paid — that is the
 * checkout's own `recovered`/`completed_at`, rendered separately. A tracking
 * row reaching 'done' means three reminders were sent, not that it worked.
 */
export function recoveryLabel(recovery: any, hasPhone: boolean): { text: string; tone: 'green' | 'amber' | 'red' | 'gray' } {
  if (!recovery) {
    return hasPhone
      ? { text: 'No recovery yet', tone: 'gray' }
      : { text: 'WhatsApp number missing', tone: 'amber' }
  }

  switch (recovery.status) {
    case 'skipped_no_phone':
      return { text: 'WhatsApp number missing', tone: 'amber' }
    case 'suppressed_cooldown':
      return { text: 'Suppressed (cooldown)', tone: 'gray' }
    case 'opted_out':
      return { text: 'Opted out', tone: 'red' }
    case 'completed_order':
      return { text: 'Stopped — order placed', tone: 'green' }
    default:
      if (recovery.remindersSent > 0) {
        return { text: `Reminder ${recovery.remindersSent} sent`, tone: 'green' }
      }
      return { text: 'Recovery scheduled', tone: 'gray' }
  }
}

function CartsScreen() {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<string>('all')
  const [page, setPage] = useState(0)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`/api/carts?filter=${filter}&page=${page}`, { cache: 'no-store' })
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

  const carts: any[] = data?.carts ?? []
  const pages = Math.ceil((data?.total ?? 0) / 50)

  return (
    <Page>
      <PageHeader
        title="Abandoned carts"
        subtitle={data ? `${num(data.total)} checkout(s) mirrored from Shopify` : 'Loading…'}
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
        </div>
      </Card>

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      <Card padding={0}>
        {!data ? (
          <TableSkeleton rows={8} cols={6} />
        ) : carts.length === 0 ? (
          <EmptyState
            title="No abandoned carts"
            body="A cart appears here within seconds of a customer reaching checkout and leaving. Connect Shopify and make sure the checkouts/create webhook is registered."
          />
        ) : (
          <div data-r="scroll">
            <Table minWidth={900}>
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Cart</Th>
                  <Th align="right">Value</Th>
                  <Th>Status</Th>
                  <Th>Recovery</Th>
                  <Th>Abandoned</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {carts.map((c) => {
                  const label = recoveryLabel(c.recovery, !!c.customer_phone)
                  return (
                    <tr key={c.id}>
                      <Td>
                        <span className="block text-[13px] font-medium">{c.customer_name || 'Unnamed'}</span>
                        <span
                          className="block text-[11.5px]"
                          style={{ color: 'var(--w-muted)', fontFamily: "'JetBrains Mono', monospace" }}
                        >
                          {c.customer_phone ? formatPhone(c.customer_phone) : c.customer_email || 'no contact'}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-[12.5px]">{c.items_count ?? 0} item(s)</span>
                        <span className="block text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                          {(c.line_items ?? [])
                            .slice(0, 2)
                            .map((l: any) => l.title)
                            .join(', ')}
                        </span>
                      </Td>
                      <Td align="right">{money(c.total_price, c.currency)}</Td>
                      <Td>
                        {/* Keyed strictly off the checkout — see the API note. */}
                        <Pill tone={c.isRecovered ? 'green' : 'amber'}>{c.isRecovered ? 'Recovered' : 'Open'}</Pill>
                      </Td>
                      <Td>
                        <Pill tone={label.tone}>{label.text}</Pill>
                        {c.recovery?.discountCode && (
                          <span className="ml-1 text-[11px]" style={{ color: 'var(--w-muted)' }}>
                            {c.recovery.discountCode}
                          </span>
                        )}
                        {c.recovery?.lastError && (
                          <span className="mt-0.5 block text-[11px]" style={{ color: '#B91C1C' }}>
                            {c.recovery.lastError}
                          </span>
                        )}
                      </Td>
                      <Td style={{ color: 'var(--w-muted)' }}>{relTime(c.abandoned_at ?? c.created_at)}</Td>
                      <Td>
                        <span className="flex gap-2">
                          {c.recovery?.conversationId && (
                            <Link href="/inbox" className="text-[12px] font-medium">
                              Thread
                            </Link>
                          )}
                          {c.abandoned_checkout_url && (
                            <a
                              href={c.abandoned_checkout_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[12px] font-medium"
                            >
                              Cart link
                            </a>
                          )}
                        </span>
                      </Td>
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
