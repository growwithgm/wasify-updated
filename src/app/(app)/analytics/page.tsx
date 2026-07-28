'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Button, Card, CardTitle, ErrorState, Page, PageHeader, Pill, Skeleton,
  Table, Td, Th, money, num, pct,
} from '@/components/ui'
import { Funnel, heatColor } from '@/components/charts'

const RANGES = [7, 30, 90]
const TABS = ['Overview', 'Messaging', 'Revenue', 'Retention', 'Team'] as const

export default function AnalyticsPage() {
  const [days, setDays] = useState(30)
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview')
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setError('')
    setData(null)
    fetch(`/api/analytics?days=${days}`, { cache: 'no-store' })
      .then(async (r) => {
        const json = await r.json()
        if (!r.ok) throw new Error(json.error)
        return json
      })
      .then(setData)
      .catch((e) => setError(e.message))
  }, [days])

  useEffect(() => {
    load()
  }, [load])

  function exportCsv() {
    if (!data) return
    const lines = [
      'metric,value',
      `messages_sent,${data.kpis.sent}`,
      `delivered,${data.kpis.delivered}`,
      `read,${data.kpis.read}`,
      `replied_conversations,${data.kpis.repliedConvs}`,
      `attributed_revenue,${data.kpis.attributedRevenue}`,
      `attributed_orders,${data.kpis.attributedOrders}`,
      `cod_confirmation_rate,${data.kpis.codRate.toFixed(2)}`,
      `recovered_revenue,${data.kpis.recoveredRevenue}`,
      `cart_recovery_rate,${data.kpis.recoveryRate.toFixed(2)}`,
      `meta_cost,${data.kpis.totalCost}`,
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `wasify-analytics-${days}d.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const k = data?.kpis

  return (
    <Page>
      <PageHeader
        title="Analytics"
        subtitle={`Last ${days} days · computed live from your messages and orders`}
        actions={
          <>
            <div className="flex overflow-hidden rounded-lg border" style={{ borderColor: 'var(--w-border)' }}>
              {RANGES.map((d) => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className="cursor-pointer border-0 px-3 py-[7px] text-[12.5px] font-medium"
                  style={{
                    background: days === d ? '#16A34A' : 'var(--w-card)',
                    color: days === d ? '#fff' : 'var(--w-muted)',
                  }}
                >
                  {d}d
                </button>
              ))}
            </div>
            <Button onClick={exportCsv} disabled={!data}>
              ↓ Export CSV
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="cursor-pointer rounded-full border px-3 py-1 text-[12.5px] font-medium"
            style={{
              background: tab === t ? '#16A34A' : 'var(--w-card)',
              color: tab === t ? '#fff' : 'var(--w-muted)',
              borderColor: tab === t ? '#16A34A' : 'var(--w-border)',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {!data ? (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} h={90} />
          ))}
        </div>
      ) : (
        <>
          {/* KPI strip is always visible */}
          <div
            className="mb-5 grid gap-3.5"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
          >
            {[
              ['Attributed revenue', money(k.attributedRevenue)],
              ['Attributed orders', num(k.attributedOrders)],
              ['Messages sent', num(k.sent)],
              ['Delivery rate', pct(k.delivered, k.sent)],
              ['COD confirm rate', `${k.codRate.toFixed(1)}%`],
              ['Recovered carts', money(k.recoveredRevenue)],
              ['Meta cost', money(k.totalCost)],
              ['ROI', k.roi ? `${k.roi.toFixed(1)}×` : '—'],
            ].map(([label, value]) => (
              <Card key={label} padding={0} style={{ padding: '16px 18px' }}>
                <div className="text-[12px] font-medium" style={{ color: 'var(--w-muted)' }}>
                  {label}
                </div>
                <div className="mt-1 text-[22px] font-bold tracking-[-0.02em]">{value}</div>
              </Card>
            ))}
          </div>

          {(tab === 'Overview' || tab === 'Messaging') && (
            <div data-r="grid" className="mb-5 grid gap-3.5" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
              <Card>
                <CardTitle title="Messaging → revenue funnel" sub="Every step over the selected window" />
                <Funnel steps={data.funnel} />
              </Card>

              <Card>
                <CardTitle title="Revenue per contact" sub="Messaged vs not messaged" />
                <div className="flex items-end gap-6 py-4">
                  <div>
                    <div className="text-[26px] font-bold" style={{ color: '#16A34A' }}>
                      {money(data.comparison.messagedRpc)}
                    </div>
                    <div className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
                      messaged ({num(data.comparison.messagedCount)})
                    </div>
                  </div>
                  <div>
                    <div className="text-[26px] font-bold" style={{ color: 'var(--w-muted)' }}>
                      {money(data.comparison.notMessagedRpc)}
                    </div>
                    <div className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
                      not messaged ({num(data.comparison.notMessagedCount)})
                    </div>
                  </div>
                </div>
                <div
                  className="rounded-lg px-3 py-2 text-[11.5px] leading-relaxed"
                  style={{ background: 'var(--w-ambertint)', color: '#92400E' }}
                >
                  This is an <b>observational</b> comparison, not a controlled experiment — you message engaged
                  customers more, so some of the gap is selection, not causation. A true holdout needs a control
                  group assigned before sending; that is not implemented yet.
                </div>
              </Card>
            </div>
          )}

          {(tab === 'Overview' || tab === 'Revenue') && (
            <>
              <Card padding={0} className="mb-5">
                <div className="px-5 pb-1 pt-5">
                  <CardTitle title="Revenue per flow" sub="Lifetime totals per automated journey" />
                </div>
                {data.flows.length === 0 ? (
                  <div className="px-5 pb-5 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                    No flows yet.
                  </div>
                ) : (
                  <Table minWidth={620}>
                    <thead>
                      <tr>
                        <Th>Flow</Th>
                        <Th align="right">Entered</Th>
                        <Th align="right">Completed</Th>
                        <Th align="right">Revenue</Th>
                        <Th align="right">Cost</Th>
                        <Th align="right">ROI</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.flows.map((f: any) => (
                        <tr key={f.id}>
                          <Td className="font-medium">{f.name}</Td>
                          <Td align="right">{num(f.entered_count)}</Td>
                          <Td align="right">{num(f.completed_count)}</Td>
                          <Td align="right">{f.revenue ? money(f.revenue) : '—'}</Td>
                          <Td align="right">{f.cost ? money(f.cost) : '—'}</Td>
                          <Td align="right" style={{ color: f.roi ? '#16A34A' : 'var(--w-muted)', fontWeight: 600 }}>
                            {f.roi ? `${f.roi.toFixed(1)}×` : '—'}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>

              <Card padding={0} className="mb-5">
                <div className="px-5 pb-1 pt-5">
                  <CardTitle title="Campaign performance" sub="Broadcasts in this window" />
                </div>
                {data.broadcasts.length === 0 ? (
                  <div className="px-5 pb-5 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                    No campaigns in this window.
                  </div>
                ) : (
                  <Table minWidth={700}>
                    <thead>
                      <tr>
                        <Th>Campaign</Th>
                        <Th align="right">Sent</Th>
                        <Th align="right">Delivered</Th>
                        <Th align="right">Read</Th>
                        <Th align="right">Replied</Th>
                        <Th align="right">Revenue</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.broadcasts.map((b: any) => (
                        <tr key={b.id}>
                          <Td className="font-medium">{b.name}</Td>
                          <Td align="right">{num(b.sent_count)}</Td>
                          <Td align="right">{pct(b.delivered_count, b.sent_count)}</Td>
                          <Td align="right">{pct(b.read_count, b.sent_count)}</Td>
                          <Td align="right">{pct(b.replied_count, b.sent_count)}</Td>
                          <Td align="right">{b.revenue ? money(b.revenue) : '—'}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </>
          )}

          {(tab === 'Overview' || tab === 'Retention') && (
            <Card className="mb-5">
              <CardTitle
                title="Cohort retention — repeat purchase rate"
                sub="First-order month → share of that cohort ordering again in month N"
              />
              {data.retention.length === 0 ? (
                <div className="text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                  Not enough order history yet.
                </div>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Cohort</Th>
                      <Th align="right">Size</Th>
                      {['M1', 'M2', 'M3', 'M4', 'M5', 'M6'].map((m) => (
                        <Th key={m} align="center">
                          {m}
                        </Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.retention.map((r: any) => (
                      <tr key={r.month}>
                        <Td className="font-medium">{r.month}</Td>
                        <Td align="right">{num(r.size)}</Td>
                        {r.rates.map((v: number, i: number) => (
                          <Td key={i} align="center" style={{ background: heatColor(v, 60), fontWeight: v > 0 ? 600 : 400 }}>
                            {v > 0 ? `${v.toFixed(0)}%` : '—'}
                          </Td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}

              <div className="mt-4 grid gap-3.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div>
                  <div className="mb-2 text-[12.5px] font-semibold">RFM distribution</div>
                  {data.rfm.map((r: any) => (
                    <div key={r.label} className="flex items-center justify-between py-1 text-[12.5px]">
                      <span className="capitalize">{r.label.replace(/_/g, ' ')}</span>
                      <span className="font-semibold">{num(r.count)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="mb-2 text-[12.5px] font-semibold">Marketing consent</div>
                  {data.optIn.map((r: any) => (
                    <div key={r.label} className="flex items-center justify-between py-1 text-[12.5px]">
                      <span className="capitalize">{r.label.replace(/_/g, ' ')}</span>
                      <span className="font-semibold">{num(r.count)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {tab === 'Team' && (
            <Card padding={0}>
              <div className="px-5 pb-1 pt-5">
                <CardTitle title="Per-agent workload" sub="Conversations assigned to each agent" />
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Agent</Th>
                    <Th align="right">Assigned</Th>
                    <Th align="right">Open</Th>
                    <Th align="right">Closed</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.agentStats.map((a: any) => (
                    <tr key={a.id}>
                      <Td className="font-medium">{a.name}</Td>
                      <Td align="right">{num(a.conversations)}</Td>
                      <Td align="right">{num(a.open)}</Td>
                      <Td align="right">{num(a.closed)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </>
      )}
    </Page>
  )
}
