import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/** Shared plumbing for authenticated API routes. */

export type Ctx = {
  userId: string
  supabase: Awaited<ReturnType<typeof createClient>>
}

export async function withAuth<T>(
  handler: (ctx: Ctx) => Promise<T>
): Promise<NextResponse> {
  let ctx: Ctx
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    ctx = { userId: user.id, supabase }
  } catch (e: any) {
    return NextResponse.json({ error: `Auth failed: ${e?.message ?? e}` }, { status: 401 })
  }

  try {
    const result = await handler(ctx)
    if (result instanceof NextResponse) return result
    return NextResponse.json(result ?? { ok: true })
  } catch (e: any) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message, ...(e.extra ?? {}) }, { status: e.status })
    }
    console.error('[api]', e)
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 })
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message)
  }
}

export function badRequest(message: string, extra?: Record<string, unknown>): never {
  throw new HttpError(400, message, extra)
}

export function notFound(message = 'Not found'): never {
  throw new HttpError(404, message)
}

/** Parse a JSON body, rejecting anything that is not an object. */
export async function jsonBody<T = Record<string, any>>(request: Request): Promise<T> {
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object') badRequest('Expected a JSON object body')
    return body as T
  } catch (e) {
    if (e instanceof HttpError) throw e
    badRequest('Invalid JSON body')
  }
}
