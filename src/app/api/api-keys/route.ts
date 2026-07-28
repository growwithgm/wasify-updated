import crypto from 'crypto'
import { withAuth, jsonBody, badRequest } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * API keys are shown exactly once. We store only a SHA-256 hash plus a short
 * prefix for display, so a database leak cannot be replayed against the API.
 */
export async function POST(request: Request) {
  return withAuth(async ({ supabase, userId }) => {
    const { name, scopes } = await jsonBody<{ name: string; scopes?: string[] }>(request)
    if (!name?.trim()) badRequest('Give the key a name')

    const secret = `wsk_live_${crypto.randomBytes(24).toString('hex')}`
    const prefix = secret.slice(0, 16)
    const hash = crypto.createHash('sha256').update(secret).digest('hex')

    const { data, error } = await supabase
      .from('api_keys')
      .insert({
        user_id: userId,
        name: name.trim(),
        key_prefix: prefix,
        key_hash: hash,
        scopes: scopes?.length ? scopes : ['read'],
      })
      .select('id, name, key_prefix, scopes, created_at')
      .single()

    if (error) badRequest(error.message)
    return { key: data, secret }
  })
}

export async function DELETE(request: Request) {
  return withAuth(async ({ supabase }) => {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) badRequest('id is required')
    await supabase.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', id)
    return { ok: true }
  })
}
