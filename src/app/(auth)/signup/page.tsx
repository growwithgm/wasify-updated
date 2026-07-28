'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase/client'
import { AuthShell } from '@/components/AuthShell'
import { Button, Input } from '@/components/ui'

export default function SignupPage() {
  const router = useRouter()
  const [fullName, setFullName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setNotice('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setLoading(true)
    const supabase = supabaseBrowser()
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, business_name: businessName } },
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    // With email confirmation ON, Supabase returns a user but no session.
    if (!data.session) {
      setNotice('Check your inbox to confirm your email, then sign in.')
      setLoading(false)
      return
    }

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <AuthShell
      title="Create your workspace"
      subtitle="Free to set up — connect WhatsApp and Shopify after signup"
      footer={
        <>
          Already have an account? <Link href="/login">Sign in</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
        <Input
          label="Your name"
          required
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Ayesha Khan"
        />
        <Input
          label="Store name"
          required
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="Maison Vela"
        />
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
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
        />

        {error && (
          <div
            className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--w-greentint)', color: '#15803D' }}
          >
            {notice}
          </div>
        )}

        <Button type="submit" variant="primary" loading={loading} style={{ padding: '10px 14px', marginTop: 4 }}>
          Create account
        </Button>
      </form>
    </AuthShell>
  )
}
