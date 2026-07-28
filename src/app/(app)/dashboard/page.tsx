'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Button, Card, CardTitle, EmptyState, ErrorState, Page, PageHeader, Pill,
  Skeleton, Table, Td, Th, money, num, relTime,
} from '@/components/ui'
import { BarRow, Legend, LineChart, type Series } from '@/components/charts'
import { avatarColors, initialsOf } from '@/lib/phone'

const SERIES: Series[] = [
  { key: 'sent', label: 'Sent', color: '#16A34A', width: 2.5 },
  { key: 'delivered', label: 'Delivered', color: '#22C55E', width: 2, opacity: 0.8 },
  { key: 'read', label: 'Read', color: '#2563EB', width: 2, opacity: 0.85 },
  { key: 'failed', label: 'Failed', color: '#EF4444', width: 1.6 },
]

const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
]

const CATEGORY_COLOR: Record<string, string> = {
  marketing: '#16A34A',
  utility: '#2563EB',
  authentication: '#F59E0B',
  service: '#6B7280',
}

const ACTIVITY_TONE: Record<string, string> = {
  message: '#22C55E',
  order: '#16A34A',
  broadcast: '#2563EB',
  flow: '#2563EB',
  cod: '#16A34A',
  recovery: '#22C55E',
  template: '#2563EB',
  system: '#F59E0B',
}

type Data = Awaited<ReturnType<typeof fetchDashboard>>

async function fetchDashboard(days: number) {
  const res = await fetch(`/api/dashboard?days=${days}`, { cache: 'no-store' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`)
  return res.json()
}

function duration(seconds: number) {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function delta(current: number, previous: number, unit: 'pp' | '%' | 'abs' = '%') {
  if (previous === 0 && current === 0) return { text: '—', color: 'var(--w-muted)' }
  const diff = current - previous
  const good = diff >= 0
  const color = diff === 0 ? 'var(--w-muted)' : good ? '#16A34A' : '#EF4444'
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
  const abs = Math.abs(diff)

  if (unit === 'pp') return { text: `${sign}${abs.toFixed(1)}pp`, color }
  if (unit === 'abs') return { text: `${sign}${num(Math.round(abs))}`, color }
  const rel = previous === 0 ? 100 : (abs / Math.abs(previous)) * 100
  return { text: `${sign}${rel.toFixed(1)}%`, color }
}

export default function DashboardPage() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [rangeOpen, setRangeOpen] = useState(false)

  const load = useCallback(() => {
    setError('')
    fetchDashboard(days)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [days])

  useEffect(() => {
    load()
  }, [load])

  const rangeLabel = RANGES.find((r) => r.days === days)?.label ?? `Last ${days} days`
  const k = data?.kpis

  const kpis = k
    ? [
        { label: 'Total Revenue Attributed', value: money(k.totalRevenue), d: { text: '—', color: 'var(--w-muted)' } },
        { label: 'Recovered Cart Revenue', value: money(k.recoveredRevenue), d: { text: '—', color: 'var(--w-muted)' } },
        { label: 'Messages Sent', value: num(k.messagesSent), d: delta(k.messagesSent, k.prevMessagesSent) },
        { label: 'Delivery Rate', value: `${k.deliveryRate.toFixed(1)}%`, d: delta(k.deliveryRate, k.prevDeliveryRate, 'pp') },
        { label: 'Read Rate', value: `${k.readRate.toFixed(1)}%`, d: delta(k.readRate, k.prevReadRate, 'pp') },
        { label: 'Reply Rate', value: `${k.replyRate.toFixed(1)}%`, d: { text: '—', color: 'var(--w-muted)' } },
        { label: 'COD Confirmation Rate', value: `${k.codRate.toFixed(1)}%`, d: delta(k.codRate, k.prevCodRate, 'pp') },
        { label: 'Active Conversations', value: num(k.activeConversations), d: { text: '—', color: 'var(--w-muted)' } },
        { label: 'Avg First Response', value: duration(k.avgFirstResponse), d: { text: '—', color: 'var(--w-muted)' } },
      ]
    : []

  const attributionTotal = (data?.attribution ?? []).reduce((s: number, a: any) => s + a.value, 0)

  const xLabels = data?.volume?.length
    ? [0, 0.25, 0.5, 0.75, 1].map((f) => {
        const i = Math.min(data.volume.length - 1, Math.round(f * (data.volume.length - 1)))
        return new Date(data.volume[i].day).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
      })
    : []

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        subtitle={
          data
            ? `${rangeLabel} · ${new Date(data.range.from).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} – ${new Date(data.range.to).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}`
            : rangeLabel
        }
        actions={
          <>
            <div data-popover className="relative">
              <Button onClick={() => setRangeOpen((v) => !v)}>{rangeLabel} ▾</Button>
              {rangeOpen && (
                <div
                  className="absolute right-0 top-[38px] z-50 w-[170px] rounded-xl border p-1.5"
                  style={{
                    background: 'var(--w-card)',
                    borderColor: 'var(--w-border)',
                    boxShadow: '0 8px 24px rgba(16,24,40,.12)',
                  }}
                >
                  {RANGES.map((r) => (
                    <button
                      key={r.days}
                      onClick={() => {
                        setDays(r.days)
                        setRangeOpen(false)
                        setData(null)
                      }}
                      className="w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-[13px]"
                      style={{
                        background: r.days === days ? 'var(--w-greentint)' : 'transparent',
                        color: r.days === days ? '#15803D' : 'var(--w-text)',
                        fontWeight: r.days === days ? 600 : 500,
                      }}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button variant="primary" onClick={() => window.print()}>
              Export report
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      {/* KPI grid */}
      <div
        className="mb-5 grid gap-3.5"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}
      >
        {(data ? kpis : Array.from({ length: 9 })).map((kpi: any, i) => (
          <Card key={i} padding={0} style={{ padding: '16px 18px' }}>
            {data ? (
              <>
                <div className="truncate text-[12px] font-medium" style={{ color: 'var(--w-muted)' }}>
                  {kpi.label}
                </div>
                <div className="mt-[5px] text-[24px] font-bold tracking-[-0.02em]">{kpi.value}</div>
                <div className="mt-1 text-[11.5px] font-semibold" style={{ color: kpi.d.color }}>
                  {kpi.d.text}{' '}
                  <span className="font-normal" style={{ color: 'var(--w-muted)' }}>
                    vs prev.
                  </span>
                </div>
              </>
            ) : (
              <>
                <Skeleton h={12} w="60%" />
                <div className="mt-2">
                  <Skeleton h={22} w="45%" />
                </div>
                <div className="mt-2">
                  <Skeleton h={11} w="35%" />
                </div>
              </>
            )}
          </Card>
        ))}
      </div>

      {/* chart + right stack */}
      <div data-r="grid" className="mb-5 grid gap-3.5" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <Card>
          <CardTitle
            title="Message volume"
            sub={`Sent · Delivered · Read · Failed, ${days} days`}
            right={<Legend series={SERIES} />}
          />
          {data ? (
            <LineChart data={data.volume} series={SERIES} xLabels={xLabels} />
          ) : (
            <Skeleton h={190} />
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-3.5">
          <Card>
            <div className="mb-3 text-[14.5px] font-semibold">Revenue attribution</div>
            {data ? (
              <>
                {data.attribution.map((a: any) => (
                  <BarRow
                    key={a.label}
                    label={a.label}
                    value={money(a.value)}
                    pctWidth={attributionTotal ? (a.value / attributionTotal) * 100 : 0}
                    color={a.color}
                  />
                ))}
                <div
                  className="mt-3 pt-2.5 text-[11.5px]"
                  style={{ borderTop: '1px solid var(--w-border)', color: 'var(--w-muted)' }}
                >
                  Total attributed: <b style={{ color: 'var(--w-text)' }}>{money(attributionTotal)}</b> · 7-day
                  click window
                </div>
              </>
            ) : (
              <Skeleton h={110} />
            )}
          </Card>

          <Card>
            <div className="flex items-center justify-between">
              <div className="text-[14.5px] font-semibold">Number health</div>
              {data && (
                <Pill tone={data.numberHealth.quality === 'GREEN' ? 'green' : data.numberHealth.quality === 'YELLOW' ? 'amber' : data.numberHealth.connected ? 'red' : 'gray'}>
                  Quality: {data.numberHealth.quality ? qualityWord(data.numberHealth.quality) : 'N/A'}
                </Pill>
              )}
            </div>
            {data ? (
              data.numberHealth.connected ? (
                <>
                  <div className="mt-3 flex justify-between text-[12.5px]">
                    <span style={{ color: 'var(--w-muted)' }}>
                      Messaging tier — {tierLabel(data.numberHealth.tier)}
                    </span>
                    <span className="font-semibold">{num(data.numberHealth.used)} used</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full" style={{ background: 'var(--w-canvas)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (data.numberHealth.used / Math.max(1, tierCap(data.numberHealth.tier))) * 100)}%`,
                        background: '#16A34A',
                      }}
                    />
                  </div>
                  <div className="mt-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--w-muted)' }}>
                    Tiers move up automatically when you stay above 50% of your limit with High quality.
                  </div>
                </>
              ) : (
                <div className="mt-3 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                  WhatsApp is not connected yet.{' '}
                  <Link href="/integrations">Connect your number →</Link>
                </div>
              )
            ) : (
              <div className="mt-3">
                <Skeleton h={70} />
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* flows + activity */}
      <div data-r="grid" className="mb-5 grid gap-3.5" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <Card padding={0}>
          <div className="px-5 pb-1 pt-5">
            <CardTitle
              title="Top performing flows"
              right={
                <Link href="/flows" className="text-[12.5px] font-semibold">
                  View all flows
                </Link>
              }
            />
          </div>
          {!data ? (
            <div className="px-5 pb-5">
              <Skeleton h={140} />
            </div>
          ) : data.topFlows.length === 0 ? (
            <EmptyState
              title="No flows yet"
              body="Flows are automated WhatsApp journeys triggered by chat and Shopify events."
              action={
                <Link href="/flows">
                  <Button variant="primary">Create your first flow</Button>
                </Link>
              }
            />
          ) : (
            <Table minWidth={520}>
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
                {data.topFlows.map((f: any) => (
                  <tr key={f.id}>
                    <Td className="font-medium">{f.name}</Td>
                    <Td align="right">{num(f.entered)}</Td>
                    <Td align="right">{num(f.completed)}</Td>
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

        <Card>
          <div className="mb-3.5 flex items-center gap-2">
            <span className="w-pulse h-[7px] w-[7px] rounded-full" style={{ background: '#22C55E' }} />
            <div className="text-[14.5px] font-semibold">Live activity</div>
          </div>
          {!data ? (
            <Skeleton h={160} />
          ) : data.activity.length === 0 ? (
            <div className="py-8 text-center text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
              Activity will appear here as messages and orders come in.
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {data.activity.map((a: any) => {
                const c = avatarColors(a.title)
                return (
                  <div key={a.id} className="flex gap-2.5">
                    <span
                      className="flex h-[26px] w-[26px] min-w-[26px] items-center justify-center rounded-full text-[10.5px] font-bold"
                      style={{ background: c.bg, color: c.fg }}
                    >
                      {initialsOf(a.title)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] leading-snug">
                        {a.title}
                        {a.amount ? <b> ({money(a.amount)})</b> : null}
                      </span>
                      <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--w-muted)' }}>
                        {a.detail ? `${a.detail} · ` : ''}
                        {relTime(a.created_at)}
                      </span>
                    </span>
                    <span
                      className="mt-2 h-[7px] w-[7px] min-w-[7px] rounded-full"
                      style={{ background: ACTIVITY_TONE[a.kind] ?? '#6B7280' }}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Meta cost tracker */}
      <Card>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-[14.5px] font-semibold">Meta message cost tracker</div>
            <div className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
              Per-conversation spend by category and country
            </div>
          </div>
          <div className="whitespace-nowrap text-[13px]" style={{ color: 'var(--w-muted)' }}>
            Period total: <b className="text-[16px]" style={{ color: 'var(--w-text)' }}>{money(data?.cost.total ?? 0)}</b>
          </div>
        </div>

        <div data-r="grid4" className="mb-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {(data?.cost.byCategory ?? []).map((c: any) => (
            <div
              key={c.category}
              className="rounded-[10px] border"
              style={{ borderColor: 'var(--w-border)', background: 'var(--w-card2)', padding: '12px 14px' }}
            >
              <div className="flex items-center gap-1.5 text-[12px] capitalize" style={{ color: 'var(--w-muted)' }}>
                <span
                  className="inline-block h-2 w-2 rounded-[2px]"
                  style={{ background: CATEGORY_COLOR[c.category] }}
                />
                {c.category}
              </div>
              <div className="mt-1 text-[18px] font-bold">{money(c.cost)}</div>
              <div className="text-[11px]" style={{ color: 'var(--w-muted)' }}>
                {num(c.conversations)} conversations
              </div>
            </div>
          ))}
        </div>

        {data && data.cost.countries.length === 0 ? (
          <div className="py-6 text-center text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
            No billable conversations recorded yet. Costs appear once Meta reports pricing on your sends.
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Country</Th>
                <Th align="right">Marketing</Th>
                <Th align="right">Utility</Th>
                <Th align="right">Auth</Th>
                <Th align="right">Service</Th>
                <Th align="right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {(data?.cost.countries ?? []).map((c: any) => (
                <tr key={c.country}>
                  <Td className="font-medium">{c.country}</Td>
                  <Td align="right">{money(c.marketing)}</Td>
                  <Td align="right">{money(c.utility)}</Td>
                  <Td align="right">{money(c.authentication)}</Td>
                  <Td align="right">{money(c.service)}</Td>
                  <Td align="right" className="font-bold">
                    {money(c.total)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  )
}

function qualityWord(q: string) {
  return q === 'GREEN' ? 'HIGH' : q === 'YELLOW' ? 'MEDIUM' : q === 'RED' ? 'LOW' : q
}

function tierLabel(t: string | null) {
  if (!t) return 'unknown'
  const map: Record<string, string> = {
    TIER_50: '50 / 24h',
    TIER_250: '250 / 24h',
    TIER_1K: '1,000 / 24h',
    TIER_10K: '10,000 / 24h',
    TIER_100K: '100,000 / 24h',
    TIER_UNLIMITED: 'Unlimited',
  }
  return map[t] ?? t
}

function tierCap(t: string | null) {
  const map: Record<string, number> = {
    TIER_50: 50,
    TIER_250: 250,
    TIER_1K: 1000,
    TIER_10K: 10000,
    TIER_100K: 100000,
    TIER_UNLIMITED: 1000000,
  }
  return t ? (map[t] ?? 1000) : 1000
}
