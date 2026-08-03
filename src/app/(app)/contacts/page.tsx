'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Button, Card, EmptyState, ErrorState, Input, Modal, Page, PageHeader, Pill, Select,
  Table, TableSkeleton, Td, Th, ToastProvider, money, num, relTime, shortDate, useToast,
} from '@/components/ui'
import {
  IconContacts, IconDownload, IconFilter, IconPlus, IconSearch, IconUpload, IconX,
} from '@/components/icons'
import { SegmentBuilder, emptyDefinition, useSegmentPreview, RfmPill } from '@/components/SegmentBuilder'
import { avatarColors, formatPhone, initialsOf } from '@/lib/phone'
import type { SegmentDefinition } from '@/lib/types'

export default function ContactsPage() {
  return (
    <ToastProvider>
      <Suspense fallback={null}>
        <ContactsScreen />
      </Suspense>
    </ToastProvider>
  )
}

function ContactsScreen() {
  const toast = useToast()
  const params = useSearchParams()

  const [rows, setRows] = useState<any[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [q, setQ] = useState(params.get('q') ?? '')
  const [segmentId, setSegmentId] = useState(params.get('segment') ?? '')
  const [tagId, setTagId] = useState('')
  const [error, setError] = useState('')

  const [tags, setTags] = useState<any[]>([])
  const [segments, setSegments] = useState<any[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [addOpen, setAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [adhoc, setAdhoc] = useState<SegmentDefinition | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const url = new URL('/api/contacts', window.location.origin)
      url.searchParams.set('page', String(page))
      if (q) url.searchParams.set('q', q)
      if (segmentId) url.searchParams.set('segment', segmentId)
      if (tagId) url.searchParams.set('tag', tagId)

      const res = await fetch(url, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setRows(json.contacts)
      setTotal(json.total)
    } catch (e: any) {
      setError(e.message)
      setRows([])
    }
  }, [page, q, segmentId, tagId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    Promise.all([
      fetch('/api/tags').then((r) => r.json()),
      fetch('/api/segments').then((r) => r.json()),
    ]).then(([t, s]) => {
      setTags(t.tags ?? [])
      setSegments(s.segments ?? [])
    })
  }, [])

  // Debounce the search box so typing does not fire a request per keystroke.
  const [searchInput, setSearchInput] = useState(q)
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput)
      setPage(0)
    }, 350)
    return () => clearTimeout(t)
  }, [searchInput])

  /**
   * Tags are created here, on demand. Nothing else in the app creates one, so
   * without this the tag dropdowns are a dead end on a new account: they hold
   * only the placeholder, and clicking does nothing.
   */
  async function createTag(): Promise<string | null> {
    const name = prompt('Name for the new tag')?.trim()
    if (!name) return null

    // The unique constraint is (user_id, name) and case-SENSITIVE, so "vip"
    // and "VIP" would both be accepted as separate tags. Reuse the existing
    // one instead — two tags that read the same are never what was meant.
    const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (existing) return existing.id

    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast(json.error ?? 'Could not create the tag', 'red')
      return null
    }
    // POST returns the raw row; GET adds a usage count. Normalise so the two
    // shapes stay interchangeable in state.
    const tag = { id: json.tag.id, name: json.tag.name, color: json.tag.color, count: 0 }
    setTags((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)))
    return tag.id as string
  }

  async function bulk(action: string, tag?: string) {
    const ids = [...selected]
    if (!ids.length) return
    if (action === 'delete' && !confirm(`Delete ${ids.length} contacts? This cannot be undone.`)) return

    const res = await fetch('/api/contacts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action, tag_id: tag }),
    })
    const json = await res.json()
    toast(res.ok ? `${ids.length} contacts updated` : json.error, res.ok ? 'green' : 'red')
    setSelected(new Set())
    load()
  }

  function exportCsv() {
    if (!rows?.length) return
    const header = ['name', 'phone', 'email', 'company', 'country', 'city', 'lifetime_spent', 'orders_count', 'opt_in_status', 'rfm_segment']
    const lines = [
      header.join(','),
      ...rows.map((r) =>
        header.map((h) => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')
      ),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `wasify-contacts-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    toast(`Exported ${rows.length} contacts from this page`)
  }

  const pages = Math.ceil(total / 50)

  return (
    <Page>
      <PageHeader
        title="Contacts"
        subtitle={
          rows
            ? `${num(total)} total${segmentId ? ` in "${segments.find((s) => s.id === segmentId)?.name ?? 'segment'}"` : ''}`
            : 'Loading…'
        }
        actions={
          <>
            <Button onClick={() => setImportOpen(true)}>
              <IconUpload size={13} /> Import CSV
            </Button>
            <Button onClick={exportCsv} disabled={!rows?.length}>
              <IconDownload size={13} /> Export
            </Button>
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <IconPlus size={14} /> Add contact
            </Button>
          </>
        }
      />

      {/* toolbar */}
      <Card padding={12} className="mb-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border px-3 py-[7px]"
            style={{ background: 'var(--w-canvas)', borderColor: 'var(--w-border)' }}
          >
            <IconSearch size={14} style={{ color: '#6B7280' }} />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search name, phone, email…"
              className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none"
            />
          </div>

          <select
            value={segmentId}
            onChange={(e) => {
              setSegmentId(e.target.value)
              setPage(0)
            }}
            className="cursor-pointer rounded-lg border px-2.5 py-[7px] text-[12.5px]"
            style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
          >
            <option value="">All segments</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.member_count})
              </option>
            ))}
          </select>

          <select
            value={tagId}
            onChange={(e) => {
              setTagId(e.target.value)
              setPage(0)
            }}
            className="cursor-pointer rounded-lg border px-2.5 py-[7px] text-[12.5px]"
            style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
          >
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <Button onClick={() => { setAdhoc(adhoc ? null : emptyDefinition()); setFilterOpen(!filterOpen) }}>
            <IconFilter size={13} /> Advanced filter
          </Button>
        </div>

        {filterOpen && adhoc && (
          <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--w-border)' }}>
            <AdhocFilter definition={adhoc} onChange={setAdhoc} tags={tags} onApplied={(ids) => {
              setRows(ids)
              setTotal(ids.length)
            }} />
          </div>
        )}
      </Card>

      {/* bulk bar */}
      {selected.size > 0 && (
        <Card padding={10} className="mb-3.5" style={{ background: 'var(--w-greentint)', borderColor: '#BBF7D0' }}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold" style={{ color: '#15803D' }}>
              {selected.size} selected
            </span>
            <select
              value=""
              onChange={async (e) => {
                const choice = e.target.value
                e.target.value = '' // a <select> that acts as a menu must not stay on its pick
                if (!choice) return
                const tagId = choice === '__new' ? await createTag() : choice
                if (tagId) bulk('tag', tagId)
              }}
              className="cursor-pointer rounded-lg border px-2 py-1 text-[12.5px]"
              style={{ background: '#fff', borderColor: '#BBF7D0' }}
            >
              <option value="">{tags.length ? 'Add tag…' : 'Add tag… (none yet)'}</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              <option value="__new">+ Create a new tag…</option>
            </select>
            <Button size="sm" onClick={() => bulk('opt_out')}>
              Mark opted out
            </Button>
            <Button size="sm" variant="danger" onClick={() => bulk('delete')}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} style={{ marginLeft: 'auto' }}>
              <IconX size={13} /> Clear
            </Button>
          </div>
        </Card>
      )}

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      <Card padding={0}>
        {!rows ? (
          <TableSkeleton rows={8} cols={7} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconContacts size={32} />}
            title={q || segmentId || tagId ? 'No contacts match' : 'No contacts yet'}
            body={
              q || segmentId || tagId
                ? 'Try a different search or clear the filters.'
                : 'Contacts appear automatically when someone messages your WhatsApp number or places a Shopify order. You can also import a CSV.'
            }
            action={
              !q && !segmentId && !tagId ? (
                <Button variant="primary" onClick={() => setImportOpen(true)}>
                  Import a CSV
                </Button>
              ) : null
            }
          />
        ) : (
          <Table minWidth={980}>
            <thead>
              <tr>
                <Th width={36}>
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && selected.size === rows.length}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                    }
                    className="cursor-pointer"
                    style={{ accentColor: '#16A34A' }}
                  />
                </Th>
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>Tags</Th>
                <Th align="right">Spent</Th>
                <Th align="right">Orders</Th>
                <Th>Last order</Th>
                <Th>Opt-in</Th>
                <Th>RFM</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const colors = avatarColors(c.phone)
                return (
                  <tr
                    key={c.id}
                    onClick={() => setDetailId(c.id)}
                    className="cursor-pointer"
                    style={{ background: selected.has(c.id) ? 'var(--w-greentint)' : undefined }}
                  >
                    <Td>
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev)
                            e.target.checked ? next.add(c.id) : next.delete(c.id)
                            return next
                          })
                        }
                        className="cursor-pointer"
                        style={{ accentColor: '#16A34A' }}
                      />
                    </Td>
                    <Td>
                      <span className="flex items-center gap-2">
                        <span
                          className="flex h-7 w-7 min-w-7 items-center justify-center rounded-full text-[11px] font-bold"
                          style={{ background: colors.bg, color: colors.fg }}
                        >
                          {initialsOf(c.name, c.phone)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{c.name || '—'}</span>
                          {c.email && (
                            <span className="block truncate text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                              {c.email}
                            </span>
                          )}
                        </span>
                      </span>
                    </Td>
                    <Td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                      {formatPhone(c.phone)}
                    </Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {(c.tags ?? []).slice(0, 3).map((t: any) => (
                          <span
                            key={t.id}
                            className="rounded-full px-1.5 py-px text-[10.5px] font-semibold"
                            style={{ background: 'var(--w-greentint)', color: '#16A34A' }}
                          >
                            {t.name}
                          </span>
                        ))}
                        {(c.tags ?? []).length > 3 && (
                          <span className="text-[10.5px]" style={{ color: 'var(--w-muted)' }}>
                            +{c.tags.length - 3}
                          </span>
                        )}
                      </span>
                    </Td>
                    <Td align="right" className="font-semibold">
                      {money(c.lifetime_spent)}
                    </Td>
                    <Td align="right">{c.orders_count}</Td>
                    <Td style={{ color: 'var(--w-muted)' }}>{c.last_order_at ? shortDate(c.last_order_at) : '—'}</Td>
                    <Td>
                      <Pill
                        tone={
                          c.opt_in_status === 'opted_in' ? 'green' : c.opt_in_status === 'opted_out' ? 'red' : 'gray'
                        }
                      >
                        {c.opt_in_status === 'opted_in' ? 'Opted in' : c.opt_in_status === 'opted_out' ? 'Opted out' : 'Unknown'}
                      </Pill>
                    </Td>
                    <Td>
                      <RfmPill tier={c.rfm_segment} />
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}

        {pages > 1 && (
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderTop: '1px solid var(--w-border)' }}
          >
            <span className="text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
              Page {page + 1} of {pages} · {num(total)} contacts
            </span>
            <div className="flex gap-1.5">
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {addOpen && (
        <AddContactModal
          tags={tags}
          onClose={() => setAddOpen(false)}
          onSaved={(merged) => {
            setAddOpen(false)
            toast(merged ? 'Matched an existing contact and updated it' : 'Contact added')
            load()
          }}
        />
      )}

      {importOpen && (
        <ImportModal
          tags={tags}
          onClose={() => setImportOpen(false)}
          onDone={(summary) => {
            toast(`${summary.created} added, ${summary.merged} merged, ${summary.skipped} skipped`)
            load()
          }}
        />
      )}

      {detailId && <ContactDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={load} />}
    </Page>
  )
}

/* ------------------------------------------------------------------ */

function AdhocFilter({
  definition,
  onChange,
  tags,
  onApplied,
}: {
  definition: SegmentDefinition
  onChange: (d: SegmentDefinition) => void
  tags: any[]
  onApplied: (contacts: any[]) => void
}) {
  const { count, loading } = useSegmentPreview(definition)

  async function apply() {
    const res = await fetch('/api/segments/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition }),
    })
    const json = await res.json()
    // The preview returns a capped sample; fetch the full match set for the table.
    onApplied(json.sample ?? [])
  }

  return (
    <>
      <SegmentBuilder definition={definition} onChange={onChange} tags={tags} />
      <div className="mt-3 flex items-center gap-3">
        <span className="text-[13px] font-semibold" style={{ color: '#16A34A' }}>
          {loading ? 'Counting…' : `${num(count ?? 0)} match`}
        </span>
        <Button size="sm" variant="primary" onClick={apply}>
          Show matches
        </Button>
        <span className="text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
          Save this as a segment to reuse it in a broadcast.
        </span>
      </div>
    </>
  )
}

function AddContactModal({
  tags,
  onClose,
  onSaved,
}: {
  tags: any[]
  onClose: () => void
  onSaved: (merged: boolean) => void
}) {
  const [form, setForm] = useState({ phone: '', name: '', email: '', company: '', country: '', city: '' })
  const [tagIds, setTagIds] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  async function save() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, tag_ids: tagIds }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error)
        return
      }
      onSaved(json.merged)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add contact"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!form.phone.trim()}>
            Save contact
          </Button>
        </>
      }
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Input
          label="Phone *"
          value={form.phone}
          onChange={set('phone')}
          placeholder="+34 600 123 456"
          hint="Include the country code"
        />
        <Input label="Name" value={form.name} onChange={set('name')} />
        <Input label="Email" type="email" value={form.email} onChange={set('email')} />
        <Input label="Company" value={form.company} onChange={set('company')} />
        <Input label="Country" value={form.country} onChange={set('country')} />
        <Input label="City" value={form.city} onChange={set('city')} />
      </div>

      {tags.length > 0 && (
        <div className="mt-3">
          <span className="mb-1.5 block text-[12.5px] font-medium">Tags</span>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => {
              const on = tagIds.includes(t.id)
              return (
                <button
                  key={t.id}
                  onClick={() => setTagIds((prev) => (on ? prev.filter((x) => x !== t.id) : [...prev, t.id]))}
                  className="cursor-pointer rounded-full border px-2.5 py-[3px] text-[12px] font-medium"
                  style={{
                    background: on ? 'var(--w-greentint)' : 'var(--w-card)',
                    color: on ? '#16A34A' : 'var(--w-muted)',
                    borderColor: on ? '#BBF7D0' : 'var(--w-border)',
                  }}
                >
                  {t.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}

const IMPORT_FIELDS = [
  { key: 'ignore', label: '— skip this column —' },
  { key: 'phone', label: 'Phone (required)' },
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'company', label: 'Company' },
  { key: 'country', label: 'Country' },
  { key: 'city', label: 'City' },
  { key: 'postcode', label: 'Postcode' },
  { key: 'locale', label: 'Language' },
  { key: 'tag', label: 'Tag (per row)' },
]

function ImportModal({
  tags,
  onClose,
  onDone,
}: {
  tags: any[]
  onClose: () => void
  onDone: (summary: { created: number; merged: number; skipped: number }) => void
}) {
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [tagAll, setTagAll] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState('')

  function parse(text: string) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    if (!lines.length) return

    const split = (line: string) => {
      const out: string[] = []
      let cur = ''
      let quoted = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
          if (quoted && line[i + 1] === '"') {
            cur += '"'
            i++
          } else quoted = !quoted
        } else if (ch === ',' && !quoted) {
          out.push(cur)
          cur = ''
        } else cur += ch
      }
      out.push(cur)
      return out.map((c) => c.trim())
    }

    const head = split(lines[0])
    const body = lines.slice(1).map((line) => {
      const cells = split(line)
      return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']))
    })

    setHeaders(head)
    setRows(body)

    // Guess the mapping from the header names.
    const guess: Record<string, string> = {}
    for (const h of head) {
      const key = h.toLowerCase().replace(/[^a-z]/g, '')
      if (['phone', 'telefono', 'mobile', 'whatsapp', 'movil'].some((k) => key.includes(k))) guess[h] = 'phone'
      else if (['name', 'nombre', 'fullname'].some((k) => key.includes(k))) guess[h] = 'name'
      else if (key.includes('email') || key.includes('correo')) guess[h] = 'email'
      else if (key.includes('company') || key.includes('empresa')) guess[h] = 'company'
      else if (key.includes('country') || key.includes('pais')) guess[h] = 'country'
      else if (key.includes('city') || key.includes('ciudad')) guess[h] = 'city'
      else if (key.includes('tag') || key.includes('etiqueta')) guess[h] = 'tag'
      else guess[h] = 'ignore'
    }
    setMapping(guess)
  }

  async function run() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, mapping, tag_ids: tagAll }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error)
        return
      }
      setResult(json)
      onDone(json)
    } finally {
      setBusy(false)
    }
  }

  const hasPhone = Object.values(mapping).includes('phone')

  return (
    <Modal
      open
      onClose={onClose}
      title="Import contacts from CSV"
      width={640}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={run} disabled={!rows.length || !hasPhone}>
              Import {rows.length ? `${num(rows.length)} rows` : ''}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {[
              ['Added', result.created, '#16A34A'],
              ['Merged', result.merged, '#2563EB'],
              ['Skipped', result.skipped, '#EF4444'],
            ].map(([label, value, color]) => (
              <div
                key={label as string}
                className="rounded-lg border p-3 text-center"
                style={{ borderColor: 'var(--w-border)', background: 'var(--w-card2)' }}
              >
                <div className="text-[22px] font-bold" style={{ color: color as string }}>
                  {num(value as number)}
                </div>
                <div className="text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                  {label as string}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
            Rows whose phone matched an existing contact were merged rather than duplicated.
          </div>

          {result.errors?.length > 0 && (
            <>
              <div className="mt-4 mb-1.5 text-[12.5px] font-semibold">Skipped rows</div>
              <div className="max-h-48 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--w-border)' }}>
                <Table>
                  <thead>
                    <tr>
                      <Th width={60}>Row</Th>
                      <Th>Phone</Th>
                      <Th>Reason</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((e: any, i: number) => (
                      <tr key={i}>
                        <Td>{e.row}</Td>
                        <Td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{e.phone || '—'}</Td>
                        <Td style={{ color: '#B91C1C' }}>{e.reason}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {rows.length === 0 ? (
            <label
              className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center"
              style={{ borderColor: 'var(--w-border)' }}
            >
              <IconUpload size={26} style={{ color: 'var(--w-muted)' }} />
              <span className="text-[13.5px] font-semibold">Choose a CSV file</span>
              <span className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
                Only <b>phone</b> is required. name, email, company, country, city and tag are optional.
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const reader = new FileReader()
                  reader.onload = () => parse(String(reader.result ?? ''))
                  reader.readAsText(file)
                }}
              />
            </label>
          ) : (
            <>
              <div className="mb-3 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                Found <b style={{ color: 'var(--w-text)' }}>{num(rows.length)}</b> rows. Map each column:
              </div>

              <div className="max-h-64 overflow-y-auto">
                {headers.map((h) => (
                  <div key={h} className="mb-2 flex items-center gap-2">
                    <span className="w-1/2 truncate text-[12.5px] font-medium">{h}</span>
                    <select
                      value={mapping[h] ?? 'ignore'}
                      onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}
                      className="w-1/2 cursor-pointer rounded-lg border px-2 py-1.5 text-[12.5px]"
                      style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                    >
                      {IMPORT_FIELDS.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {!hasPhone && (
                <div
                  className="mt-2 rounded-lg px-3 py-2 text-[12.5px]"
                  style={{ background: 'var(--w-ambertint)', color: '#92400E' }}
                >
                  Map one column to <b>Phone</b> to continue.
                </div>
              )}

              {tags.length > 0 && (
                <div className="mt-3">
                  <span className="mb-1.5 block text-[12.5px] font-medium">Tag every imported contact</span>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((t) => {
                      const on = tagAll.includes(t.id)
                      return (
                        <button
                          key={t.id}
                          onClick={() => setTagAll((p) => (on ? p.filter((x) => x !== t.id) : [...p, t.id]))}
                          className="cursor-pointer rounded-full border px-2.5 py-[3px] text-[12px] font-medium"
                          style={{
                            background: on ? 'var(--w-greentint)' : 'var(--w-card)',
                            color: on ? '#16A34A' : 'var(--w-muted)',
                            borderColor: on ? '#BBF7D0' : 'var(--w-border)',
                          }}
                        >
                          {t.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {error && (
            <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
              {error}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

function ContactDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast()
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    fetch(`/api/contacts/${id}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then(setData)
  }, [id])

  const c = data?.contact

  async function toggleOptIn() {
    const next = c.opt_in_status === 'opted_in' ? 'opted_out' : 'opted_in'
    await fetch(`/api/contacts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opt_in_status: next }),
    })
    toast(next === 'opted_in' ? 'Marked opted in' : 'Marked opted out')
    setData((d: any) => ({ ...d, contact: { ...d.contact, opt_in_status: next } }))
    onChanged()
  }

  return (
    <Modal open onClose={onClose} title={c?.name || 'Contact'} width={600}>
      {!data ? (
        <TableSkeleton rows={5} cols={2} />
      ) : (
        <>
          <div className="mb-4 grid gap-2" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {[
              ['Total spent', money(c.lifetime_spent)],
              ['Orders', String(c.orders_count)],
              ['AOV', money(c.avg_order_value)],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-lg border p-2.5"
                style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
              >
                <div className="text-[11px]" style={{ color: 'var(--w-muted)' }}>
                  {label}
                </div>
                <div className="text-[15px] font-bold">{value}</div>
              </div>
            ))}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>{formatPhone(c.phone)}</span>
            {c.email && <span className="text-[13px]">{c.email}</span>}
            <RfmPill tier={c.rfm_segment} />
            <Button size="sm" onClick={toggleOptIn} style={{ marginLeft: 'auto' }}>
              {c.opt_in_status === 'opted_in' ? 'Mark opted out' : 'Mark opted in'}
            </Button>
          </div>

          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[.05em]" style={{ color: 'var(--w-muted)' }}>
            Recent orders
          </div>
          {data.orders.length === 0 ? (
            <div className="mb-4 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
              No orders yet.
            </div>
          ) : (
            <div className="mb-4">
              {data.orders.slice(0, 5).map((o: any) => (
                <div
                  key={o.id}
                  className="flex justify-between py-1.5 text-[12.5px]"
                  style={{ borderBottom: '1px solid var(--w-border)' }}
                >
                  <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {o.order_number || o.shopify_order_id}
                  </span>
                  <span>
                    {money(o.total_price, o.currency)} · {shortDate(o.shopify_created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[.05em]" style={{ color: 'var(--w-muted)' }}>
            Consent log
          </div>
          {data.consent.length === 0 ? (
            <div className="text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
              No consent events recorded.
            </div>
          ) : (
            data.consent.map((e: any) => (
              <div key={e.id} className="py-1 text-[12.5px]">
                <b>{e.event === 'opt_in' ? '✓ Opted in' : '✕ Opted out'}</b> · {e.source ?? 'unknown'} ·{' '}
                <span style={{ color: 'var(--w-muted)' }}>{relTime(e.created_at)}</span>
              </div>
            ))
          )}
        </>
      )}
    </Modal>
  )
}
