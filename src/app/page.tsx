import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { LandingRedirect } from '@/components/LandingRedirect'

export const dynamic = 'force-dynamic'

/**
 * Auth is decided here on the server; the landing SCREEN is decided in the
 * browser, because phones go to the Inbox and desktops to the Dashboard.
 */
export default async function Home() {
  const user = await getUser()
  if (!user) redirect('/login')
  return <LandingRedirect />
}
