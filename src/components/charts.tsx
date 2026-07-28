'use client'

/**
 * Small hand-rolled SVG charts. The prototype draws inline SVG paths, so a
 * charting library would add weight without adding fidelity.
 */

export type Series = { key: string; label: string; color: string; width?: number; opacity?: number }

function niceMax(v: number) {
  if (v <= 0) return 10
  const mag = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / mag) * mag
}

function pathFor(values: number[], max: number, w: number, h: number, pad: number) {
  if (values.length === 0) return ''
  if (values.length === 1) {
    const y = h - pad - (values[0] / max) * (h - pad * 2)
    return `M0 ${y} L${w} ${y}`
  }
  const step = w / (values.length - 1)
  return values
    .map((v, i) => {
      const x = i * step
      const y = h - pad - (v / max) * (h - pad * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

export function LineChart({
  data,
  series,
  height = 190,
  xLabels,
}: {
  data: Array<Record<string, any>>
  series: Series[]
  height?: number
  xLabels?: string[]
}) {
  const W = 600
  const H = height
  const PAD = 14

  const max = niceMax(
    Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key] ?? 0))))
  )

  const gridYs = [0.25, 0.5, 0.75, 1].map((f) => H - PAD - f * (H - PAD * 2))

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height }} preserveAspectRatio="none">
        <g stroke="var(--w-border)" strokeWidth={1}>
          {gridYs.map((y, i) => (
            <line key={i} x1={0} y1={y} x2={W} y2={y} />
          ))}
        </g>
        {series.map((s) => (
          <path
            key={s.key}
            d={pathFor(data.map((d) => Number(d[s.key] ?? 0)), max, W, H, PAD)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width ?? 2}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={s.opacity ?? 1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {[1, 0.75, 0.5, 0.25].map((f, i) => (
          <text key={i} x={2} y={H - PAD - f * (H - PAD * 2) - 4} fontSize={10} fill="var(--w-muted)">
            {formatTick(max * f)}
          </text>
        ))}
      </svg>
      {xLabels && xLabels.length > 0 && (
        <div
          className="flex justify-between px-1.5 pt-0.5 text-[10.5px]"
          style={{ color: 'var(--w-muted)' }}
        >
          {xLabels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
    </>
  )
}

function formatTick(v: number) {
  if (v >= 1000) return `${Math.round(v / 1000)}K`
  return String(Math.round(v))
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
      {series.map((s) => (
        <span key={s.key} className="whitespace-nowrap">
          <span
            className="mr-[5px] inline-block h-[9px] w-[9px] rounded-[2px]"
            style={{ background: s.color }}
          />
          {s.label}
        </span>
      ))}
    </div>
  )
}

export function BarRow({
  label,
  value,
  pctWidth,
  color,
}: {
  label: string
  value: string
  pctWidth: number
  color: string
}) {
  return (
    <div className="mb-[11px]">
      <div className="mb-1 flex justify-between text-[12.5px]">
        <span className="font-medium">{label}</span>
        <span className="font-bold">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--w-canvas)' }}>
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.max(0, Math.min(100, pctWidth))}%`, background: color }}
        />
      </div>
    </div>
  )
}

/** Horizontal funnel used on Analytics and Pipelines. */
export function Funnel({
  steps,
}: {
  steps: Array<{ name: string; n: number; rate?: string }>
}) {
  const max = Math.max(1, ...steps.map((s) => s.n))
  return (
    <div className="flex flex-col gap-2.5">
      {steps.map((s) => (
        <div key={s.name}>
          <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
            <span className="font-medium">{s.name}</span>
            <span>
              <b>{new Intl.NumberFormat('es-ES').format(s.n)}</b>
              {s.rate && (
                <span className="ml-2 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                  {s.rate}
                </span>
              )}
            </span>
          </div>
          <div className="h-[26px] overflow-hidden rounded-md" style={{ background: 'var(--w-canvas)' }}>
            <div
              className="h-full rounded-md transition-[width] duration-500"
              style={{ width: `${(s.n / max) * 100}%`, background: '#16A34A', opacity: 0.85 }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Cohort heat-map cell colour: 0 → transparent, 1 → full green. */
export function heatColor(v: number, max: number) {
  if (!max || v <= 0) return 'var(--w-card2)'
  const t = Math.min(1, v / max)
  return `rgba(22,163,74,${(0.12 + t * 0.68).toFixed(3)})`
}
