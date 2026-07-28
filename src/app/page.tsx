import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const user = await getUser()
  redirect(user ? '/dashboard' : '/login')
}
