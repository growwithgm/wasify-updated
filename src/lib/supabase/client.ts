'use client'

import { createBrowserClient } from '@supabase/ssr'

/**
 * Browser client — anon key only. Every read is filtered by RLS
 * (`auth.uid() = user_id`), so pages never need an explicit tenant filter.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

let singleton: ReturnType<typeof createClient> | null = null

/** Shared instance so realtime channels are not duplicated across components. */
export function supabaseBrowser() {
  if (!singleton) singleton = createClient()
  return singleton
}
