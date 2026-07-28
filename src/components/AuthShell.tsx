import { IconWhatsApp } from '@/components/icons'

const HIGHLIGHTS = [
  ['Shared WhatsApp inbox', 'Every conversation in one place, in real time.'],
  ['COD order confirmation', 'Cut returns by confirming cash orders before you ship.'],
  ['Abandoned cart recovery', 'Three timed reminders with single-use discount codes.'],
  ['Broadcasts & flows', 'Approved templates, segments and button-driven bots.'],
]

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen" style={{ background: 'var(--w-canvas)' }}>
      {/* brand panel — hidden on small screens */}
      <div
        className="hidden w-[46%] max-w-[560px] flex-col justify-between p-12 lg:flex"
        style={{ background: '#0B1F16' }}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px]" style={{ background: '#16A34A' }}>
            <IconWhatsApp size={20} style={{ color: '#fff' }} />
          </div>
          <div
            className="text-[21px] font-extrabold tracking-[-0.02em] text-white"
            style={{ fontFamily: "'Manrope', sans-serif" }}
          >
            Wasify
          </div>
        </div>

        <div>
          <h1
            className="mb-3 text-[34px] font-extrabold leading-[1.15] tracking-[-0.03em] text-white"
            style={{ fontFamily: "'Manrope', sans-serif" }}
          >
            Turn WhatsApp into
            <br />
            your sales channel.
          </h1>
          <p className="mb-8 max-w-sm text-[14px] leading-relaxed" style={{ color: '#9CA3AF' }}>
            The WhatsApp CRM built for Shopify merchants — inbox, COD confirmation, cart recovery,
            campaigns and automations.
          </p>

          <div className="flex flex-col gap-3.5">
            {HIGHLIGHTS.map(([h, sub]) => (
              <div key={h} className="flex gap-3">
                <span
                  className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{ background: '#22C55E' }}
                />
                <span>
                  <span className="block text-[13.5px] font-semibold text-white">{h}</span>
                  <span className="block text-[12.5px]" style={{ color: '#9CA3AF' }}>
                    {sub}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="text-[11.5px]" style={{ color: '#6B7280' }}>
          © {new Date().getFullYear()} Wasify
        </div>
      </div>

      {/* form panel */}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[380px]">
          <div className="mb-7 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-[9px]" style={{ background: '#16A34A' }}>
              <IconWhatsApp size={18} style={{ color: '#fff' }} />
            </div>
            <div className="text-[19px] font-extrabold" style={{ fontFamily: "'Manrope', sans-serif" }}>
              Wasify
            </div>
          </div>

          <h2 className="text-[24px] font-bold tracking-[-0.02em]" style={{ fontFamily: "'Manrope', sans-serif" }}>
            {title}
          </h2>
          <p className="mb-6 mt-1 text-[13.5px]" style={{ color: 'var(--w-muted)' }}>
            {subtitle}
          </p>

          {children}

          {footer && (
            <div className="mt-6 text-center text-[13px]" style={{ color: 'var(--w-muted)' }}>
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
