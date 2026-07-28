'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, Card, CardTitle, EmptyState, ErrorState, Input, Modal, Page, PageHeader, Pill, Select,
  Table, TableSkeleton, Td, Th, ToastProvider, money, num, relTime, useToast,
} from '@/components/ui'
import { Funnel } from '@/components/charts'
import { IconPipelines, IconPlus, IconTrash } from '@/components/icons'
import { avatarColors, initialsOf } from '@/lib/phone'

export default function PipelinesPage() {
  return (
    <ToastProvider>
      <PipelinesScreen />
    </ToastProvider>
  )
}

function PipelinesScreen() {
  const toast = useToast()
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  const [view, setView] = useState<'board' | 'list'>('board')
  const [dealModal, setDealModal] = useState<any>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/pipelines', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setData(json)
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const stages = data?.stages ?? []
  const deals = data?.deals ?? []

  const metrics = useMemo(() => {
    const total = deals.reduce((s: number, d: any) => s + Number(d.value ?? 0), 0)
    const weighted = deals.reduce((s: number, d: any) => {
      const stage = stages.find((st: any) => st.id === d.stage_id)
      return s + Number(d.value ?? 0) * ((stage?.win_probability ?? 0) / 100)
    }, 0)

    const ages = deals.map(
      (d: any) => (Date.now() - new Date(d.stage_entered_at).getTime()) / 86400_000
    )
    const avgAge = ages.length ? ages.reduce((a: number, b: number) => a + b, 0) / ages.length : 0

    return { total, weighted, avgAge, count: deals.length }
  }, [deals, stages])

  async function move(dealId: string, stageId: string) {
    // Optimistic: the card should follow the cursor immediately.
    setData((d: any) => ({
      ...d,
      deals: d.deals.map((x: any) => (x.id === dealId ? { ...x, stage_id: stageId } : x)),
    }))

    const res = await fetch('/api/deals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: dealId, stage_id: stageId }),
    })

    if (!res.ok) {
      toast('Could not move the deal', 'red')
      load()
      return
    }

    const stage = stages.find((s: any) => s.id === stageId)
    if (stage?.is_won || stage?.is_lost) {
      toast(stage.is_won ? 'Deal marked won 🎉' : 'Deal marked lost')
      load()
    }
  }

  async function removeDeal(id: string) {
    if (!confirm('Delete this deal?')) return
    await fetch(`/api/deals?id=${id}`, { method: 'DELETE' })
    toast('Deal deleted')
    load()
  }

  return (
    <Page>
      <PageHeader
        title="Pipelines"
        subtitle="Wholesale & B2B deals · drag cards between stages"
        actions={
          <>
            <div className="flex overflow-hidden rounded-lg border" style={{ borderColor: 'var(--w-border)' }}>
              {(['board', 'list'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className="cursor-pointer border-0 px-3 py-[7px] text-[12.5px] font-medium capitalize"
                  style={{
                    background: view === v ? '#16A34A' : 'var(--w-card)',
                    color: view === v ? '#fff' : 'var(--w-muted)',
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
            <Button variant="primary" onClick={() => setDealModal({})}>
              <IconPlus size={14} /> New deal
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      {!data ? (
        <TableSkeleton rows={6} cols={5} />
      ) : stages.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconPipelines size={32} />}
            title="No pipeline yet"
            body="A default pipeline is created with your account. If you deleted it, create a new one to start tracking deals."
            action={
              <Button
                variant="primary"
                onClick={async () => {
                  await fetch('/api/pipelines', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Wholesale & B2B' }),
                  })
                  load()
                }}
              >
                Create a pipeline
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div
            className="mb-4 grid gap-3.5"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
          >
            {[
              ['Pipeline value', money(metrics.total)],
              ['Weighted forecast', money(metrics.weighted)],
              ['Open deals', num(metrics.count)],
              ['Avg stage age', `${metrics.avgAge.toFixed(1)} days`],
            ].map(([label, value]) => (
              <Card key={label} padding={0} style={{ padding: '16px 18px' }}>
                <div className="text-[12px] font-medium" style={{ color: 'var(--w-muted)' }}>
                  {label}
                </div>
                <div className="mt-1 text-[22px] font-bold tracking-[-0.02em]">{value}</div>
              </Card>
            ))}
          </div>

          {view === 'board' ? (
            <div data-r="scroll" className="flex gap-3 overflow-x-auto pb-3">
              {stages.map((stage: any) => {
                const cards = deals.filter((d: any) => d.stage_id === stage.id)
                const value = cards.reduce((s: number, d: any) => s + Number(d.value ?? 0), 0)

                return (
                  <div
                    key={stage.id}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setDragOver(stage.id)
                    }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={() => {
                      if (dragging) move(dragging, stage.id)
                      setDragging(null)
                      setDragOver(null)
                    }}
                    className={`flex min-w-[260px] max-w-[280px] flex-1 flex-col rounded-xl border p-2.5 ${
                      dragOver === stage.id ? 'w-drag-over' : ''
                    }`}
                    style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
                  >
                    <div className="mb-2 flex items-center justify-between px-1">
                      <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: stage.is_won ? '#16A34A' : stage.is_lost ? '#EF4444' : stage.color ?? '#6B7280' }}
                        />
                        {stage.name}
                      </span>
                      <span className="text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                        {cards.length} · {money(value)}
                      </span>
                    </div>

                    <div className="flex min-h-[60px] flex-col gap-2">
                      {cards.map((d: any) => {
                        const colors = avatarColors(d.contacts?.phone ?? d.id)
                        return (
                          <div
                            key={d.id}
                            draggable
                            onDragStart={() => setDragging(d.id)}
                            onDragEnd={() => setDragging(null)}
                            onClick={() => setDealModal(d)}
                            className={`cursor-grab rounded-[10px] border p-2.5 ${dragging === d.id ? 'w-dragging' : ''}`}
                            style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-[12.5px] font-semibold leading-snug">{d.title}</span>
                              <span className="whitespace-nowrap text-[12.5px] font-bold" style={{ color: '#2563EB' }}>
                                {money(d.value, d.currency)}
                              </span>
                            </div>

                            {d.contacts && (
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <span
                                  className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold"
                                  style={{ background: colors.bg, color: colors.fg }}
                                >
                                  {initialsOf(d.contacts.name, d.contacts.phone)}
                                </span>
                                <span className="truncate text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                                  {d.contacts.name || `+${d.contacts.phone}`}
                                </span>
                              </div>
                            )}

                            <div className="mt-1.5 flex items-center justify-between text-[10.5px]" style={{ color: 'var(--w-muted)' }}>
                              <span>{relTime(d.stage_entered_at)} in stage</span>
                              {d.next_action && <span className="truncate">→ {d.next_action}</span>}
                            </div>
                          </div>
                        )
                      })}

                      {cards.length === 0 && (
                        <div
                          className="rounded-lg border border-dashed py-4 text-center text-[11.5px]"
                          style={{ borderColor: 'var(--w-border)', color: 'var(--w-muted)' }}
                        >
                          Drop a deal here
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <Card padding={0}>
              {deals.length === 0 ? (
                <EmptyState title="No open deals" body="Create a deal, or add one from a conversation." />
              ) : (
                <Table minWidth={760}>
                  <thead>
                    <tr>
                      <Th>Deal</Th>
                      <Th>Contact</Th>
                      <Th>Stage</Th>
                      <Th align="right">Value</Th>
                      <Th>Owner</Th>
                      <Th align="right">Stage age</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {deals.map((d: any) => (
                      <tr key={d.id} className="cursor-pointer" onClick={() => setDealModal(d)}>
                        <Td className="font-medium">{d.title}</Td>
                        <Td>{d.contacts?.name || (d.contacts ? `+${d.contacts.phone}` : '—')}</Td>
                        <Td>
                          <Pill tone="blue">{stages.find((s: any) => s.id === d.stage_id)?.name ?? '—'}</Pill>
                        </Td>
                        <Td align="right" className="font-semibold">
                          {money(d.value, d.currency)}
                        </Td>
                        <Td>{data.agents.find((a: any) => a.id === d.owner_id)?.name ?? '—'}</Td>
                        <Td align="right" style={{ color: 'var(--w-muted)' }}>
                          {relTime(d.stage_entered_at)}
                        </Td>
                        <Td align="right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              removeDeal(d.id)
                            }}
                            className="cursor-pointer border-0 bg-transparent p-1"
                            style={{ color: 'var(--w-muted)' }}
                          >
                            <IconTrash size={13} />
                          </button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}

          {deals.length > 0 && (
            <Card className="mt-4">
              <CardTitle title="Conversion funnel" sub="Open deals by stage" />
              <Funnel
                steps={stages
                  .filter((s: any) => !s.is_lost)
                  .map((s: any) => ({
                    name: s.name,
                    n: deals.filter((d: any) => d.stage_id === s.id).length,
                  }))}
              />
            </Card>
          )}
        </>
      )}

      {dealModal && (
        <DealModal
          deal={dealModal}
          stages={stages}
          agents={data?.agents ?? []}
          onClose={() => setDealModal(null)}
          onSaved={() => {
            setDealModal(null)
            load()
            toast('Deal saved')
          }}
        />
      )}
    </Page>
  )
}

function DealModal({
  deal,
  stages,
  agents,
  onClose,
  onSaved,
}: {
  deal: any
  stages: any[]
  agents: any[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    id: deal.id,
    title: deal.title ?? '',
    value: deal.value ?? 0,
    stage_id: deal.stage_id ?? stages[0]?.id ?? '',
    owner_id: deal.owner_id ?? '',
    next_action: deal.next_action ?? '',
  })
  const [contacts, setContacts] = useState<any[]>([])
  const [contactId, setContactId] = useState(deal.contact_id ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/contacts?page=0')
      .then((r) => r.json())
      .then((j) => setContacts(j.contacts ?? []))
  }, [])

  async function save() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/deals', {
        method: deal.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, contact_id: contactId || null }),
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
      title={deal.id ? 'Edit deal' : 'New deal'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!form.title.trim()}>
            Save deal
          </Button>
        </>
      }
    >
      <Input
        label="Title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        placeholder="Wholesale enquiry — 40 units"
        className="mb-3"
      />

      <div className="mb-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Input
          label="Value (€)"
          type="number"
          value={String(form.value)}
          onChange={(e) => setForm({ ...form, value: Number(e.target.value) })}
        />
        <Select label="Stage" value={form.stage_id} onChange={(e) => setForm({ ...form, stage_id: e.target.value })}>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="mb-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Select label="Contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
          <option value="">No contact linked</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || `+${c.phone}`}
            </option>
          ))}
        </Select>
        <Select label="Owner" value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}>
          <option value="">Unassigned</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>

      <Input
        label="Next action"
        value={form.next_action}
        onChange={(e) => setForm({ ...form, next_action: e.target.value })}
        placeholder="Send the wholesale price list"
      />

      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}
