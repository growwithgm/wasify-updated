import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/** Paths that must stay reachable without a session. */
const PUBLIC_PAGES = ['/login', '/signup', '/auth/callback', '/forgot-password', '/reset-password']

/**
 * Webhooks and cron authenticate themselves (HMAC / bearer secret) and are
 * called by Meta, Shopify and Vercel — never by a signed-in browser.
 */
const PUBLIC_APIS = [
  '/api/whatsapp/webhook',
  '/api/shopify/webhook',
  '/api/shopify/connect',
  '/api/shopify/callback',
  '/api/cron/',
  '/api/health',
  '/api/flow/', // Shopify Flow calls in with its own bearer secret
  '/api/stock/', // storefront back-in-stock signups — public by design
  '/o/', // order-confirmation short links — customers have no session
  '/s/', // back-in-stock short links — same
]

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (PUBLIC_APIS.some((p) => pathname.startsWith(p))) return NextResponse.next()

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(list) {
          list.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    }
  )

  // getUser() (not getSession) so the token is actually validated here.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isPublicPage = PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))

  if (!user) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!isPublicPage) {
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      url.searchParams.set('next', pathname)
      return NextResponse.redirect(url)
    }
    return response
  }

  // Signed in and sitting on an auth page — send them to the app.
  if (isPublicPage && pathname !== '/auth/callback') {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
