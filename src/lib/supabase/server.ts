import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * Server component / route handler client. Carries the user's session so
 * RLS applies — use this for anything acting *as the signed-in merchant*.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(list) {
          try {
            list.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // Called from a Server Component — middleware refreshes the session instead.
          }
        },
      },
    }
  )
}

/**
 * Service-role client. Bypasses RLS entirely, so EVERY query made with it
 * must scope by user_id explicitly. Only for webhooks, cron and engines
 * that run without a user session.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service-role env vars are missing')

  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Resolve the signed-in user or null. */
export async function getUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

/** Resolve the signed-in user or throw — for API routes that require auth. */
export async function requireUser() {
  const user = await getUser()
  if (!user) throw new UnauthorizedError()
  return user
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized')
    this.name = 'UnauthorizedError'
  }
}
