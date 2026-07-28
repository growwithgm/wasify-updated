'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, Card, EmptyState, ErrorState, Input, Modal, Page, PageHeader, Pill, Select,
  Skeleton, Textarea, ToastProvider, num, relTime, useToast,
} from '@/components/ui'
import { IconPlus, IconRefresh, IconTemplates, IconTrash, IconX } from '@/components/icons'
import type { MessageTemplate, TemplateButton } from '@/lib/types'

const STATUS_TONE: Record<string, any> = {
  APPROVED: 'green',
  PENDING: 'amber',
  REJECTED: 'red',
  DRAFT: 'gray',
  PAUSED: 'amber',
  DISABLED: 'gray',
}

export default function TemplatesPage() {
  return (
    <ToastProvider>
      <TemplatesScreen />
    </ToastProvider>
  )
}

function TemplatesScreen() {
  const toast = useToast()
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [editing, setEditing] = useState<MessageTemplate | 'new' | null>(null)
  const [filter, setFilter] = useState('ALL')

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/templates', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setTemplates(json.templates)
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function sync() {
    setSyncing(true)
    try {
      const res = await fetch('/api/templates/sync', { method: 'POST' })
      const json = await res.json()
      toast(
        res.ok ? `Synced ${json.imported} templates from Meta` : json.error,
        res.ok ? 'green' : 'red'
      )
      if (res.ok) load()
    } finally {
      setSyncing(false)
    }
  }

  async function remove(t: MessageTemplate) {
    if (!confirm(`Delete "${t.name}"?`)) return
    const res = await fetch(`/api/templates/${t.id}`, { method: 'DELETE' })
    const json = await res.json()
    toast(res.ok ? 'Template deleted' : json.error, res.ok ? 'green' : 'red')
    load()
  }

  async function submit(t: MessageTemplate) {
    const res = await fetch(`/api/templates/${t.id}/submit`, { method: 'POST' })
    const json = await res.json()
    toast(res.ok ? 'Submitted to Meta for review' : json.error, res.ok ? 'green' : 'red')
    load()
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: templates?.length ?? 0 }
    for (const t of templates ?? []) c[t.status] = (c[t.status] ?? 0) + 1
    return c
  }, [templates])

  const visible = (templates ?? []).filter((t) => filter === 'ALL' || t.status === filter)

  return (
    <Page>
      <PageHeader
        title="Templates"
        subtitle="Meta-approved message templates — only Approved templates can be sent"
        actions={
          <>
            <Button onClick={sync} loading={syncing}>
              <IconRefresh size={13} /> Sync from Meta
            </Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              <IconPlus size={14} /> New template
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      <div className="mb-3.5 flex flex-wrap gap-1.5">
        {['ALL', 'APPROVED', 'PENDING', 'DRAFT', 'REJECTED'].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className="cursor-pointer rounded-full border px-3 py-1 text-[12px] font-medium"
            style={{
              background: filter === s ? '#16A34A' : 'var(--w-card)',
              color: filter === s ? '#fff' : 'var(--w-muted)',
              borderColor: filter === s ? '#16A34A' : 'var(--w-border)',
            }}
          >
            {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
            {counts[s] ? ` (${counts[s]})` : ''}
          </button>
        ))}
      </div>

      {!templates && (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} h={150} />
          ))}
        </div>
      )}

      {templates && visible.length === 0 && (
        <Card>
          <EmptyState
            icon={<IconTemplates size={32} />}
            title={templates.length === 0 ? 'No templates yet' : 'Nothing in this filter'}
            body={
              templates.length === 0
                ? 'Templates are the only way to message a customer outside the 24-hour window. Sync the ones you already have in Meta, or draft a new one here and submit it for review.'
                : 'Try another status filter.'
            }
            action={
              templates.length === 0 ? (
                <div className="flex gap-2">
                  <Button onClick={sync} loading={syncing}>
                    Sync from Meta
                  </Button>
                  <Button variant="primary" onClick={() => setEditing('new')}>
                    Create a template
                  </Button>
                </div>
              ) : null
            }
          />
        </Card>
      )}

      {visible.length > 0 && (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))' }}>
          {visible.map((t) => (
            <Card key={t.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div
                    className="truncate text-[13.5px] font-bold"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {t.name}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                    <span>{t.category}</span>·<span>{t.language}</span>
                    {t.usage_count > 0 && <>·<span>{num(t.usage_count)} sends</span></>}
                  </div>
                </div>
                <Pill tone={STATUS_TONE[t.status] ?? 'gray'}>{t.status}</Pill>
              </div>

              <div
                className="mt-3 rounded-lg p-2.5 text-[12.5px] leading-relaxed"
                style={{ background: 'var(--w-bubble-out)', color: '#111827' }}
              >
                {t.header_text && <div className="mb-1 font-bold">{t.header_text}</div>}
                <div className="whitespace-pre-wrap">{t.body_text || '—'}</div>
                {t.footer_text && (
                  <div className="mt-1 text-[11px]" style={{ opacity: 0.65 }}>
                    {t.footer_text}
                  </div>
                )}
                {(t.buttons ?? []).length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    {(t.buttons as TemplateButton[]).map((b, i) => (
                      <div
                        key={i}
                        className="rounded-md py-1 text-center text-[12px] font-semibold"
                        style={{ background: '#fff', color: '#2563EB' }}
                      >
                        {b.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {t.status === 'REJECTED' && t.rejected_reason && (
                <div
                  className="mt-2 rounded-lg px-2.5 py-1.5 text-[11.5px]"
                  style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}
                >
                  ✕ Rejected: {t.rejected_reason}
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button size="sm" onClick={() => setEditing(t)}>
                  {t.status === 'APPROVED' ? 'View' : 'Edit'}
                </Button>
                {(t.status === 'DRAFT' || t.status === 'REJECTED') && (
                  <Button size="sm" variant="primary" onClick={() => submit(t)}>
                    Submit to Meta
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => remove(t)} style={{ marginLeft: 'auto' }}>
                  <IconTrash size={13} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <TemplateBuilder
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
            toast('Template saved as a draft')
          }}
        />
      )}
    </Page>
  )
}

/* ------------------------------------------------------------------ */

const BLANK = {
  name: '',
  language: 'es',
  category: 'MARKETING',
  header_type: 'none',
  header_text: '',
  body_text: '',
  footer_text: '',
  buttons: [] as TemplateButton[],
  sample_values: { body: [] as string[], header: [] as string[] },
}

function TemplateBuilder({
  template,
  onClose,
  onSaved,
}: {
  template: MessageTemplate | null
  onClose: () => void
  onSaved: () => void
}) {
  const readOnly = template?.status === 'APPROVED' || template?.status === 'PENDING'

  const [form, setForm] = useState<any>(
    template
      ? {
          ...BLANK,
          ...template,
          header_text: template.header_text ?? '',
          footer_text: template.footer_text ?? '',
          sample_values: template.sample_values ?? { body: [], header: [] },
        }
      : BLANK
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }))

  const bodyVars = useMemo(() => {
    const found = [...(form.body_text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
    return found.length ? Math.max(...found) : 0
  }, [form.body_text])

  const preview = useMemo(
    () =>
      (form.body_text ?? '').replace(
        /\{\{(\d+)\}\}/g,
        (_m: string, n: string) => form.sample_values?.body?.[Number(n) - 1] || `{{${n}}}`
      ),
    [form.body_text, form.sample_values]
  )

  async function save() {
    setError('')
    setSaving(true)
    try {
      const res = await fetch('/api/templates', {
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
      setSaving(false)
    }
  }

  function addButton(kind: TemplateButton['kind']) {
    set('buttons', [...(form.buttons ?? []), { kind, text: '', url: kind === 'url' ? '' : undefined }])
  }

  function updateButton(i: number, patch: Partial<TemplateButton>) {
    set(
      'buttons',
      (form.buttons ?? []).map((b: TemplateButton, j: number) => (j === i ? { ...b, ...patch } : b))
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={template ? `Template "${template.name}"` : 'New template'}
      width={780}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={save} disabled={!form.name || !form.body_text}>
              Save draft
            </Button>
          </>
        )
      }
    >
      {readOnly && (
        <div
          className="mb-3 rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--w-infotint)', color: '#1D4ED8' }}
        >
          This template is {template!.status.toLowerCase()} in Meta and cannot be edited here. Change it in Meta
          Business Manager, then sync again.
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: '1.3fr 1fr' }}>
        {/* editor */}
        <div>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: '1fr 90px' }}>
            <Input
              label="Template name"
              value={form.name}
              disabled={readOnly || !!template}
              onChange={(e) => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
              placeholder="winback_45d_es"
              hint="lowercase, numbers and underscores only"
            />
            <Select label="Language" value={form.language} disabled={readOnly} onChange={(e) => set('language', e.target.value)}>
              <option value="es">es</option>
              <option value="en">en</option>
              <option value="en_US">en_US</option>
              <option value="pt_BR">pt_BR</option>
              <option value="fr">fr</option>
            </Select>
          </div>

          <div className="mt-2.5">
            <span className="mb-1.5 block text-[12.5px] font-medium">Category</span>
            <div className="flex gap-1.5">
              {['MARKETING', 'UTILITY', 'AUTHENTICATION'].map((c) => (
                <button
                  key={c}
                  disabled={readOnly}
                  onClick={() => set('category', c)}
                  className="cursor-pointer rounded-lg border px-2.5 py-1.5 text-[12px] font-medium disabled:cursor-not-allowed"
                  style={{
                    background: form.category === c ? 'var(--w-greentint)' : 'var(--w-card)',
                    color: form.category === c ? '#16A34A' : 'var(--w-muted)',
                    borderColor: form.category === c ? '#BBF7D0' : 'var(--w-border)',
                  }}
                >
                  {c.charAt(0) + c.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-2.5 grid gap-2.5" style={{ gridTemplateColumns: '110px 1fr' }}>
            <Select label="Header" value={form.header_type} disabled={readOnly} onChange={(e) => set('header_type', e.target.value)}>
              <option value="none">None</option>
              <option value="text">Text</option>
              <option value="image">Image</option>
              <option value="document">Document</option>
              <option value="video">Video</option>
            </Select>
            {form.header_type === 'text' && (
              <Input
                label={`Header text (${(form.header_text ?? '').length}/60)`}
                value={form.header_text}
                disabled={readOnly}
                maxLength={60}
                onChange={(e) => set('header_text', e.target.value)}
              />
            )}
          </div>

          <Textarea
            label="Body"
            counter={`${(form.body_text ?? '').length}/1024`}
            value={form.body_text}
            disabled={readOnly}
            rows={5}
            maxLength={1024}
            className="mt-2.5"
            onChange={(e) => set('body_text', e.target.value)}
            hint="Use {{1}}, {{2}} for variables. Meta rejects a body that starts or ends with a variable."
          />

          {bodyVars > 0 && (
            <div className="mt-2.5">
              <span className="mb-1.5 block text-[12.5px] font-medium">
                Sample values (required by Meta)
              </span>
              {Array.from({ length: bodyVars }).map((_, i) => (
                <input
                  key={i}
                  value={form.sample_values?.body?.[i] ?? ''}
                  disabled={readOnly}
                  placeholder={`Example for {{${i + 1}}}`}
                  onChange={(e) => {
                    const body = [...(form.sample_values?.body ?? [])]
                    body[i] = e.target.value
                    set('sample_values', { ...form.sample_values, body })
                  }}
                  className="mb-1.5 w-full rounded-lg border px-2.5 py-1.5 text-[12.5px] outline-none"
                  style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                />
              ))}
            </div>
          )}

          <Input
            label={`Footer (${(form.footer_text ?? '').length}/60)`}
            value={form.footer_text}
            disabled={readOnly}
            maxLength={60}
            className="mt-2.5"
            onChange={(e) => set('footer_text', e.target.value)}
          />

          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[12.5px] font-medium">Buttons</span>
              {!readOnly && (
                <div className="flex gap-1">
                  <Button size="sm" onClick={() => addButton('quick_reply')}>
                    + Quick reply
                  </Button>
                  <Button size="sm" onClick={() => addButton('url')}>
                    + URL
                  </Button>
                  <Button size="sm" onClick={() => addButton('phone')}>
                    + Phone
                  </Button>
                </div>
              )}
            </div>

            {(form.buttons ?? []).map((b: TemplateButton, i: number) => (
              <div key={i} className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <span
                  className="rounded px-1.5 py-0.5 text-[10.5px] font-bold uppercase"
                  style={{ background: 'var(--w-card2)', color: 'var(--w-muted)' }}
                >
                  {b.kind.replace('_', ' ')}
                </span>
                <input
                  value={b.text}
                  disabled={readOnly}
                  placeholder="Button text"
                  maxLength={25}
                  onChange={(e) => updateButton(i, { text: e.target.value })}
                  className="min-w-0 flex-1 rounded-lg border px-2 py-1 text-[12.5px] outline-none"
                  style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                />
                {b.kind === 'url' && (
                  <input
                    value={b.url ?? ''}
                    disabled={readOnly}
                    placeholder="https://store.com/{{1}}"
                    onChange={(e) => updateButton(i, { url: e.target.value, dynamic: e.target.value.includes('{{1}}') })}
                    className="min-w-0 flex-1 rounded-lg border px-2 py-1 text-[12px] outline-none"
                    style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                  />
                )}
                {b.kind === 'phone' && (
                  <input
                    value={b.phone ?? ''}
                    disabled={readOnly}
                    placeholder="+34600123456"
                    onChange={(e) => updateButton(i, { phone: e.target.value })}
                    className="w-36 rounded-lg border px-2 py-1 text-[12px] outline-none"
                    style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                  />
                )}
                {!readOnly && (
                  <button
                    onClick={() => set('buttons', form.buttons.filter((_: any, j: number) => j !== i))}
                    className="cursor-pointer border-0 bg-transparent p-1"
                    style={{ color: 'var(--w-muted)' }}
                  >
                    <IconX size={14} />
                  </button>
                )}
              </div>
            ))}

            {(form.buttons ?? []).some((b: TemplateButton) => b.kind === 'url' && b.dynamic) && (
              <div
                className="mt-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] leading-relaxed"
                style={{ background: 'var(--w-ambertint)', color: '#92400E' }}
              >
                Dynamic URL: Meta appends only a <b>suffix</b> to the base you set here. Wasify sends the
                path+query of the cart URL as {`{{1}}`}. Make sure Meta saves it as a <b>Dynamic</b> URL — a
                literal &quot;{`{{1}}`}&quot; stored as static text will never substitute.
              </div>
            )}
          </div>
        </div>

        {/* live WhatsApp preview */}
        <div>
          <div className="mb-1.5 text-[12.5px] font-medium">Live WhatsApp preview</div>
          <div className="w-chat-canvas rounded-xl p-3.5" style={{ minHeight: 240 }}>
            <div
              className="wbubout ml-auto max-w-[95%] rounded-[10px] px-2.5 py-2"
              style={{ background: 'var(--w-bubble-out)', color: '#111827', boxShadow: '0 1px 1px rgba(0,0,0,.08)' }}
            >
              {form.header_type === 'text' && form.header_text && (
                <div className="mb-1 text-[13px] font-bold">{form.header_text}</div>
              )}
              {form.header_type !== 'none' && form.header_type !== 'text' && (
                <div
                  className="mb-1.5 flex h-20 items-center justify-center rounded-md text-[11px]"
                  style={{ background: 'rgba(0,0,0,.06)', color: '#6B7280' }}
                >
                  {form.header_type} header
                </div>
              )}
              <div className="whitespace-pre-wrap text-[13px] leading-snug">{preview || 'Your message…'}</div>
              {form.footer_text && (
                <div className="mt-1 text-[11px]" style={{ opacity: 0.6 }}>
                  {form.footer_text}
                </div>
              )}
              <div className="mt-1 text-right text-[10.5px]" style={{ opacity: 0.6 }}>
                12:34 ✓✓
              </div>
            </div>

            {(form.buttons ?? []).length > 0 && (
              <div className="ml-auto mt-1 flex max-w-[95%] flex-col gap-1">
                {(form.buttons as TemplateButton[]).map((b, i) => (
                  <div
                    key={i}
                    className="rounded-[10px] py-1.5 text-center text-[12.5px] font-semibold"
                    style={{ background: 'var(--w-bubble-out)', color: '#2563EB' }}
                  >
                    {b.text || 'Button'}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--w-muted)' }}>
            Saving stores a local draft. <b>Submit to Meta</b> sends it for review — approval usually takes
            minutes but can take up to 24 hours. Only <b>Approved</b> templates can be sent from the inbox,
            broadcasts or flows.
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}
