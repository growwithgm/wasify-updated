'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { IconX } from '@/components/icons'

/* ------------------------------------------------------------------ */
/* Page chrome                                                         */
/* ------------------------------------------------------------------ */

export function Page({ children }: { children: React.ReactNode }) {
  return (
    <div data-r="pad" className="min-w-0 flex-1 overflow-y-auto" style={{ padding: '24px 28px' }}>
      {children}
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div
          className="text-[22px] font-bold tracking-[-0.02em]"
          style={{ fontFamily: "'Manrope', sans-serif" }}
        >
          {title}
        </div>
        {subtitle && (
          <div className="mt-0.5 text-[13px]" style={{ color: 'var(--w-muted)' }}>
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  )
}

export function Card({
  children,
  className = '',
  padding = 20,
  style,
}: {
  children: React.ReactNode
  className?: string
  padding?: number
  style?: React.CSSProperties
}) {
  return (
    <div
      className={`min-w-0 rounded-xl border ${className}`}
      style={{
        background: 'var(--w-card)',
        borderColor: 'var(--w-border)',
        boxShadow: 'var(--w-shadow)',
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function CardTitle({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3.5 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[14.5px] font-semibold">{title}</div>
        {sub && (
          <div className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
            {sub}
          </div>
        )}
      </div>
      {right}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Buttons + inputs                                                    */
/* ------------------------------------------------------------------ */

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  children,
  style,
  ...rest
}: BtnProps) {
  const pad = size === 'sm' ? '5px 10px' : '7px 14px'
  const font = size === 'sm' ? 12.5 : 13

  const variants: Record<string, React.CSSProperties> = {
    primary: { background: '#16A34A', color: '#fff', border: 'none', fontWeight: 600 },
    secondary: {
      background: 'var(--w-card)',
      color: 'var(--w-text)',
      border: '1px solid var(--w-border)',
      fontWeight: 500,
    },
    ghost: { background: 'transparent', color: 'var(--w-muted)', border: 'none', fontWeight: 500 },
    danger: { background: 'var(--w-errortint)', color: '#EF4444', border: '1px solid #FCA5A5', fontWeight: 600 },
  }

  const isOff = disabled || loading

  return (
    <button
      {...rest}
      disabled={isOff}
      className="inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg transition-opacity"
      style={{
        ...variants[variant],
        padding: pad,
        fontSize: font,
        cursor: isOff ? 'not-allowed' : 'pointer',
        opacity: isOff ? 0.55 : 1,
        fontFamily: "'Inter', sans-serif",
        ...style,
      }}
    >
      {loading && (
        <span
          className="w-spin inline-block h-3 w-3 rounded-full"
          style={{ border: '2px solid currentColor', borderTopColor: 'transparent' }}
        />
      )}
      {children}
    </button>
  )
}

export function Input({
  label,
  hint,
  error,
  className = '',
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="mb-1.5 block text-[12.5px] font-medium">{label}</span>}
      <input
        {...rest}
        className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
        style={{
          background: 'var(--w-card)',
          borderColor: error ? '#EF4444' : 'var(--w-border)',
        }}
      />
      {(hint || error) && (
        <span className="mt-1 block text-[11.5px]" style={{ color: error ? '#EF4444' : 'var(--w-muted)' }}>
          {error || hint}
        </span>
      )}
    </label>
  )
}

export function Textarea({
  label,
  hint,
  counter,
  className = '',
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string
  hint?: string
  counter?: string
}) {
  return (
    <label className={`block ${className}`}>
      {(label || counter) && (
        <span className="mb-1.5 flex items-center justify-between">
          {label && <span className="text-[12.5px] font-medium">{label}</span>}
          {counter && (
            <span className="text-[11px]" style={{ color: 'var(--w-muted)' }}>
              {counter}
            </span>
          )}
        </span>
      )}
      <textarea
        {...rest}
        className="w-full resize-y rounded-lg border px-3 py-2 text-[13px] outline-none"
        style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
      />
      {hint && (
        <span className="mt-1 block text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
          {hint}
        </span>
      )}
    </label>
  )
}

export function Select({
  label,
  className = '',
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="mb-1.5 block text-[12.5px] font-medium">{label}</span>}
      <select
        {...rest}
        className="w-full cursor-pointer rounded-lg border px-3 py-2 text-[13px] outline-none"
        style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
      >
        {children}
      </select>
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  sub,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  sub?: string
  disabled?: boolean
}) {
  return (
    <label className={`flex items-center gap-3 ${disabled ? 'opacity-55' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className="relative h-[22px] w-[38px] shrink-0 rounded-full border-0 transition-colors"
        style={{ background: checked ? '#16A34A' : 'var(--w-border)', cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        <span
          className="absolute top-[3px] h-4 w-4 rounded-full bg-white transition-[left]"
          style={{ left: checked ? 19 : 3, boxShadow: '0 1px 2px rgba(0,0,0,.2)' }}
        />
      </button>
      {(label || sub) && (
        <span className="min-w-0">
          {label && <span className="block text-[13px] font-medium">{label}</span>}
          {sub && (
            <span className="block text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
              {sub}
            </span>
          )}
        </span>
      )}
    </label>
  )
}

/* ------------------------------------------------------------------ */
/* Pills, badges, empty + loading states                               */
/* ------------------------------------------------------------------ */

export type PillTone = 'green' | 'amber' | 'red' | 'blue' | 'gray'

const PILL: Record<PillTone, { bg: string; fg: string }> = {
  green: { bg: 'var(--w-greentint)', fg: '#16A34A' },
  amber: { bg: 'var(--w-ambertint)', fg: '#B45309' },
  red: { bg: 'var(--w-errortint)', fg: '#DC2626' },
  blue: { bg: 'var(--w-infotint)', fg: '#2563EB' },
  gray: { bg: 'var(--w-card2)', fg: 'var(--w-muted)' },
}

export function Pill({
  tone = 'gray',
  children,
  title,
}: {
  tone?: PillTone
  children: React.ReactNode
  title?: string
}) {
  const c = PILL[tone]
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-[3px] text-[11.5px] font-semibold"
      style={{ background: c.bg, color: c.fg }}
    >
      {children}
    </span>
  )
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string
  body?: string
  action?: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div style={{ color: 'var(--w-muted)' }}>{icon}</div>}
      <div className="text-[15px] font-semibold">{title}</div>
      {body && (
        <div className="max-w-md text-[13px] leading-relaxed" style={{ color: 'var(--w-muted)' }}>
          {body}
        </div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Skeleton({ h = 14, w = '100%', className = '' }: { h?: number; w?: string | number; className?: string }) {
  return <div className={`w-skel ${className}`} style={{ height: h, width: w }} />
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="flex flex-col gap-2 p-4">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} h={13} w={c === 0 ? '22%' : `${Math.floor(78 / (cols - 1))}%`} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Shown when a page's data load fails — the old app only logged to console. */
export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
      style={{ background: 'var(--w-errortint)', borderColor: '#FCA5A5' }}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-semibold" style={{ color: '#B91C1C' }}>
          Could not load this data
        </div>
        <div className="truncate text-[12px]" style={{ color: '#B91C1C' }}>
          {error}
        </div>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

export function Table({ children, minWidth }: { children: React.ReactNode; minWidth?: number }) {
  return (
    <div data-r="scroll" className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-[13px]" style={{ minWidth }}>
        {children}
      </table>
    </div>
  )
}

export function Th({
  children,
  align = 'left',
  width,
}: {
  children?: React.ReactNode
  align?: 'left' | 'right' | 'center'
  width?: number | string
}) {
  return (
    <th
      className="whitespace-nowrap px-3 py-2.5 text-[11.5px] font-semibold uppercase tracking-[.04em]"
      style={{
        textAlign: align,
        color: 'var(--w-muted)',
        borderBottom: '1px solid var(--w-border)',
        width,
      }}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  align = 'left',
  className = '',
  style,
  colSpan,
}: {
  children?: React.ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
  style?: React.CSSProperties
  colSpan?: number
}) {
  return (
    <td
      colSpan={colSpan}
      className={`px-3 py-2.5 ${className}`}
      style={{ textAlign: align, borderBottom: '1px solid var(--w-border)', ...style }}
    >
      {children}
    </td>
  )
}

/* ------------------------------------------------------------------ */
/* Modal + drawer                                                      */
/* ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  width = 520,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  width?: number
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,.45)' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-toast max-h-[90vh] w-full overflow-hidden rounded-2xl border"
        style={{
          maxWidth: width,
          background: 'var(--w-card)',
          borderColor: 'var(--w-border)',
          boxShadow: '0 20px 50px rgba(16,24,40,.28)',
        }}
      >
        <div
          className="flex items-center justify-between px-5 py-3.5"
          style={{ borderBottom: '1px solid var(--w-border)' }}
        >
          <div className="text-[15px] font-bold" style={{ fontFamily: "'Manrope', sans-serif" }}>
            {title}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded-md border-0 bg-transparent p-1"
            style={{ color: 'var(--w-muted)' }}
          >
            <IconX size={17} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div
            className="flex justify-end gap-2 px-5 py-3.5"
            style={{ borderTop: '1px solid var(--w-border)', background: 'var(--w-card2)' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

type Toast = { id: number; text: string; tone: PillTone }
const ToastCtx = createContext<(text: string, tone?: PillTone) => void>(() => {})

export function useToast() {
  return useContext(ToastCtx)
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])

  const push = useCallback((text: string, tone: PillTone = 'green') => {
    const id = Date.now() + Math.random()
    setItems((prev) => [...prev, { id, text, tone }])
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4000)
  }, [])

  const value = useMemo(() => push, [push])

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-[300] flex -translate-x-1/2 flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className="w-toast pointer-events-auto rounded-xl px-4 py-2.5 text-[13px] font-medium text-white"
            style={{
              background: t.tone === 'red' ? '#EF4444' : t.tone === 'amber' ? '#F59E0B' : '#111827',
              boxShadow: '0 8px 24px rgba(16,24,40,.24)',
            }}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/* ------------------------------------------------------------------ */
/* Formatting helpers used across pages                                */
/* ------------------------------------------------------------------ */

export function money(value: number | null | undefined, currency = 'EUR') {
  const n = Number(value ?? 0)
  try {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency,
      maximumFractionDigits: n % 1 === 0 ? 0 : 2,
    }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

export function num(value: number | null | undefined) {
  return new Intl.NumberFormat('es-ES').format(Number(value ?? 0))
}

export function pct(part: number, total: number, digits = 1) {
  if (!total) return '0%'
  return `${((part / total) * 100).toFixed(digits)}%`
}

export function shortDate(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
}

export function dateTime(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function relTime(iso: string | null | undefined) {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 604800) return `${Math.floor(s / 86400)}d`
  return shortDate(iso)
}
