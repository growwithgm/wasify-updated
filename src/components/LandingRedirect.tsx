'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { IconWhatsApp } from '@/components/icons'

/**
 * Picks the landing screen from the viewport.
 *
 * On a phone the Dashboard is a wall of charts you have to scroll past to get
 * to the thing you actually opened the app for, so phones land on the Inbox
 * instead. The choice can only be made in the browser — the server has no way
 * to know the screen width — so this runs a `replace` (not a push) to keep the
 * back button clean.
 */
export function LandingRedirect() {
  const router = useRouter()

  useEffect(() => {
    const isPhone = window.matchMedia('(max-width: 900px)').matches
    router.replace(isPhone ? '/inbox' : '/dashboard')
  }, [router])

  return (
    <div
      className="flex h-screen w-full flex-col items-center justify-center gap-3"
      style={{ background: 'var(--w-canvas)' }}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: '#16A34A' }}>
        <IconWhatsApp size={24} style={{ color: '#fff' }} />
      </div>
      <div className="w-pulse text-[13px]" style={{ color: 'var(--w-muted)' }}>
        Opening Wasify…
      </div>
    </div>
  )
}
