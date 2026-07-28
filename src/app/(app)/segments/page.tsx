'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Button, Card, EmptyState, ErrorState, Input, Modal, Page, PageHeader, Pill, Skeleton,
  Table, Td, Th, Textarea, Toggle, ToastProvider, money, num, relTime, useToast,
} from '@/components/ui'
import { IconPlus, IconRefresh, IconSegments, IconTrash } from '@/components/icons'
import { SegmentBuilder, emptyDefinition, useSegmentPreview, RfmPill } from '@/components/SegmentBuilder'
import type { Segment, SegmentDefinition } from '@/lib/types'

export default function SegmentsPage() {
  return (
    <ToastProvider>
      <SegmentsScreen />
    </ToastProvider>
  )
}

function SegmentsScreen() {
  const toast = useToast()
  const [segments, setSegments] = useState<Segment[] | null>(null)
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Segment | 'new' | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [segRes, tagRes] = await Promise.all([
        fetch('/api/segments', { cache: 'no-store' }),
        fetch('/api/tags', { cache: 'no-store' }),
      ])
      const segJson = await segRes.json()
      if (!segRes.ok) throw new Error(segJson.error)
      setSegments(segJson.segments)
      setTags((await tagRes.json()).tags ?? [])
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function remove(id: string) {
    if (!confirm('Delete this segment? Contacts are not affected.')) return
    await fetch(`/api/segments/${id}`, { method: 'DELETE' })
    toast('Segment deleted')
    load()
  }

  async function refresh(id: string) {
    const res = await fetch(`/api/segments/${id}/refresh`, { method: 'POST' })
    const json = await res.json()
    toast(res.ok ? `Recomputed — ${num(json.member_count)} contacts match` : json.error, res.ok ? 'green' : 'red')
    load()
  }

  return (
    <Page>
      <PageHeader
        title="Segments"
        subtitle="Build dynamic audiences from contact, order and WhatsApp data"
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <IconPlus size={14} /> New segment
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      {!segments && (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} h={120} />
          ))}
        </div>
      )}

      {segments?.length === 0 && (
        <Card>
          <EmptyState
            icon={<IconSegments size={32} />}
            title="No segments yet"
            body="Segments are saved filters that stay up to date on their own. Use them to target broadcasts — for example, customers who spent over €250 and haven't ordered in 60 days."
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                Create your first segment
              </Button>
            }
          />
        </Card>
      )}

      {segments && segments.length > 0 && (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))' }}>
          {segments.map((s) => (
            <Card key={s.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color ?? '#16A34A' }} />
                    <span className="truncate text-[14.5px] font-semibold">{s.name}</span>
                  </div>
                  {s.description && (
                    <div className="mt-1 line-clamp-2 text-[12px]" style={{ color: 'var(--w-muted)' }}>
                      {s.description}
                    </div>
                  )}
                </div>
                <Pill tone={s.is_dynamic ? 'green' : 'gray'}>{s.is_dynamic ? 'Dynamic' : 'Static'}</Pill>
              </div>

              <div className="mt-3 text-[24px] font-bold tracking-[-0.02em]">{num(s.member_count)}</div>
              <div className="text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                contacts match
                {s.last_computed_at ? ` · updated ${relTime(s.last_computed_at)}` : ''}
              </div>

              <div className="mt-3 flex gap-1.5">
                <Button size="sm" onClick={() => setEditing(s)}>
                  Edit
                </Button>
                <Button size="sm" onClick={() => refresh(s.id)}>
                  <IconRefresh size={12} /> Recount
                </Button>
                <a href={`/contacts?segment=${s.id}`} className="no-underline">
                  <Button size="sm">View contacts</Button>
                </a>
                <Button size="sm" variant="ghost" onClick={() => remove(s.id)} style={{ marginLeft: 'auto' }}>
                  <IconTrash size={13} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-4">
        <div className="text-[14.5px] font-semibold">RFM auto-segmentation</div>
        <div className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--w-muted)' }}>
          Recency, Frequency and Monetary scores are recomputed for every customer each night by the daily
          cron, then bucketed into tiers you can filter on. Use the <b>RFM tier</b> field in any segment.
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {['champion', 'loyal', 'potential', 'new', 'at_risk', 'cant_lose', 'hibernating', 'needs_attention'].map(
            (t) => (
              <RfmPill key={t} tier={t} />
            )
          )}
        </div>
      </Card>

      {editing && (
        <SegmentEditor
          segment={editing === 'new' ? null : editing}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
            toast('Segment saved')
          }}
        />
      )}
    </Page>
  )
}

function SegmentEditor({
  segment,
  tags,
  onClose,
  onSaved,
}: {
  segment: Segment | null
  tags: Array<{ id: string; name: string }>
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(segment?.name ?? '')
  const [description, setDescription] = useState(segment?.description ?? '')
  const [isDynamic, setIsDynamic] = useState(segment?.is_dynamic ?? true)
  const [definition, setDefinition] = useState<SegmentDefinition>(segment?.definition ?? emptyDefinition())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const { count, sample, loading } = useSegmentPreview(definition)

  async function save() {
    setError('')
    setSaving(true)
    try {
      const res = await fetch(segment ? `/api/segments/${segment.id}` : '/api/segments', {
        method: segment ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, definition, is_dynamic: isDynamic }),
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

  return (
    <Modal
      open
      onClose={onClose}
      title={segment ? `Edit "${segment.name}"` : 'New segment'}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save} disabled={!name.trim()}>
            Save segment
          </Button>
        </>
      }
    >
      <div className="mb-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="VIP Spain" />
        <div className="flex items-end pb-1">
          <Toggle
            checked={isDynamic}
            onChange={setIsDynamic}
            label="Dynamic"
            sub={isDynamic ? 'Updates automatically' : 'Fixed list, refreshed nightly'}
          />
        </div>
      </div>

      <Textarea
        label="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        className="mb-4"
      />

      <div className="mb-2 text-[11px] font-bold uppercase tracking-[.05em]" style={{ color: 'var(--w-muted)' }}>
        Conditions
      </div>
      <SegmentBuilder definition={definition} onChange={setDefinition} tags={tags} />

      <div
        className="mt-4 rounded-[10px] border p-3"
        style={{ background: 'var(--w-greentint)', borderColor: '#BBF7D0' }}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-[20px] font-bold" style={{ color: '#15803D' }}>
            {loading ? '…' : num(count ?? 0)}
          </span>
          <span className="text-[12.5px]" style={{ color: '#15803D' }}>
            contacts match right now
          </span>
        </div>

        {sample.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {sample.slice(0, 8).map((c: any) => (
              <span
                key={c.id}
                className="rounded-full px-2 py-[2px] text-[11px]"
                style={{ background: '#fff', color: '#15803D' }}
              >
                {c.name || `+${c.phone}`}
              </span>
            ))}
            {(count ?? 0) > 8 && (
              <span className="text-[11px]" style={{ color: '#15803D' }}>
                +{num((count ?? 0) - 8)} more
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}
