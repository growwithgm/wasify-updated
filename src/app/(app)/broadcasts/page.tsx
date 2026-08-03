'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, Card, CardTitle, EmptyState, ErrorState, Input, Modal, Page, PageHeader, Pill,
  Select, Table, TableSkeleton, Td, Th, ToastProvider, money, num, pct, dateTime, relTime, useToast,
} from '@/components/ui'
import { IconBroadcasts, IconPlus, IconTrash } from '@/components/icons'
import { formatPhone } from '@/lib/phone'
import type { Broadcast, MessageTemplate } from '@/lib/types'

const STATUS_TONE: Record<string, any> = {
  draft: 'gray',
  scheduled: 'blue',
  sending: 'amber',
  sent: 'green',
  paused: 'amber',
  cancelled: 'gray',
  failed: 'red',
}

export default function BroadcastsPage() {
  return (
    <ToastProvider>
      <BroadcastsScreen />
    </ToastProvider>
  )
}

function BroadcastsScreen() {
  const toast = useToast()
  const [broadcasts, setBroadcasts] = useState<Broadcast[] | null>(null)
  const [error, setError] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/broadcasts', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setBroadcasts(json.broadcasts)
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 20000) // sending campaigns move on their own
    return () => clearInterval(t)
  }, [load])

  async function send(b: Broadcast) {
    if (!confirm(`Send "${b.name}" now?`)) return
    const res = await fetch(`/api/broadcasts/${b.id}/send`, { method: 'POST' })
    const json = await res.json()
    toast(res.ok ? `Sending to ${num(json.queued)} recipients…` : json.error, res.ok ? 'green' : 'red')
    load()
  }

  async function remove(b: Broadcast) {
    if (!confirm(`Delete "${b.name}"?`)) return
    const res = await fetch(`/api/broadcasts/${b.id}`, { method: 'DELETE' })
    const json = await res.json()
    toast(res.ok ? 'Campaign deleted' : json.error, res.ok ? 'green' : 'red')
    load()
  }

  return (
    <Page>
      <PageHeader
        title="Broadcasts"
        subtitle="One-off template campaigns to segments"
        actions={
          <Button variant="primary" onClick={() => setWizardOpen(true)}>
            <IconPlus size={14} /> New broadcast
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      <Card padding={0}>
        {!broadcasts ? (
          <TableSkeleton rows={5} cols={8} />
        ) : broadcasts.length === 0 ? (
          <EmptyState
            icon={<IconBroadcasts size={32} />}
            title="No campaigns yet"
            body="A broadcast sends one approved template to a segment. Delivery, read and reply rates are tracked per recipient, and anyone who has opted out is skipped automatically."
            action={
              <Button variant="primary" onClick={() => setWizardOpen(true)}>
                Create your first broadcast
              </Button>
            }
          />
        ) : (
          <Table minWidth={1000}>
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th>Template</Th>
                <Th>Status</Th>
                <Th align="right">Recip.</Th>
                <Th align="right">Deliv.</Th>
                <Th align="right">Read</Th>
                <Th align="right">Replied</Th>
                <Th align="right">Failed</Th>
                <Th align="right">Revenue</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {broadcasts.map((b) => (
                <tr key={b.id} className="cursor-pointer" onClick={() => setDetailId(b.id)}>
                  <Td>
                    <span className="font-medium">{b.name}</span>
                    <span className="block text-[11px]" style={{ color: 'var(--w-muted)' }}>
                      {b.status === 'scheduled' && b.scheduled_at
                        ? `Scheduled ${dateTime(b.scheduled_at)}`
                        : b.completed_at
                          ? `Finished ${relTime(b.completed_at)}`
                          : `Created ${relTime(b.created_at)}`}
                    </span>
                  </Td>
                  <Td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                    {b.template_name}
                  </Td>
                  <Td>
                    <Pill tone={STATUS_TONE[b.status]}>{b.status}</Pill>
                  </Td>
                  <Td align="right">{num(b.total_recipients)}</Td>
                  <Td align="right">
                    {num(b.delivered_count)}
                    <span className="ml-1 text-[11px]" style={{ color: 'var(--w-muted)' }}>
                      {pct(b.delivered_count, b.sent_count)}
                    </span>
                  </Td>
                  <Td align="right">
                    {num(b.read_count)}
                    <span className="ml-1 text-[11px]" style={{ color: 'var(--w-muted)' }}>
                      {pct(b.read_count, b.sent_count)}
                    </span>
                  </Td>
                  <Td align="right">{num(b.replied_count)}</Td>
                  <Td align="right" style={{ color: b.failed_count ? '#EF4444' : undefined }}>
                    {num(b.failed_count)}
                  </Td>
                  <Td align="right" className="font-semibold">
                    {b.revenue ? money(b.revenue) : '—'}
                  </Td>
                  <Td align="right">
                    <span className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      {(b.status === 'draft' || b.status === 'scheduled') && (
                        <Button size="sm" variant="primary" onClick={() => send(b)}>
                          Send now
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => remove(b)}>
                        <IconTrash size={13} />
                      </Button>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {wizardOpen && (
        <BroadcastWizard
          onClose={() => setWizardOpen(false)}
          onCreated={() => {
            setWizardOpen(false)
            load()
            toast('Campaign created')
          }}
        />
      )}

      {detailId && <BroadcastDetail id={detailId} onClose={() => setDetailId(null)} />}
    </Page>
  )
}

/* ==================================================================== */
/* 4-step wizard                                                         */
/* ==================================================================== */

const CONTACT_FIELDS = [
  { key: 'first_name', label: 'First name' },
  { key: 'name', label: 'Full name' },
  { key: 'email', label: 'Email' },
  { key: 'city', label: 'City' },
  { key: 'country', label: 'Country' },
  { key: 'lifetime_spent', label: 'Total spent' },
  { key: 'orders_count', label: 'Order count' },
]

function BroadcastWizard({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState(0)
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [tags, setTags] = useState<any[]>([])
  const [segments, setSegments] = useState<any[]>([])

  const [template, setTemplate] = useState<MessageTemplate | null>(null)
  const [name, setName] = useState('')
  const [audience, setAudience] = useState<any>({ mode: 'all' })
  const [bindings, setBindings] = useState<Array<{ kind: string; value: string }>>([])
  const [scheduledAt, setScheduledAt] = useState('')
  const [estimate, setEstimate] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      fetch('/api/templates').then((r) => r.json()),
      fetch('/api/tags').then((r) => r.json()),
      fetch('/api/segments').then((r) => r.json()),
    ]).then(([t, g, s]) => {
      setTemplates((t.templates ?? []).filter((x: MessageTemplate) => x.status === 'APPROVED'))
      setTags(g.tags ?? [])
      setSegments(s.segments ?? [])
    })
  }, [])

  const varCount = useMemo(() => {
    const found = [...(template?.body_text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
    return found.length ? Math.max(...found) : 0
  }, [template])

  useEffect(() => {
    setBindings(Array.from({ length: varCount }, () => ({ kind: 'static', value: '' })))
  }, [varCount])

  // Refresh the audience estimate whenever the selection changes.
  useEffect(() => {
    if (step !== 1) return
    fetch('/api/broadcasts/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience }),
    })
      .then((r) => r.json())
      .then(setEstimate)
      .catch(() => {})
  }, [audience, step])

  const preview = useMemo(
    () =>
      (template?.body_text ?? '').replace(/\{\{(\d+)\}\}/g, (_m, n) => {
        const b = bindings[Number(n) - 1]
        if (!b) return `{{${n}}}`
        if (b.kind === 'static') return b.value || `{{${n}}}`
        const field = CONTACT_FIELDS.find((f) => f.key === b.value)
        return field ? `[${field.label}]` : `{{${n}}}`
      }),
    [template, bindings]
  )

  async function create() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          template_id: template?.id,
          template_name: template?.name,
          template_language: template?.language,
          audience,
          variable_map: { body: bindings },
          scheduled_at: scheduledAt || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error)
        return
      }
      onCreated()
    } finally {
      setBusy(false)
    }
  }

  const STEPS = ['Choose template', 'Select audience', 'Personalize', 'Schedule']

  // Every variable must have a value. A blank one is not "no personalisation":
  // Meta rejects the send outright with #132012, once per recipient.
  const unfilled = bindings.findIndex((b) => !String(b.value ?? '').trim())
  const canNext = [!!template, !!estimate?.sendable, unfilled < 0, !!name.trim()][step]

  return (
    <Modal
      open
      onClose={onClose}
      title="New broadcast"
      width={720}
      footer={
        <>
          {step > 0 && <Button onClick={() => setStep((s) => s - 1)}>Back</Button>}
          {step < 3 ? (
            <Button variant="primary" onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={create} disabled={!canNext}>
              {scheduledAt ? 'Schedule campaign' : 'Create draft'}
            </Button>
          )}
        </>
      }
    >
      {/* stepper */}
      <div className="mb-4 flex gap-1.5">
        {STEPS.map((s, i) => (
          <div key={s} className="flex-1">
            <div
              className="h-1 rounded-full"
              style={{ background: i <= step ? '#16A34A' : 'var(--w-border)' }}
            />
            <div
              className="mt-1.5 text-[11px] font-medium"
              style={{ color: i <= step ? '#16A34A' : 'var(--w-muted)' }}
            >
              {i + 1}. {s}
            </div>
          </div>
        ))}
      </div>

      {/* 1 — template */}
      {step === 0 && (
        <>
          {templates.length === 0 ? (
            <div className="py-6 text-center text-[13px]" style={{ color: 'var(--w-muted)' }}>
              You have no Approved templates yet. Sync or create one on the Templates screen first — Meta only
              allows template messages for campaigns.
            </div>
          ) : (
            templates.map((t) => (
              <button
                key={t.id}
                onClick={() => setTemplate(t)}
                className="mb-1.5 block w-full cursor-pointer rounded-lg border p-3 text-left"
                style={{
                  background: template?.id === t.id ? 'var(--w-greentint)' : 'var(--w-card2)',
                  borderColor: template?.id === t.id ? '#BBF7D0' : 'var(--w-border)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {t.name}
                  </span>
                  <span className="flex gap-1.5">
                    <Pill tone="gray">{t.language}</Pill>
                    <Pill tone="blue">{t.category}</Pill>
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-[12px]" style={{ color: 'var(--w-muted)' }}>
                  {t.body_text}
                </div>
              </button>
            ))
          )}
        </>
      )}

      {/* 2 — audience */}
      {step === 1 && (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {[
              ['all', 'Everyone'],
              ['segment', 'A segment'],
              ['tags', 'By tags'],
            ].map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setAudience({ mode })}
                className="cursor-pointer rounded-lg border px-3 py-1.5 text-[12.5px] font-medium"
                style={{
                  background: audience.mode === mode ? 'var(--w-greentint)' : 'var(--w-card)',
                  color: audience.mode === mode ? '#16A34A' : 'var(--w-muted)',
                  borderColor: audience.mode === mode ? '#BBF7D0' : 'var(--w-border)',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {audience.mode === 'segment' && (
            <Select
              label="Segment"
              value={audience.segment_id ?? ''}
              onChange={(e) => setAudience({ mode: 'segment', segment_id: e.target.value })}
            >
              <option value="">Pick a segment…</option>
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.member_count} contacts)
                </option>
              ))}
            </Select>
          )}

          {audience.mode === 'tags' && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => {
                const on = (audience.tag_ids ?? []).includes(t.id)
                return (
                  <button
                    key={t.id}
                    onClick={() =>
                      setAudience({
                        mode: 'tags',
                        tag_ids: on
                          ? (audience.tag_ids ?? []).filter((x: string) => x !== t.id)
                          : [...(audience.tag_ids ?? []), t.id],
                      })
                    }
                    className="cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium"
                    style={{
                      background: on ? 'var(--w-greentint)' : 'var(--w-card)',
                      color: on ? '#16A34A' : 'var(--w-muted)',
                      borderColor: on ? '#BBF7D0' : 'var(--w-border)',
                    }}
                  >
                    {t.name} ({t.count})
                  </button>
                )
              })}
            </div>
          )}

          {estimate && (
            <div
              className="mt-4 rounded-[10px] border p-3"
              style={{ background: 'var(--w-greentint)', borderColor: '#BBF7D0' }}
            >
              <div className="text-[20px] font-bold" style={{ color: '#15803D' }}>
                {num(estimate.sendable)}
              </div>
              <div className="text-[12.5px]" style={{ color: '#15803D' }}>
                contacts will receive this message
              </div>
              {estimate.suppressed > 0 && (
                <div className="mt-1 text-[11.5px]" style={{ color: '#92400E' }}>
                  {num(estimate.suppressed)} skipped — opted out or on the suppression list
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* 3 — personalize */}
      {step === 2 && (
        <>
          {varCount === 0 ? (
            <div className="text-[13px]" style={{ color: 'var(--w-muted)' }}>
              This template has no variables — nothing to personalise.
            </div>
          ) : (
            <>
            {unfilled >= 0 && (
              <div
                className="mb-3 rounded-lg px-3 py-2 text-[12.5px]"
                style={{ background: 'var(--w-ambertint)', color: '#92400E' }}
              >
                {`{{${unfilled + 1}}}`} still needs a value. WhatsApp rejects a message with a blank
                variable — every recipient would fail with error #132012.
              </div>
            )}
            {bindings.map((b, i) => (
              <div key={i} className="mb-2.5 flex flex-wrap items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 text-[12px] font-bold"
                  style={{ background: 'var(--w-card2)', fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {`{{${i + 1}}}`}
                </span>
                <select
                  value={b.kind}
                  onChange={(e) =>
                    setBindings((prev) => prev.map((x, j) => (j === i ? { kind: e.target.value, value: '' } : x)))
                  }
                  className="cursor-pointer rounded-lg border px-2 py-1.5 text-[12.5px]"
                  style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                >
                  <option value="static">Fixed text</option>
                  <option value="contact_field">Contact field</option>
                </select>

                {b.kind === 'static' ? (
                  <input
                    value={b.value}
                    onChange={(e) =>
                      setBindings((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                    }
                    placeholder="Value"
                    className="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-[12.5px] outline-none"
                    style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                  />
                ) : (
                  <select
                    value={b.value}
                    onChange={(e) =>
                      setBindings((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                    }
                    className="min-w-0 flex-1 cursor-pointer rounded-lg border px-2 py-1.5 text-[12.5px]"
                    style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                  >
                    <option value="">Pick a field…</option>
                    {CONTACT_FIELDS.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
            </>
          )}

          <div className="mt-3 text-[12.5px] font-medium">Preview</div>
          <div
            className="mt-1.5 rounded-lg p-3 text-[13px] leading-relaxed"
            style={{ background: 'var(--w-bubble-out)', color: '#111827' }}
          >
            {preview}
          </div>
        </>
      )}

      {/* 4 — schedule */}
      {step === 3 && (
        <>
          <Input
            label="Campaign name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rebajas Julio VIP"
            className="mb-3"
          />
          <Input
            label="Schedule for (optional)"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            hint="Leave empty to save as a draft and send manually. Scheduled campaigns start on the next 15-minute cron tick."
          />

          <div
            className="mt-4 rounded-[10px] border p-3 text-[12.5px]"
            style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
          >
            <div className="mb-1 font-semibold">Summary</div>
            <div style={{ color: 'var(--w-muted)' }}>
              Template <b style={{ color: 'var(--w-text)' }}>{template?.name}</b> ({template?.language}) to{' '}
              <b style={{ color: 'var(--w-text)' }}>{num(estimate?.sendable ?? 0)}</b> contacts
              {estimate?.suppressed ? `, ${num(estimate.suppressed)} skipped for consent` : ''}.
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}

/* ==================================================================== */
/* Delivery report                                                       */
/* ==================================================================== */

const RECIPIENT_TONE: Record<string, any> = {
  queued: 'gray',
  sent: 'blue',
  delivered: 'blue',
  read: 'green',
  replied: 'green',
  failed: 'red',
  skipped: 'amber',
}

function BroadcastDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    fetch(`/api/broadcasts/${id}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then(setData)
  }, [id])

  const b = data?.broadcast
  const recipients = (data?.recipients ?? []).filter((r: any) => filter === 'all' || r.status === filter)

  return (
    <Modal open onClose={onClose} title={b ? `Delivery report — "${b.name}"` : 'Loading…'} width={800}>
      {!data ? (
        <TableSkeleton rows={6} cols={3} />
      ) : (
        <>
          <div className="mb-4 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
            {[
              ['Recipients', b.total_recipients, 'var(--w-text)'],
              ['Sent', b.sent_count, '#16A34A'],
              ['Delivered', b.delivered_count, '#22C55E'],
              ['Read', b.read_count, '#2563EB'],
              ['Replied', b.replied_count, '#16A34A'],
              ['Failed', b.failed_count, '#EF4444'],
              ['Skipped', b.opted_out_count, '#F59E0B'],
            ].map(([label, value, color]) => (
              <div
                key={label as string}
                className="rounded-lg border p-2.5"
                style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
              >
                <div className="text-[11px]" style={{ color: 'var(--w-muted)' }}>
                  {label as string}
                </div>
                <div className="text-[17px] font-bold" style={{ color: color as string }}>
                  {num(value as number)}
                </div>
              </div>
            ))}
          </div>

          <div className="mb-2 flex flex-wrap gap-1.5">
            {['all', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped'].map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className="cursor-pointer rounded-full border px-2.5 py-[3px] text-[11.5px] font-medium"
                style={{
                  background: filter === s ? '#16A34A' : 'var(--w-card)',
                  color: filter === s ? '#fff' : 'var(--w-muted)',
                  borderColor: filter === s ? '#16A34A' : 'var(--w-border)',
                }}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="max-h-80 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--w-border)' }}>
            <Table>
              <thead>
                <tr>
                  <Th>Recipient</Th>
                  <Th>Status</Th>
                  <Th>Detail / failure reason</Th>
                </tr>
              </thead>
              <tbody>
                {recipients.length === 0 && (
                  <tr>
                    <Td colSpan={3} align="center" style={{ color: 'var(--w-muted)', padding: 20 }}>
                      No recipients in this filter.
                    </Td>
                  </tr>
                )}
                {recipients.map((r: any) => (
                  <tr key={r.id}>
                    <Td>
                      <span className="font-medium">{r.name || '—'}</span>
                      <span
                        className="block text-[11px]"
                        style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--w-muted)' }}
                      >
                        {formatPhone(r.phone)}
                      </span>
                    </Td>
                    <Td>
                      <Pill tone={RECIPIENT_TONE[r.status]}>{r.status}</Pill>
                    </Td>
                    <Td style={{ color: r.error_message ? '#B91C1C' : 'var(--w-muted)', fontSize: 12 }}>
                      {r.error_message ||
                        (r.read_at
                          ? `Read ${relTime(r.read_at)}`
                          : r.delivered_at
                            ? `Delivered ${relTime(r.delivered_at)}`
                            : r.sent_at
                              ? `Sent ${relTime(r.sent_at)}`
                              : '—')}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>

          <div className="mt-4">
            <CardTitle title="Opt-out handling" sub="STOP · BAJA · PARAR · UNSUBSCRIBE are suppressed instantly" />
            {(data.optOuts ?? []).length === 0 ? (
              <div className="text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                No opt-outs recorded.
              </div>
            ) : (
              (data.optOuts ?? []).slice(0, 8).map((o: any) => (
                <div key={o.id} className="py-1 text-[12.5px]">
                  {o.contacts?.name || formatPhone(o.contacts?.phone)} — sent &quot;{o.keyword ?? 'stop'}&quot;{' '}
                  <span style={{ color: 'var(--w-muted)' }}>{relTime(o.created_at)}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Modal>
  )
}
