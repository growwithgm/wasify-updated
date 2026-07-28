'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Button, Card, CardTitle, ErrorState, Input, Modal, Page, PageHeader, Pill, Select,
  Table, TableSkeleton, Td, Th, Textarea, Toggle, ToastProvider, relTime, useToast,
} from '@/components/ui'
import { IconPlus, IconTrash } from '@/components/icons'
import { formatPhone } from '@/lib/phone'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const TIMEZONES = [
  'Europe/Madrid', 'Europe/London', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin',
  'America/New_York', 'America/Mexico_City', 'America/Bogota', 'America/Sao_Paulo',
  'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'UTC',
]

const SECTIONS = ['Business profile', 'Business hours', 'Team', 'Canned replies', 'Suppression list'] as const

export default function SettingsPage() {
  return (
    <ToastProvider>
      <SettingsScreen />
    </ToastProvider>
  )
}

function SettingsScreen() {
  const toast = useToast()
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('Business profile')
  const [form, setForm] = useState<any>({})
  const [saving, setSaving] = useState(false)
  const [agentModal, setAgentModal] = useState(false)
  const [cannedModal, setCannedModal] = useState<any>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setData(json)
      setForm({ ...json.settings, full_name: json.profile?.full_name ?? '' })
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
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      toast(res.ok ? 'Settings saved' : json.error, res.ok ? 'green' : 'red')
      if (res.ok) load()
    } finally {
      setSaving(false)
    }
  }

  const hours: any[] = form.business_hours?.length
    ? form.business_hours
    : DAYS.map((_, i) => ({ day: i, open: '09:00', close: '18:00', closed: i === 0 || i === 6 }))

  return (
    <Page>
      <PageHeader
        title="Settings"
        subtitle="Business profile, hours, team and safety lists"
        actions={
          <Button variant="primary" loading={saving} onClick={save} disabled={!data}>
            Save changes
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-1.5">
        {SECTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className="cursor-pointer rounded-full border px-3 py-1 text-[12.5px] font-medium"
            style={{
              background: section === s ? '#16A34A' : 'var(--w-card)',
              color: section === s ? '#fff' : 'var(--w-muted)',
              borderColor: section === s ? '#16A34A' : 'var(--w-border)',
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {!data ? (
        <TableSkeleton rows={6} cols={3} />
      ) : (
        <>
          {section === 'Business profile' && (
            <>
              <Card className="mb-4">
                <CardTitle title="Business profile" sub="Shown to customers in WhatsApp" />
                <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  <Input label="Your name" value={form.full_name ?? ''} onChange={(e) => set('full_name', e.target.value)} />
                  <Input
                    label="Business name"
                    value={form.business_name ?? ''}
                    onChange={(e) => set('business_name', e.target.value)}
                  />
                  <Input
                    label="Category"
                    value={form.business_category ?? ''}
                    onChange={(e) => set('business_category', e.target.value)}
                    placeholder="Fashion & apparel"
                  />
                  <Select label="Timezone" value={form.timezone ?? 'Europe/Madrid'} onChange={(e) => set('timezone', e.target.value)}>
                    {TIMEZONES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                  <Select label="Currency" value={form.currency ?? 'EUR'} onChange={(e) => set('currency', e.target.value)}>
                    {['EUR', 'GBP', 'USD', 'MXN', 'BRL', 'AED', 'PKR'].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </div>
                <Textarea
                  label="About"
                  value={form.business_about ?? ''}
                  rows={2}
                  className="mt-3"
                  onChange={(e) => set('business_about', e.target.value)}
                />
              </Card>

              <Card>
                <CardTitle title="Automatic messages" sub="Sent inside the 24-hour window only" />
                <div className="mb-3">
                  <Toggle
                    checked={form.greeting_enabled ?? false}
                    onChange={(v) => set('greeting_enabled', v)}
                    label="Greeting on first contact"
                  />
                </div>
                {form.greeting_enabled && (
                  <Textarea
                    value={form.greeting_message ?? ''}
                    rows={2}
                    className="mb-4"
                    placeholder="¡Hola! 👋 Bienvenida. ¿En qué podemos ayudarte hoy?"
                    onChange={(e) => set('greeting_message', e.target.value)}
                  />
                )}

                <div className="mb-3">
                  <Toggle
                    checked={form.away_enabled ?? false}
                    onChange={(v) => set('away_enabled', v)}
                    label="Away message outside business hours"
                  />
                </div>
                {form.away_enabled && (
                  <Textarea
                    value={form.away_message ?? ''}
                    rows={2}
                    placeholder="Gracias por escribirnos 💚 Ahora estamos fuera de horario — te respondemos mañana a partir de las 9:00."
                    onChange={(e) => set('away_message', e.target.value)}
                  />
                )}

                <div className="mt-4">
                  <Input
                    label="Auto-close conversations after (hours)"
                    type="number"
                    value={String(form.auto_close_hours ?? 0)}
                    onChange={(e) => set('auto_close_hours', Number(e.target.value))}
                    hint="0 means never auto-close"
                  />
                </div>
              </Card>
            </>
          )}

          {section === 'Business hours' && (
            <Card>
              <CardTitle
                title="Business hours"
                sub={`Used by the away message and the "business hours only" chatbot switch · ${form.timezone ?? 'Europe/Madrid'}`}
              />
              {DAYS.map((day, i) => {
                const row = hours.find((h) => Number(h.day) === i) ?? { day: i, open: '09:00', close: '18:00', closed: true }
                const update = (patch: any) => {
                  const next = DAYS.map((_, j) => {
                    const existing = hours.find((h) => Number(h.day) === j) ?? {
                      day: j,
                      open: '09:00',
                      close: '18:00',
                      closed: true,
                    }
                    return j === i ? { ...existing, ...patch } : existing
                  })
                  set('business_hours', next)
                }

                return (
                  <div key={day} className="flex flex-wrap items-center gap-3 py-2" style={{ borderBottom: '1px solid var(--w-border)' }}>
                    <span className="w-24 text-[13px] font-medium">{day}</span>
                    <Toggle checked={!row.closed} onChange={(v) => update({ closed: !v })} />
                    {!row.closed && (
                      <>
                        <input
                          type="time"
                          value={row.open}
                          onChange={(e) => update({ open: e.target.value })}
                          className="rounded-lg border px-2 py-1 text-[12.5px]"
                          style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                        />
                        <span style={{ color: 'var(--w-muted)' }}>to</span>
                        <input
                          type="time"
                          value={row.close}
                          onChange={(e) => update({ close: e.target.value })}
                          className="rounded-lg border px-2 py-1 text-[12.5px]"
                          style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                        />
                      </>
                    )}
                    {row.closed && (
                      <span className="text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                        Closed
                      </span>
                    )}
                  </div>
                )
              })}
            </Card>
          )}

          {section === 'Team' && (
            <Card padding={0}>
              <div className="px-5 pb-1 pt-5">
                <CardTitle
                  title="Team"
                  sub="Agents you can assign conversations and deals to"
                  right={
                    <Button size="sm" variant="primary" onClick={() => setAgentModal(true)}>
                      <IconPlus size={12} /> Add agent
                    </Button>
                  }
                />
              </div>

              <div
                className="mx-5 mb-3 rounded-lg px-3 py-2 text-[12px] leading-relaxed"
                style={{ background: 'var(--w-infotint)', color: '#1D4ED8' }}
              >
                Agents are assignment labels in this release — they route work and appear in reports, but they do
                not have their own logins yet. Separate seats with roles and permissions are the next step.
              </div>

              <Table>
                <thead>
                  <tr>
                    <Th>Agent</Th>
                    <Th>Role</Th>
                    <Th>Languages</Th>
                    <Th>Status</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {data.agents.map((a: any) => (
                    <tr key={a.id}>
                      <Td>
                        <span className="font-medium">{a.name}</span>
                        {a.email && (
                          <span className="block text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                            {a.email}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Pill tone={a.role === 'owner' ? 'green' : 'gray'}>{a.role}</Pill>
                      </Td>
                      <Td>{(a.languages ?? []).join(', ')}</Td>
                      <Td>
                        <Pill tone={a.status === 'online' ? 'green' : 'gray'}>{a.status}</Pill>
                      </Td>
                      <Td align="right">
                        {!a.is_self && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              if (!confirm(`Remove ${a.name}? Their conversations become unassigned.`)) return
                              await fetch(`/api/agents?id=${a.id}`, { method: 'DELETE' })
                              toast('Agent removed')
                              load()
                            }}
                          >
                            <IconTrash size={13} />
                          </Button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          {section === 'Canned replies' && (
            <Card padding={0}>
              <div className="px-5 pb-1 pt-5">
                <CardTitle
                  title="Canned replies"
                  sub='Type "/" in the composer to insert one'
                  right={
                    <Button size="sm" variant="primary" onClick={() => setCannedModal({})}>
                      <IconPlus size={12} /> Add reply
                    </Button>
                  }
                />
              </div>
              {data.cannedReplies.length === 0 ? (
                <div className="px-5 pb-5 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                  None yet. Add shortcuts like <b>/envio</b> or <b>/gracias</b> for the answers you repeat most.
                </div>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Shortcut</Th>
                      <Th>Message</Th>
                      <Th align="right">Used</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cannedReplies.map((c: any) => (
                      <tr key={c.id} className="cursor-pointer" onClick={() => setCannedModal(c)}>
                        <Td style={{ fontFamily: "'JetBrains Mono', monospace", color: '#16A34A', fontWeight: 600 }}>
                          /{c.shortcut}
                        </Td>
                        <Td style={{ color: 'var(--w-muted)' }}>{c.body}</Td>
                        <Td align="right">{c.usage_count}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}

          {section === 'Suppression list' && (
            <Card padding={0}>
              <div className="px-5 pb-1 pt-5">
                <CardTitle
                  title="Suppression list"
                  sub="These numbers never receive marketing, regardless of segment or campaign"
                />
              </div>
              {data.suppression.length === 0 ? (
                <div className="px-5 pb-5 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                  Empty. Anyone who sends STOP, BAJA, PARAR or UNSUBSCRIBE lands here automatically.
                </div>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Phone</Th>
                      <Th>Reason</Th>
                      <Th>Keyword</Th>
                      <Th align="right">Added</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.suppression.map((s: any) => (
                      <tr key={s.id}>
                        <Td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                          {formatPhone(s.phone)}
                        </Td>
                        <Td>{s.reason}</Td>
                        <Td style={{ color: 'var(--w-muted)' }}>{s.keyword || '—'}</Td>
                        <Td align="right" style={{ color: 'var(--w-muted)' }}>
                          {relTime(s.created_at)}
                        </Td>
                        <Td align="right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              if (!confirm('Remove from the suppression list? Only do this with explicit consent.'))
                                return
                              await fetch(`/api/suppression?id=${s.id}`, { method: 'DELETE' })
                              toast('Removed from suppression list')
                              load()
                            }}
                          >
                            <IconTrash size={13} />
                          </Button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}
        </>
      )}

      {agentModal && (
        <AgentModal
          onClose={() => setAgentModal(false)}
          onSaved={() => {
            setAgentModal(false)
            load()
            toast('Agent added')
          }}
        />
      )}

      {cannedModal && (
        <CannedModal
          reply={cannedModal}
          onClose={() => setCannedModal(null)}
          onSaved={() => {
            setCannedModal(null)
            load()
            toast('Canned reply saved')
          }}
        />
      )}
    </Page>
  )
}

function AgentModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', role: 'agent', languages: 'es' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          languages: form.languages.split(',').map((s) => s.trim()).filter(Boolean),
        }),
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
      title="Add agent"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!form.name.trim()}>
            Add agent
          </Button>
        </>
      }
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Select label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="admin">Admin</option>
          <option value="agent">Agent</option>
          <option value="viewer">Viewer</option>
        </Select>
        <Input
          label="Languages"
          value={form.languages}
          onChange={(e) => setForm({ ...form, languages: e.target.value })}
          placeholder="es, en"
        />
      </div>
      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}

function CannedModal({ reply, onClose, onSaved }: { reply: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ shortcut: reply.shortcut ?? '', body: reply.body ?? '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/canned-replies', {
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
      title={reply.id ? 'Edit canned reply' : 'New canned reply'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!form.shortcut.trim() || !form.body.trim()}>
            Save
          </Button>
        </>
      }
    >
      <Input
        label="Shortcut"
        value={form.shortcut}
        onChange={(e) => setForm({ ...form, shortcut: e.target.value.replace(/^\//, '') })}
        placeholder="envio"
        hint="Typed in the composer as /envio"
        className="mb-3"
      />
      <Textarea
        label="Message"
        value={form.body}
        rows={3}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
        placeholder="Enviamos en 24-48h a toda España. Envío gratis desde 50 €."
      />
      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}
