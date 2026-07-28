'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Pill } from '@/components/ui'
import { IconPlus, IconX } from '@/components/icons'
import type { SegmentCondition, SegmentDefinition, SegmentGroup } from '@/lib/types'

/**
 * Nested condition builder shared by the Segments screen and the Contacts
 * filter bar. Emits the same `SegmentDefinition` shape that
 * lib/engines/segments.ts evaluates, so the preview count and the eventual
 * broadcast audience can never disagree.
 */

export const FIELDS = [
  { key: 'total_spent', label: 'Total spent', type: 'number' },
  { key: 'orders_count', label: 'Order count', type: 'number' },
  { key: 'avg_order_value', label: 'Average order value', type: 'number' },
  { key: 'days_since_last_order', label: 'Days since last order', type: 'number' },
  { key: 'days_since_created', label: 'Days since added', type: 'number' },
  { key: 'has_tag', label: 'Has tag', type: 'tag' },
  { key: 'not_has_tag', label: "Doesn't have tag", type: 'tag' },
  { key: 'accepts_marketing', label: 'Accepts marketing', type: 'boolean' },
  { key: 'opt_in_status', label: 'Opt-in status', type: 'enum', options: ['opted_in', 'opted_out', 'unknown'] },
  { key: 'rfm_segment', label: 'RFM tier', type: 'enum', options: ['champion', 'loyal', 'new', 'potential', 'at_risk', 'cant_lose', 'hibernating', 'needs_attention'] },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'postcode', label: 'Postcode', type: 'text' },
  { key: 'locale', label: 'Language', type: 'text' },
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'source', label: 'Source', type: 'enum', options: ['shopify', 'whatsapp', 'csv', 'manual', 'api'] },
  { key: 'bought_product', label: 'Bought product / SKU', type: 'text' },
  { key: 'replied_within_hours', label: 'Replied within X hours', type: 'number' },
] as const

const OPERATORS: Record<string, Array<{ key: string; label: string }>> = {
  number: [
    { key: 'gte', label: '≥' },
    { key: 'gt', label: '>' },
    { key: 'lte', label: '≤' },
    { key: 'lt', label: '<' },
    { key: 'eq', label: 'is' },
    { key: 'neq', label: 'is not' },
  ],
  text: [
    { key: 'contains', label: 'contains' },
    { key: 'not_contains', label: 'does not contain' },
    { key: 'eq', label: 'is' },
    { key: 'neq', label: 'is not' },
    { key: 'is_set', label: 'is set' },
    { key: 'is_not_set', label: 'is empty' },
  ],
  enum: [
    { key: 'eq', label: 'is' },
    { key: 'neq', label: 'is not' },
  ],
  boolean: [{ key: 'eq', label: 'is' }],
  tag: [{ key: 'eq', label: 'is' }],
}

export function emptyDefinition(): SegmentDefinition {
  return { op: 'and', groups: [{ op: 'and', conditions: [{ field: 'total_spent', operator: 'gte', value: '' }] }] }
}

function fieldMeta(key: string) {
  return FIELDS.find((f) => f.key === key) ?? FIELDS[0]
}

export function SegmentBuilder({
  definition,
  onChange,
  tags,
}: {
  definition: SegmentDefinition
  onChange: (next: SegmentDefinition) => void
  tags: Array<{ id: string; name: string }>
}) {
  const setGroup = (index: number, group: SegmentGroup) => {
    const groups = [...definition.groups]
    groups[index] = group
    onChange({ ...definition, groups })
  }

  const removeGroup = (index: number) => {
    onChange({ ...definition, groups: definition.groups.filter((_, i) => i !== index) })
  }

  return (
    <div className="flex flex-col gap-2.5">
      {definition.groups.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && (
            <div className="my-1.5 flex items-center gap-2">
              <button
                onClick={() => onChange({ ...definition, op: definition.op === 'and' ? 'or' : 'and' })}
                className="cursor-pointer rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase"
                style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
              >
                {definition.op}
              </button>
              <div className="h-px flex-1" style={{ background: 'var(--w-border)' }} />
            </div>
          )}

          <div
            className="rounded-[10px] border p-3"
            style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-[.05em]" style={{ color: 'var(--w-muted)' }}>
                Group — match{' '}
                <button
                  onClick={() => setGroup(gi, { ...group, op: group.op === 'and' ? 'or' : 'and' })}
                  className="cursor-pointer rounded border-0 px-1.5 py-0.5 text-[11px] font-bold"
                  style={{ background: 'var(--w-greentint)', color: '#16A34A' }}
                >
                  {group.op === 'and' ? 'ALL' : 'ANY'}
                </button>{' '}
                of:
              </span>
              {definition.groups.length > 1 && (
                <button
                  onClick={() => removeGroup(gi)}
                  className="cursor-pointer border-0 bg-transparent p-0.5"
                  style={{ color: 'var(--w-muted)' }}
                >
                  <IconX size={14} />
                </button>
              )}
            </div>

            {group.conditions.map((condition, ci) => (
              <ConditionRow
                key={ci}
                condition={condition}
                tags={tags}
                onChange={(next) => {
                  const conditions = [...group.conditions]
                  conditions[ci] = next
                  setGroup(gi, { ...group, conditions })
                }}
                onRemove={
                  group.conditions.length > 1
                    ? () => setGroup(gi, { ...group, conditions: group.conditions.filter((_, i) => i !== ci) })
                    : undefined
                }
              />
            ))}

            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setGroup(gi, {
                  ...group,
                  conditions: [...group.conditions, { field: 'total_spent', operator: 'gte', value: '' }],
                })
              }
              style={{ marginTop: 4, color: '#16A34A' }}
            >
              <IconPlus size={13} /> Add condition
            </Button>
          </div>
        </div>
      ))}

      <Button
        size="sm"
        onClick={() =>
          onChange({
            ...definition,
            groups: [
              ...definition.groups,
              { op: 'and', conditions: [{ field: 'total_spent', operator: 'gte', value: '' }] },
            ],
          })
        }
        style={{ alignSelf: 'flex-start' }}
      >
        <IconPlus size={13} /> Add condition group
      </Button>
    </div>
  )
}

function ConditionRow({
  condition,
  tags,
  onChange,
  onRemove,
}: {
  condition: SegmentCondition
  tags: Array<{ id: string; name: string }>
  onChange: (next: SegmentCondition) => void
  onRemove?: () => void
}) {
  const meta = fieldMeta(condition.field)
  const operators = OPERATORS[meta.type] ?? OPERATORS.text
  const needsValue = condition.operator !== 'is_set' && condition.operator !== 'is_not_set'

  const select =
    'rounded-lg border px-2 py-1.5 text-[12.5px] outline-none cursor-pointer min-w-0' as const
  const selectStyle = { background: 'var(--w-card)', borderColor: 'var(--w-border)' }

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
      <select
        value={condition.field}
        onChange={(e) => {
          const next = fieldMeta(e.target.value)
          const ops = OPERATORS[next.type] ?? OPERATORS.text
          onChange({ field: e.target.value, operator: ops[0].key as any, value: '' })
        }}
        className={select}
        style={{ ...selectStyle, flex: '1 1 160px' }}
      >
        {FIELDS.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>

      <select
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value as any })}
        className={select}
        style={{ ...selectStyle, flex: '0 0 auto' }}
      >
        {operators.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>

      {needsValue &&
        (meta.type === 'tag' ? (
          <select
            value={condition.value}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            className={select}
            style={{ ...selectStyle, flex: '1 1 140px' }}
          >
            <option value="">Pick a tag…</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : meta.type === 'enum' ? (
          <select
            value={condition.value}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            className={select}
            style={{ ...selectStyle, flex: '1 1 140px' }}
          >
            <option value="">Pick…</option>
            {((meta as any).options ?? []).map((o: string) => (
              <option key={o} value={o}>
                {o.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        ) : meta.type === 'boolean' ? (
          <select
            value={condition.value}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            className={select}
            style={{ ...selectStyle, flex: '1 1 100px' }}
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        ) : (
          <input
            value={condition.value}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            type={meta.type === 'number' ? 'number' : 'text'}
            placeholder="Value"
            className="min-w-0 rounded-lg border px-2 py-1.5 text-[12.5px] outline-none"
            style={{ ...selectStyle, flex: '1 1 120px' }}
          />
        ))}

      {onRemove && (
        <button
          onClick={onRemove}
          className="shrink-0 cursor-pointer border-0 bg-transparent p-1"
          style={{ color: 'var(--w-muted)' }}
        >
          <IconX size={14} />
        </button>
      )}
    </div>
  )
}

/** Debounced live preview of how many contacts a definition matches. */
export function useSegmentPreview(definition: SegmentDefinition) {
  const [count, setCount] = useState<number | null>(null)
  const [sample, setSample] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  const run = useCallback(async (def: SegmentDefinition) => {
    setLoading(true)
    try {
      const res = await fetch('/api/segments/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: def }),
      })
      const json = await res.json()
      if (res.ok) {
        setCount(json.count)
        setSample(json.sample ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => run(definition), 400)
    return () => clearTimeout(t)
  }, [definition, run])

  return { count, sample, loading }
}

export function RfmPill({ tier }: { tier: string | null }) {
  if (!tier) return null
  const tone =
    tier === 'champion' || tier === 'loyal'
      ? 'green'
      : tier === 'at_risk' || tier === 'cant_lose'
        ? 'amber'
        : tier === 'hibernating'
          ? 'red'
          : 'blue'
  return <Pill tone={tone as any}>{tier.replace(/_/g, ' ')}</Pill>
}
