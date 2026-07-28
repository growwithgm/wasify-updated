'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { AuthShell } from '@/components/AuthShell'
import { Button, Input } from '@/components/ui'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const next = params.get('next') || '/dashboard'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error } = await supabaseBrowser().auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    router.push(next)
    router.refresh()
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your Wasify workspace"
      footer={
        <>
          Don&apos;t have an account? <Link href="/signup">Create one</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@yourstore.com"
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />

        {error && (
          <div
            className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}
          >
            {error}
          </div>
        )}

        <Button type="submit" variant="primary" loading={loading} style={{ padding: '10px 14px', marginTop: 4 }}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
