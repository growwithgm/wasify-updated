'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Button, Card, CardTitle, EmptyState, ErrorState, Input, Modal, Page, PageHeader, Pill, Select,
  Table, TableSkeleton, Td, Th, Textarea, ToastProvider, money, num, relTime, useToast,
} from '@/components/ui'
import { IconFlows, IconPlus, IconTrash, IconX } from '@/components/icons'
import type { Flow, FlowNode, MessageTemplate } from '@/lib/types'

const STATUS_TONE: Record<string, any> = { active: 'green', draft: 'gray', paused: 'amber', archived: 'gray' }

/** One-click starting points, mirroring the prototype's template gallery. */
const GALLERY = [
  {
    emoji: '🛒',
    name: 'Abandoned checkout recovery',
    desc: 'Three timed reminders with an optional discount. Configured on the Integrations screen.',
    builtin: true,
  },
  {
    emoji: '📦',
    name: 'COD order confirmation',
    desc: 'Ask the customer to confirm a cash-on-delivery order before you ship it.',
    builtin: true,
  },
  {
    emoji: '👋',
    name: 'Welcome + FAQ menu',
    desc: 'Greet first-time senders and offer buttons for shipping, sizing and returns.',
    nodes: [
      { node_type: 'buttons', config: { body: '¡Hola! 👋 ¿En qué te ayudamos?', buttons: [
        { id: 'shipping', title: 'Envíos', next: 'node_2' },
        { id: 'sizes', title: 'Tallas', next: 'node_3' },
        { id: 'agent', title: 'Hablar con alguien', next: 'node_4' },
      ] } },
      { node_type: 'message', config: { body: 'Enviamos en 24-48h a toda España. Envío gratis desde 50 €.' } },
      { node_type: 'message', config: { body: 'Tenemos de la XS a la XL. ¿Quieres que te ayudemos a elegir?' } },
      { node_type: 'assign', config: {} },
    ],
  },
  {
    emoji: '💚',
    name: 'Post-delivery review request',
    desc: 'Ask for a review a few days after delivery.',
    nodes: [
      { node_type: 'delay', config: { delay_minutes: 4320 } },
      { node_type: 'buttons', config: { body: '¿Qué tal tu pedido? Nos ayuda mucho tu opinión 💚', buttons: [
        { id: 'great', title: 'Me encanta' },
        { id: 'issue', title: 'Tuve un problema' },
      ] } },
    ],
  },
]

export default function FlowsPage() {
  return (
    <ToastProvider>
      <FlowsScreen />
    </ToastProvider>
  )
}

function FlowsScreen() {
  const toast = useToast()
  const [flows, setFlows] = useState<Flow[] | null>(null)
  const [events, setEvents] = useState<any[]>([])
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [galleryOpen, setGalleryOpen] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/flows', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setFlows(json.flows)
      setEvents(json.events ?? [])
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function create(name: string, nodes?: any[]) {
    const res = await fetch('/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, trigger_type: 'keyword', trigger_config: { keywords: [], match: 'contains' } }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast(json.error, 'red')
      return
    }

    if (nodes?.length) {
      await fetch(`/api/flows/${json.flow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: nodes.map((n, i) => ({ ...n, node_key: `node_${i + 1}` })),
        }),
      })
    }

    setGalleryOpen(false)
    load()
    setEditingId(json.flow.id)
  }

  async function remove(f: Flow) {
    if (!confirm(`Delete "${f.name}"? Active runs are ended.`)) return
    await fetch(`/api/flows/${f.id}`, { method: 'DELETE' })
    toast('Flow deleted')
    load()
  }

  return (
    <Page>
      <PageHeader
        title="Flows"
        subtitle="Automated WhatsApp journeys triggered by chat and Shopify events"
        actions={
          <>
            <Button onClick={() => setGalleryOpen(true)}>⚡ Template gallery</Button>
            <Button variant="primary" onClick={() => create('Untitled flow')}>
              <IconPlus size={14} /> New flow
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      {!flows && (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="w-skel" style={{ height: 130 }} />
          ))}
        </div>
      )}

      {flows?.length === 0 && (
        <Card>
          <EmptyState
            icon={<IconFlows size={32} />}
            title="No flows yet"
            body="A flow is a button-driven conversation: send a message, offer choices, branch on what the customer taps. Only one flow runs per contact at a time, and an agent replying manually pauses it."
            action={
              <div className="flex gap-2">
                <Button onClick={() => setGalleryOpen(true)}>Browse templates</Button>
                <Button variant="primary" onClick={() => create('Untitled flow')}>
                  Start from scratch
                </Button>
              </div>
            }
          />
        </Card>
      )}

      {flows && flows.length > 0 && (
        <div className="mb-5 grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))' }}>
          {flows.map((f) => (
            <Card key={f.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[14.5px] font-semibold">{f.name}</div>
                  <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                    Trigger: {f.trigger_type.replace('_', ' ')}
                    {(f.trigger_config as any)?.keywords?.length
                      ? ` — ${(f.trigger_config as any).keywords.join(', ')}`
                      : ''}
                  </div>
                </div>
                <Pill tone={STATUS_TONE[f.status]}>{f.status}</Pill>
              </div>

              <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                {[
                  ['Entered', num(f.entered_count)],
                  ['Completed', num(f.completed_count)],
                  ['Drop-off', f.entered_count ? `${(((f.entered_count - f.completed_count) / f.entered_count) * 100).toFixed(0)}%` : '—'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div className="text-[10.5px]" style={{ color: 'var(--w-muted)' }}>
                      {label}
                    </div>
                    <div className="text-[15px] font-bold">{value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center gap-1.5">
                <Button size="sm" variant="primary" onClick={() => setEditingId(f.id)}>
                  Edit flow
                </Button>
                <span className="text-[11px]" style={{ color: 'var(--w-muted)' }}>
                  v{f.version} · {relTime(f.updated_at)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => remove(f)} style={{ marginLeft: 'auto' }}>
                  <IconTrash size={13} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {events.length > 0 && (
        <Card padding={0}>
          <div className="px-5 pb-1 pt-5">
            <CardTitle title="Execution log" sub="Most recent flow steps across every contact" />
          </div>
          <Table minWidth={640}>
            <thead>
              <tr>
                <Th>Contact</Th>
                <Th>Step</Th>
                <Th>Status</Th>
                <Th>Detail</Th>
                <Th align="right">When</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <Td>{e.contacts?.name || `+${e.contacts?.phone ?? '—'}`}</Td>
                  <Td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{e.node_key}</Td>
                  <Td>
                    <Pill tone={e.status === 'ok' ? 'green' : e.status === 'error' ? 'red' : 'amber'}>
                      {e.status}
                    </Pill>
                  </Td>
                  <Td style={{ color: 'var(--w-muted)', fontSize: 12 }}>{e.detail || '—'}</Td>
                  <Td align="right" style={{ color: 'var(--w-muted)', fontSize: 12 }}>
                    {relTime(e.created_at)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {galleryOpen && (
        <Modal open onClose={() => setGalleryOpen(false)} title="Pre-built flow templates" width={620}>
          <div className="mb-3 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
            One-click install — fully editable afterwards.
          </div>
          {GALLERY.map((g) => (
            <div
              key={g.name}
              className="mb-2 flex items-center gap-3 rounded-[10px] border p-3"
              style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
            >
              <span className="text-[22px]">{g.emoji}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold">{g.name}</span>
                <span className="block text-[12px]" style={{ color: 'var(--w-muted)' }}>
                  {g.desc}
                </span>
              </span>
              {g.builtin ? (
                <a href="/integrations" className="no-underline">
                  <Button size="sm">Configure</Button>
                </a>
              ) : (
                <Button size="sm" variant="primary" onClick={() => create(g.name, g.nodes)}>
                  Install
                </Button>
              )}
            </div>
          ))}
          <div className="mt-3 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
            Cart recovery and COD confirmation are built into Wasify rather than editable flows — they need
            Shopify order state, so they live on the Integrations screen.
          </div>
        </Modal>
      )}

      {editingId && (
        <FlowEditor
          id={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            load()
            toast('Flow saved')
          }}
        />
      )}
    </Page>
  )
}

/* ==================================================================== */
/* Editor                                                                */
/* ==================================================================== */

const NODE_TYPES = [
  { key: 'message', label: 'Send message' },
  { key: 'template', label: 'Send template' },
  { key: 'buttons', label: 'Ask with buttons' },
  { key: 'delay', label: 'Wait' },
  { key: 'tag', label: 'Add tag' },
  { key: 'assign', label: 'Assign to agent' },
  { key: 'end', label: 'End flow' },
]

function FlowEditor({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [flow, setFlow] = useState<any>(null)
  const [nodes, setNodes] = useState<any[]>([])
  const [runs, setRuns] = useState<any[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [tags, setTags] = useState<any[]>([])
  const [agents, setAgents] = useState<any[]>([])
  const [issues, setIssues] = useState<Array<{ node_key: string; message: string }>>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch(`/api/flows/${id}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        setFlow(j.flow)
        setNodes(j.nodes ?? [])
        setRuns(j.runs ?? [])
      })
    Promise.all([
      fetch('/api/templates').then((r) => r.json()),
      fetch('/api/tags').then((r) => r.json()),
      fetch('/api/agents').then((r) => r.json()),
    ]).then(([t, g, a]) => {
      setTemplates((t.templates ?? []).filter((x: MessageTemplate) => x.status === 'APPROVED'))
      setTags(g.tags ?? [])
      setAgents(a.agents ?? [])
    })
  }, [id])

  function updateNode(i: number, patch: any) {
    setNodes((prev) => prev.map((n, j) => (j === i ? { ...n, ...patch } : n)))
  }

  function updateConfig(i: number, patch: any) {
    setNodes((prev) => prev.map((n, j) => (j === i ? { ...n, config: { ...n.config, ...patch } } : n)))
  }

  function addNode(type: string) {
    const key = `node_${Date.now().toString(36)}`
    setNodes((prev) => [...prev, { node_key: key, node_type: type, config: {} }])
  }

  async function save(status?: string) {
    setSaving(true)
    try {
      const res = await fetch(`/api/flows/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: flow.name,
          trigger_type: flow.trigger_type,
          trigger_config: flow.trigger_config,
          nodes,
          version: flow.version,
          ...(status ? { status } : {}),
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setIssues(json.issues ?? [])
        toast(json.error, 'red')
        return
      }
      setIssues(json.issues ?? [])
      setFlow(json.flow)
      onSaved()
      if (status) onClose()
    } finally {
      setSaving(false)
    }
  }

  if (!flow) {
    return (
      <Modal open onClose={onClose} title="Loading flow…" width={760}>
        <TableSkeleton rows={5} cols={2} />
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={flow.name}
      width={780}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button loading={saving} onClick={() => save()}>
            Save draft
          </Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={() => save(flow.status === 'active' ? 'paused' : 'active')}
          >
            {flow.status === 'active' ? 'Pause flow' : 'Publish & activate'}
          </Button>
        </>
      }
    >
      <div className="mb-3 grid gap-2.5" style={{ gridTemplateColumns: '1fr 150px' }}>
        <Input label="Flow name" value={flow.name} onChange={(e) => setFlow({ ...flow, name: e.target.value })} />
        <Select
          label="Trigger"
          value={flow.trigger_type}
          onChange={(e) => setFlow({ ...flow, trigger_type: e.target.value })}
        >
          <option value="keyword">Keyword</option>
          <option value="first_message">First message</option>
          <option value="manual">Manual only</option>
        </Select>
      </div>

      {flow.trigger_type === 'keyword' && (
        <Input
          label="Trigger keywords (comma separated)"
          value={(flow.trigger_config?.keywords ?? []).join(', ')}
          onChange={(e) =>
            setFlow({
              ...flow,
              trigger_config: {
                ...flow.trigger_config,
                keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                match: flow.trigger_config?.match ?? 'contains',
              },
            })
          }
          className="mb-3"
          hint="Matching is accent- and case-insensitive, on whole words."
        />
      )}

      {issues.length > 0 && (
        <div
          className="mb-3 rounded-[10px] border p-3"
          style={{ background: 'var(--w-ambertint)', borderColor: '#FDE68A' }}
        >
          <div className="mb-1 text-[12.5px] font-semibold" style={{ color: '#92400E' }}>
            {issues.length} issue{issues.length > 1 ? 's' : ''} to fix before activating
          </div>
          {issues.map((i, k) => (
            <div key={k} className="text-[12px]" style={{ color: '#92400E' }}>
              · {i.message} <span style={{ opacity: 0.7 }}>({i.node_key})</span>
            </div>
          ))}
        </div>
      )}

      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[.05em]" style={{ color: 'var(--w-muted)' }}>
        Steps
      </div>

      {nodes.map((n, i) => {
        const nodeIssues = issues.filter((x) => x.node_key === n.node_key)
        return (
          <div
            key={n.node_key}
            className="mb-2 rounded-[10px] border p-3"
            style={{
              background: 'var(--w-card2)',
              borderColor: nodeIssues.length ? '#FDE68A' : 'var(--w-border)',
            }}
          >
            <div className="mb-2 flex items-center gap-2">
              <span
                className="rounded px-1.5 py-0.5 text-[10.5px] font-bold"
                style={{ background: 'var(--w-card)', fontFamily: "'JetBrains Mono', monospace" }}
              >
                {i + 1}
              </span>
              <select
                value={n.node_type}
                onChange={(e) => updateNode(i, { node_type: e.target.value, config: {} })}
                className="cursor-pointer rounded-lg border px-2 py-1 text-[12.5px]"
                style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
              >
                {NODE_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setNodes((prev) => prev.filter((_, j) => j !== i))}
                className="ml-auto cursor-pointer border-0 bg-transparent p-1"
                style={{ color: 'var(--w-muted)' }}
              >
                <IconX size={14} />
              </button>
            </div>

            {(n.node_type === 'message' || n.node_type === 'buttons') && (
              <Textarea
                value={n.config?.body ?? ''}
                rows={2}
                placeholder={n.node_type === 'buttons' ? 'Question to ask…' : 'Message text…'}
                onChange={(e) => updateConfig(i, { body: e.target.value })}
              />
            )}

            {n.node_type === 'template' && (
              <Select
                value={n.config?.template_name ?? ''}
                onChange={(e) => {
                  const t = templates.find((x) => x.name === e.target.value)
                  updateConfig(i, { template_name: e.target.value, template_language: t?.language })
                }}
              >
                <option value="">Pick an approved template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name} ({t.language})
                  </option>
                ))}
              </Select>
            )}

            {n.node_type === 'buttons' && (
              <div className="mt-2">
                {(n.config?.buttons ?? []).map((b: any, bi: number) => (
                  <div key={bi} className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <input
                      value={b.title ?? ''}
                      placeholder="Button label (max 20)"
                      maxLength={20}
                      onChange={(e) => {
                        const buttons = [...(n.config.buttons ?? [])]
                        buttons[bi] = {
                          ...b,
                          title: e.target.value,
                          id: b.id || e.target.value.toLowerCase().replace(/\W/g, '_').slice(0, 20),
                        }
                        updateConfig(i, { buttons })
                      }}
                      className="min-w-0 flex-1 rounded-lg border px-2 py-1 text-[12.5px] outline-none"
                      style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                    />
                    <select
                      value={b.next ?? ''}
                      onChange={(e) => {
                        const buttons = [...(n.config.buttons ?? [])]
                        buttons[bi] = { ...b, next: e.target.value || undefined }
                        updateConfig(i, { buttons })
                      }}
                      className="cursor-pointer rounded-lg border px-2 py-1 text-[12px]"
                      style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                    >
                      <option value="">→ end flow</option>
                      {nodes
                        .filter((_, j) => j !== i)
                        .map((o, j) => (
                          <option key={o.node_key} value={o.node_key}>
                            → step {nodes.indexOf(o) + 1}
                          </option>
                        ))}
                    </select>
                    <button
                      onClick={() =>
                        updateConfig(i, { buttons: (n.config.buttons ?? []).filter((_: any, j: number) => j !== bi) })
                      }
                      className="cursor-pointer border-0 bg-transparent p-1"
                      style={{ color: 'var(--w-muted)' }}
                    >
                      <IconX size={13} />
                    </button>
                  </div>
                ))}
                {(n.config?.buttons ?? []).length < 3 && (
                  <Button
                    size="sm"
                    onClick={() => updateConfig(i, { buttons: [...(n.config?.buttons ?? []), { id: '', title: '' }] })}
                  >
                    <IconPlus size={12} /> Add button
                  </Button>
                )}
              </div>
            )}

            {n.node_type === 'delay' && (
              <Input
                type="number"
                value={n.config?.delay_minutes ?? ''}
                placeholder="Minutes to wait"
                onChange={(e) => updateConfig(i, { delay_minutes: Number(e.target.value) })}
                hint="The 15-minute cron resumes the run, so waits round up to the next tick."
              />
            )}

            {n.node_type === 'tag' && (
              <Select value={n.config?.tag_id ?? ''} onChange={(e) => updateConfig(i, { tag_id: e.target.value })}>
                <option value="">Pick a tag…</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}

            {n.node_type === 'assign' && (
              <Select value={n.config?.agent_id ?? ''} onChange={(e) => updateConfig(i, { agent_id: e.target.value })}>
                <option value="">Unassigned (leave for anyone)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}

            {n.node_type !== 'buttons' && n.node_type !== 'end' && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                  Then go to
                </span>
                <select
                  value={n.config?.next ?? ''}
                  onChange={(e) => updateConfig(i, { next: e.target.value || undefined })}
                  className="cursor-pointer rounded-lg border px-2 py-1 text-[12px]"
                  style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                >
                  <option value="">end the flow</option>
                  {nodes
                    .filter((_, j) => j !== i)
                    .map((o) => (
                      <option key={o.node_key} value={o.node_key}>
                        step {nodes.indexOf(o) + 1}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </div>
        )
      })}

      <div className="flex flex-wrap gap-1.5">
        {NODE_TYPES.slice(0, 5).map((t) => (
          <Button key={t.key} size="sm" onClick={() => addNode(t.key)}>
            <IconPlus size={12} /> {t.label}
          </Button>
        ))}
      </div>

      {runs.length > 0 && (
        <>
          <div
            className="mb-1.5 mt-5 text-[11px] font-bold uppercase tracking-[.05em]"
            style={{ color: 'var(--w-muted)' }}
          >
            Recent runs
          </div>
          {runs.slice(0, 8).map((r) => (
            <div key={r.id} className="flex items-center justify-between py-1 text-[12.5px]">
              <span>{r.contacts?.name || `+${r.contacts?.phone ?? '—'}`}</span>
              <span className="flex items-center gap-2">
                <Pill tone={r.status === 'completed' ? 'green' : r.status === 'active' ? 'blue' : 'gray'}>
                  {r.status}
                </Pill>
                <span style={{ color: 'var(--w-muted)' }}>{relTime(r.started_at)}</span>
              </span>
            </div>
          ))}
        </>
      )}
    </Modal>
  )
}
