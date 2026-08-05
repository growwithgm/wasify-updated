'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Button, Card, CardTitle, EmptyState, ErrorState, Input, Modal, Page, PageHeader, Pill, Select,
  Table, TableSkeleton, Td, Th, ToastProvider, relTime, useToast,
} from '@/components/ui'
import { IconMeta, IconRefresh, IconShopify, IconTrash, IconWhatsApp } from '@/components/icons'
import { formatPhone } from '@/lib/phone'

export default function IntegrationsPage() {
  return (
    <ToastProvider>
      <Suspense fallback={null}>
        <IntegrationsScreen />
      </Suspense>
    </ToastProvider>
  )
}

function IntegrationsScreen() {
  const toast = useToast()
  const params = useSearchParams()
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  const [waOpen, setWaOpen] = useState(false)
  const [shopOpen, setShopOpen] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [diagnostics, setDiagnostics] = useState<any>(null)
  const [busy, setBusy] = useState('')
  const [oauthError, setOauthError] = useState('')
  const [recoveryTestOpen, setRecoveryTestOpen] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/integrations', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setData(json)
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Surface the OAuth round-trip result. Success is a toast; a failure is a
  // banner that stays put — these messages name the variable to fix and are
  // far too long to read before a toast fades.
  useEffect(() => {
    if (params.get('shopify') === 'connected') toast('Shopify connected')
    setOauthError(params.get('shopify_error') ?? '')
  }, [params, toast])

  async function runDiagnostics() {
    setBusy('diag')
    try {
      const res = await fetch('/api/whatsapp/diagnostics', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) {
        toast(json.error, 'red')
        return
      }
      setDiagnostics(json)
      load()
    } finally {
      setBusy('')
    }
  }

  async function subscribe() {
    setBusy('sub')
    try {
      const res = await fetch('/api/whatsapp/diagnostics', { method: 'POST' })
      const json = await res.json()
      toast(res.ok ? 'Subscribed to the WABA webhooks' : json.error, res.ok ? 'green' : 'red')
      load()
    } finally {
      setBusy('')
    }
  }

  async function disconnectShopify() {
    if (!confirm('Disconnect Shopify? Mirrored orders and carts are kept.')) return
    await fetch('/api/shopify/disconnect', { method: 'POST' })
    toast('Shopify disconnected')
    load()
  }

  async function revokeKey(id: string) {
    if (!confirm('Revoke this key? Anything using it stops working immediately.')) return
    await fetch(`/api/api-keys?id=${id}`, { method: 'DELETE' })
    toast('Key revoked')
    load()
  }

  const wa = data?.whatsapp
  const sh = data?.shopify
  const siteUrl = data?.siteUrl || (typeof window !== 'undefined' ? window.location.origin : '')

  return (
    <Page>
      <PageHeader title="Integrations" subtitle="Shopify & Meta WhatsApp connections, webhook health and API access" />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      {oauthError && (
        <div
          className="mb-4 rounded-[10px] border px-3 py-2.5 text-[12.5px] leading-relaxed"
          style={{ background: 'var(--w-errortint)', borderColor: 'var(--w-error)', color: '#B91C1C' }}
        >
          <b>Shopify connection failed.</b> {oauthError}
        </div>
      )}

      {data?.siteUrlError && (
        <div
          className="mb-4 rounded-[10px] border px-3 py-2.5 text-[12.5px] leading-relaxed"
          style={{ background: 'var(--w-ambertint)', borderColor: 'var(--w-amber)', color: '#92400E' }}
        >
          <b>Fix this before connecting Shopify.</b> {data.siteUrlError}
        </div>
      )}

      {!data ? (
        <TableSkeleton rows={6} cols={4} />
      ) : (
        <>
          {/* connection cards */}
          <div className="mb-5 grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {/* WhatsApp */}
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span
                    className="flex h-10 w-10 items-center justify-center rounded-[10px]"
                    style={{ background: 'var(--w-greentint)', color: '#16A34A' }}
                  >
                    <IconWhatsApp size={22} />
                  </span>
                  <div>
                    <div className="text-[14.5px] font-semibold">WhatsApp Cloud API</div>
                    <div className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
                      {wa?.display_phone_number || 'No number connected'}
                    </div>
                  </div>
                </div>
                <Pill
                  tone={
                    wa?.connection_status === 'connected'
                      ? 'green'
                      : wa?.connection_status === 'error'
                        ? 'red'
                        : 'gray'
                  }
                >
                  {wa?.connection_status ?? 'disconnected'}
                </Pill>
              </div>

              {wa?.connection_error && (
                <div
                  className="mt-3 rounded-lg px-2.5 py-2 text-[12px]"
                  style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}
                >
                  {wa.connection_error}
                </div>
              )}

              {wa?.connection_status === 'connected' && (
                <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  <Stat label="Quality" value={qualityWord(wa.quality_rating)} />
                  <Stat label="Tier" value={tierLabel(wa.messaging_tier)} />
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button size="sm" variant="primary" onClick={() => setWaOpen(true)}>
                  {wa?.has_token ? 'Edit credentials' : 'Connect'}
                </Button>
                <Button size="sm" onClick={runDiagnostics} loading={busy === 'diag'} disabled={!wa?.has_token}>
                  Run diagnostics
                </Button>
                <Button size="sm" onClick={subscribe} loading={busy === 'sub'} disabled={!wa?.waba_id}>
                  Subscribe webhook
                </Button>
              </div>

              {diagnostics && (
                <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--w-border)' }}>
                  {diagnostics.checks.map((c: any) => (
                    <div key={c.name} className="flex items-start gap-2 py-1 text-[12.5px]">
                      <span style={{ color: c.ok ? '#16A34A' : '#EF4444' }}>{c.ok ? '✓' : '✕'}</span>
                      <span className="min-w-0">
                        <b>{c.name}</b> — <span style={{ color: 'var(--w-muted)' }}>{c.detail}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Shopify */}
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span
                    className="flex h-10 w-10 items-center justify-center rounded-[10px]"
                    style={{ background: 'var(--w-greentint)', color: '#16A34A' }}
                  >
                    <IconShopify size={22} />
                  </span>
                  <div>
                    <div className="text-[14.5px] font-semibold">Shopify</div>
                    <div className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
                      {sh?.store_domain || 'No store connected'}
                    </div>
                  </div>
                </div>
                <Pill tone={sh?.connection_status === 'connected' ? 'green' : 'gray'}>
                  {sh?.connection_status ?? 'disconnected'}
                </Pill>
              </div>

              {sh?.connection_error && (
                <div
                  className="mt-3 rounded-lg px-2.5 py-2 text-[12px]"
                  style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}
                >
                  {sh.connection_error}
                </div>
              )}

              {sh?.connection_status === 'connected' && (
                <>
                  <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <Stat label="Webhooks" value={sh.webhooks_registered ? 'Registered' : 'Not registered'} />
                    <Stat label="Last sync" value={sh.last_sync_at ? relTime(sh.last_sync_at) : 'never'} />
                  </div>
                  <div className="mt-2 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                    Scopes: {sh.scopes || '—'}
                  </div>
                </>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button size="sm" variant="primary" onClick={() => setShopOpen(true)}>
                  {sh?.has_token ? 'Reconnect' : 'Connect store'}
                </Button>
                {sh?.has_token && (
                  <>
                    <Button
                      size="sm"
                      onClick={async () => {
                        setBusy('sync')
                        const res = await fetch('/api/shopify/sync', { method: 'POST' })
                        const json = await res.json()
                        // A per-resource failure used to be swallowed: the
                        // toast reported a happy "0 products" while the real
                        // reason sat unread in result.errors.
                        toast(
                          !res.ok
                            ? json.error
                            : json.errors?.length
                              ? json.errors.join(' · ')
                              : `Synced ${json.orders} orders, ${json.checkouts} carts, ${json.products} products`,
                          res.ok && !json.errors?.length ? 'green' : 'red'
                        )
                        setBusy('')
                        load()
                      }}
                      loading={busy === 'sync'}
                    >
                      <IconRefresh size={12} /> Sync now
                    </Button>
                    <Button
                      size="sm"
                      loading={busy === 'hooks'}
                      onClick={async () => {
                        setBusy('hooks')
                        const res = await fetch('/api/shopify/webhooks', { method: 'POST' })
                        const json = await res.json()
                        toast(
                          !res.ok
                            ? json.error
                            : json.failed.length
                              ? `${json.registered.length} registered, ${json.failed.length} failed`
                              : `All ${json.registered.length} webhooks registered`,
                          res.ok && !json.failed.length ? 'green' : 'red'
                        )
                        setBusy('')
                        load()
                      }}
                    >
                      Register webhooks
                    </Button>
                    <Button size="sm" onClick={() => setRecoveryTestOpen(true)}>
                      Test recovery
                    </Button>
                    <Button size="sm" variant="ghost" onClick={disconnectShopify}>
                      Disconnect
                    </Button>
                  </>
                )}
              </div>
            </Card>
          </div>

          {/* COD + recovery config live here */}
          <FeatureConfig config={sh} templates={data.approvedTemplates} onSaved={load} />

          {/* webhook health */}
          <Card padding={0} className="mb-5">
            <div className="px-5 pb-1 pt-5">
              <CardTitle
                title="Webhook deliveries"
                sub="Every inbound call from Meta and Shopify, newest first"
                right={
                  <span className="text-[11.5px]" style={{ color: 'var(--w-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                    {siteUrl}/api/whatsapp/webhook
                  </span>
                }
              />
            </div>
            {data.events.length === 0 ? (
              <div className="px-5 pb-5 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                No deliveries yet. Once a customer messages your number or an order comes in, they appear here.
              </div>
            ) : (
              <Table minWidth={640}>
                <thead>
                  <tr>
                    <Th>Source</Th>
                    <Th>Event</Th>
                    <Th>Status</Th>
                    <Th align="right">Duration</Th>
                    <Th align="right">When</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.slice(0, 30).map((e: any) => (
                    <tr key={`${e.source}-${e.id}`}>
                      <Td>{e.source}</Td>
                      <Td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{e.topic}</Td>
                      <Td>
                        <Pill
                          tone={e.status === 'processed' ? 'green' : e.status === 'failed' ? 'red' : 'gray'}
                          title={e.error ?? undefined}
                        >
                          {e.status}
                        </Pill>
                      </Td>
                      <Td align="right" style={{ color: 'var(--w-muted)' }}>
                        {e.duration_ms ? `${e.duration_ms}ms` : '—'}
                      </Td>
                      <Td align="right" style={{ color: 'var(--w-muted)', fontSize: 12 }}>
                        {relTime(e.created_at)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {/* API keys */}
          <Card padding={0}>
            <div className="px-5 pb-1 pt-5">
              <CardTitle
                title="API keys"
                sub="Shown once at creation — only a hash is stored"
                right={
                  <Button size="sm" variant="primary" onClick={() => setKeyOpen(true)}>
                    Generate key
                  </Button>
                }
              />
            </div>
            {data.apiKeys.length === 0 ? (
              <div className="px-5 pb-5 text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
                No keys yet.
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Key</Th>
                    <Th>Scopes</Th>
                    <Th align="right">Last used</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {data.apiKeys.map((k: any) => (
                    <tr key={k.id} style={{ opacity: k.revoked_at ? 0.5 : 1 }}>
                      <Td className="font-medium">{k.name}</Td>
                      <Td style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{k.key_prefix}…</Td>
                      <Td>{(k.scopes ?? []).join(', ')}</Td>
                      <Td align="right" style={{ color: 'var(--w-muted)' }}>
                        {k.last_used_at ? relTime(k.last_used_at) : 'never'}
                      </Td>
                      <Td align="right">
                        {k.revoked_at ? (
                          <Pill tone="gray">revoked</Pill>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => revokeKey(k.id)}>
                            <IconTrash size={13} />
                          </Button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}

      {waOpen && (
        <WhatsAppModal
          config={wa}
          siteUrl={siteUrl}
          onClose={() => setWaOpen(false)}
          onSaved={() => {
            setWaOpen(false)
            load()
            toast('WhatsApp credentials saved')
          }}
        />
      )}

      {shopOpen && <ShopifyModal siteUrl={siteUrl} onClose={() => setShopOpen(false)} />}
      {recoveryTestOpen && <RecoveryTestModal onClose={() => setRecoveryTestOpen(false)} />}

      {keyOpen && (
        <ApiKeyModal
          onClose={() => setKeyOpen(false)}
          onCreated={() => {
            load()
          }}
        />
      )}
    </Page>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-2" style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}>
      <div className="text-[10.5px]" style={{ color: 'var(--w-muted)' }}>
        {label}
      </div>
      <div className="text-[13px] font-bold">{value}</div>
    </div>
  )
}

function qualityWord(q: string | null) {
  return q === 'GREEN' ? 'High' : q === 'YELLOW' ? 'Medium' : q === 'RED' ? 'Low' : '—'
}

function tierLabel(t: string | null) {
  const map: Record<string, string> = {
    TIER_50: '50/24h',
    TIER_250: '250/24h',
    TIER_1K: '1K/24h',
    TIER_10K: '10K/24h',
    TIER_100K: '100K/24h',
    TIER_UNLIMITED: 'Unlimited',
  }
  return t ? (map[t] ?? t) : '—'
}

/* ------------------------------------------------------------------ */

function WhatsAppModal({
  config,
  siteUrl,
  onClose,
  onSaved,
}: {
  config: any
  siteUrl: string
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [form, setForm] = useState({
    phone_number_id: config?.phone_number_id ?? '',
    waba_id: config?.waba_id ?? '',
    business_id: config?.business_id ?? '',
    access_token: '',
    verify_token: '',
  })
  const [generated, setGenerated] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [testPhone, setTestPhone] = useState('')

  async function save() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error)
        return
      }
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  async function generateVerify() {
    const res = await fetch('/api/whatsapp/config', { method: 'POST' })
    const json = await res.json()
    if (res.ok) {
      setGenerated(json.verify_token)
      setForm((f) => ({ ...f, verify_token: json.verify_token }))
    }
  }

  async function sendTest() {
    const res = await fetch('/api/whatsapp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: testPhone }),
    })
    const json = await res.json()
    toast(res.ok ? `Sent — wamid ${json.wamid.slice(-10)}` : json.error, res.ok ? 'green' : 'red')
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="WhatsApp Cloud API credentials"
      width={620}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save credentials
          </Button>
        </>
      }
    >
      <div className="mb-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Input
          label="Phone number ID"
          value={form.phone_number_id}
          onChange={(e) => setForm({ ...form, phone_number_id: e.target.value })}
          placeholder="123456789012345"
          hint="From Meta → WhatsApp → API Setup"
        />
        <Input
          label="WhatsApp Business Account ID"
          value={form.waba_id}
          onChange={(e) => setForm({ ...form, waba_id: e.target.value })}
          placeholder="987654321098765"
          hint="Needed for templates and webhooks"
        />
      </div>

      <Input
        label="Permanent access token"
        type="password"
        value={form.access_token}
        onChange={(e) => setForm({ ...form, access_token: e.target.value })}
        placeholder={config?.has_token ? 'Stored — type a new one to replace it' : 'EAAG…'}
        hint="Encrypted with AES-256-GCM before it is stored. Never sent back to the browser."
        className="mb-3"
      />

      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12.5px] font-medium">Webhook verify token</span>
          <Button size="sm" onClick={generateVerify}>
            Generate
          </Button>
        </div>
        <input
          value={form.verify_token}
          onChange={(e) => setForm({ ...form, verify_token: e.target.value })}
          placeholder={config?.has_verify_token ? 'Stored — generate a new one to replace it' : 'Any random string'}
          className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
          style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
        />
        {generated && (
          <div
            className="mt-1.5 rounded-lg px-2.5 py-2 text-[12px]"
            style={{ background: 'var(--w-greentint)', color: '#15803D' }}
          >
            Copy this into Meta now — <b style={{ fontFamily: "'JetBrains Mono', monospace" }}>{generated}</b>
          </div>
        )}
      </div>

      <div
        className="mb-3 rounded-[10px] border p-3 text-[12px] leading-relaxed"
        style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
      >
        <div className="mb-1 font-semibold">Callback URL for Meta</div>
        <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 }}>
          {siteUrl}/api/whatsapp/webhook
        </code>
        <div className="mt-2" style={{ color: 'var(--w-muted)' }}>
          Subscribe to the <b>messages</b> field. Also set <b>META_APP_SECRET</b> in your environment — without
          it the webhook cannot verify that a request really came from Meta.
        </div>
      </div>

      {config?.has_token && (
        <div className="flex items-end gap-2">
          <Input
            label="Send a test message to"
            value={testPhone}
            onChange={(e) => setTestPhone(e.target.value)}
            placeholder="+34600123456"
            className="flex-1"
          />
          <Button onClick={sendTest} disabled={!testPhone.trim()} style={{ marginBottom: 2 }}>
            Send test
          </Button>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}

/**
 * Fire one cart reminder at a real abandoned checkout, now.
 *
 * The alternative is abandoning a cart yourself and waiting 45 minutes to find
 * out the template is wrong. This sends exactly what the timer sends, without
 * advancing the sequence — so testing does not consume a reminder the customer
 * should still get.
 */
function RecoveryTestModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState('')
  const [stage, setStage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)

  useEffect(() => {
    fetch('/api/recovery/test', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => (j.error ? setError(j.error) : setData(j)))
      .catch((e) => setError(e.message))
  }, [])

  const checkouts: any[] = data?.checkouts ?? []
  const chosen = checkouts.find((c) => c.id === picked)

  async function send() {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/recovery/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkout_id: picked, stage }),
      })
      const json = await res.json()
      setResult(res.ok ? json : { ok: false, error: json.error })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Test cart recovery"
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!chosen || !!chosen.blocked}
            onClick={send}
          >
            Send reminder {stage} now
          </Button>
        </>
      }
    >
      <div
        className="mb-3 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed"
        style={{ background: 'var(--w-ambertint)', color: '#92400E' }}
      >
        This sends a <b>real WhatsApp message to a real customer</b> — same template, cart link and
        discount the timer would use. It does not advance the sequence, so the customer still receives
        their scheduled reminders.
      </div>

      {error && (
        <div className="mb-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}

      {!data ? (
        <TableSkeleton rows={4} cols={3} />
      ) : checkouts.length === 0 ? (
        <EmptyState
          title="No checkouts yet"
          body="Abandon a cart in your store — leave checkout after entering a phone number — and it appears here within seconds."
        />
      ) : (
        <>
          <div className="mb-1.5 text-[12.5px] font-medium">Recent abandoned checkouts</div>
          <div className="max-h-64 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--w-border)' }}>
            {checkouts.map((c) => {
              const on = c.id === picked
              return (
                <button
                  key={c.id}
                  onClick={() => !c.blocked && setPicked(c.id)}
                  disabled={!!c.blocked}
                  className="flex w-full items-start gap-2 border-b px-3 py-2 text-left last:border-b-0"
                  style={{
                    borderColor: 'var(--w-border)',
                    background: on ? 'var(--w-greentint)' : 'transparent',
                    cursor: c.blocked ? 'not-allowed' : 'pointer',
                    opacity: c.blocked ? 0.55 : 1,
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">{c.name || 'Unnamed customer'}</span>
                    <span className="block text-[11.5px]" style={{ color: 'var(--w-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {c.phone ? formatPhone(c.phone) : 'no phone'}
                    </span>
                    <span className="block text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
                      {c.items ?? 0} item(s) · {c.total ?? 0} {c.currency ?? ''} · {relTime(c.createdAt)}
                      {c.remindersSent > 0 && ` · ${c.remindersSent} reminder(s) already sent`}
                    </span>
                    {c.blocked && (
                      <span className="mt-0.5 block text-[11.5px]" style={{ color: '#B91C1C' }}>
                        {c.blocked}
                      </span>
                    )}
                    {!c.blocked && !c.hasCartLink && (
                      <span className="mt-0.5 block text-[11.5px]" style={{ color: '#92400E' }}>
                        No cart link on this checkout — the button will be sent without one.
                      </span>
                    )}
                    {c.lastError && (
                      <span className="mt-0.5 block text-[11.5px]" style={{ color: '#B91C1C' }}>
                        Last error: {c.lastError}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="mt-3 text-[12.5px] font-medium">Which reminder to send</div>
          <div className="mt-1.5 flex gap-1.5">
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                onClick={() => setStage(n)}
                className="cursor-pointer rounded-full border px-3 py-[5px] text-[12.5px] font-medium"
                style={{
                  background: stage === n ? 'var(--w-green)' : 'var(--w-card)',
                  color: stage === n ? '#fff' : 'var(--w-muted)',
                  borderColor: stage === n ? 'var(--w-green)' : 'var(--w-border)',
                }}
              >
                Reminder {n}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
            Each reminder has its own template, variables and discount — test all three.
          </div>

          {result && (
            <div
              className="mt-3 rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed"
              style={{
                background: result.ok ? 'var(--w-greentint)' : 'var(--w-errortint)',
                color: result.ok ? '#15803D' : '#B91C1C',
              }}
            >
              {result.ok ? (
                <>
                  <b>Sent.</b> Reminder {result.stage} went to {formatPhone(result.phone)}.
                  {result.discountCode && ` Discount code: ${result.discountCode}.`} Check the phone — and
                  the Inbox, where the message is mirrored into the thread.
                </>
              ) : (
                <>
                  <b>Not sent.</b> {result.error}
                </>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

function ShopifyModal({ siteUrl, onClose }: { siteUrl: string; onClose: () => void }) {
  const [shop, setShop] = useState('')

  return (
    <Modal
      open
      onClose={onClose}
      title="Connect your Shopify store"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!shop.trim()}
            onClick={() => {
              window.location.href = `/api/shopify/connect?shop=${encodeURIComponent(shop.trim())}`
            }}
          >
            Continue to Shopify
          </Button>
        </>
      }
    >
      <Input
        label="Store domain"
        value={shop}
        onChange={(e) => setShop(e.target.value)}
        placeholder="my-store.myshopify.com"
        hint="You'll be sent to Shopify to approve the permissions, then straight back here."
      />
      <div
        className="mt-3 rounded-[10px] border p-3 text-[12px] leading-relaxed"
        style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
      >
        <div className="mb-1 font-semibold">Redirect URL for the Shopify Partner Dashboard</div>
        <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 }}>
          {siteUrl}/api/shopify/callback
        </code>
        <div className="mt-2" style={{ color: 'var(--w-muted)' }}>
          Paste it under <b>Configuration → URLs → Redirect URLs</b> and release the version. If it is not
          listed there character-for-character, Shopify answers{' '}
          <i>“The redirect_uri is not whitelisted”</i> instead of showing the approval screen.
        </div>
      </div>

      <div className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--w-muted)' }}>
        Wasify requests read access to customers, orders, checkouts, fulfillments and products, plus write
        access to orders (for COD tags) and discounts (for single-use recovery codes). Widening scopes later
        always requires you to re-approve.
      </div>
    </Modal>
  )
}

function ApiKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scopes: ['read'] }),
      })
      const json = await res.json()
      if (res.ok) {
        setSecret(json.secret)
        onCreated()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Generate API key"
      footer={
        secret ? (
          <Button variant="primary" onClick={onClose}>
            I&apos;ve saved it
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={create} disabled={!name.trim()}>
              Generate
            </Button>
          </>
        )
      }
    >
      {secret ? (
        <>
          <div className="mb-2 text-[12.5px] font-semibold">Copy this key now — it is never shown again.</div>
          <div
            className="break-all rounded-lg p-3 text-[12.5px]"
            style={{ background: 'var(--w-card2)', fontFamily: "'JetBrains Mono', monospace" }}
          >
            {secret}
          </div>
        </>
      ) : (
        <Input
          label="Key name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Reporting script"
          hint="Only a SHA-256 hash is stored, so we can never show it to you again."
        />
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* COD + cart recovery configuration                                   */
/* ------------------------------------------------------------------ */

function FeatureConfig({
  config,
  templates,
  onSaved,
}: {
  config: any
  templates: Array<{ name: string; language: string }>
  onSaved: () => void
}) {
  const toast = useToast()
  const [open, setOpen] = useState<'cod' | 'recovery' | null>(null)

  if (!config?.has_token) return null

  return (
    <>
      <div className="mb-5 grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Card>
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[14.5px] font-semibold">COD order confirmation</div>
              <div className="mt-1 text-[12px]" style={{ color: 'var(--w-muted)' }}>
                Ask cash-on-delivery customers to confirm before you ship, with reminders and a no-reply
                cancellation.
              </div>
            </div>
            <Pill tone={config.cod_enabled ? 'green' : 'gray'}>{config.cod_enabled ? 'On' : 'Off'}</Pill>
          </div>
          <div className="mt-3">
            <Button size="sm" variant="primary" onClick={() => setOpen('cod')}>
              Configure
            </Button>
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[14.5px] font-semibold">Abandoned cart recovery</div>
              <div className="mt-1 text-[12px]" style={{ color: 'var(--w-muted)' }}>
                Up to three timed reminders with an optional single-use discount, stopped the moment the
                customer pays.
              </div>
            </div>
            <Pill tone={config.recovery_enabled ? 'green' : 'gray'}>
              {config.recovery_enabled ? 'On' : 'Off'}
            </Pill>
          </div>
          <div className="mt-3">
            <Button size="sm" variant="primary" onClick={() => setOpen('recovery')}>
              Configure
            </Button>
          </div>
        </Card>
      </div>

      {open && (
        <FeatureModal
          kind={open}
          config={config}
          templates={templates}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null)
            onSaved()
            toast('Settings saved')
          }}
        />
      )}
    </>
  )
}

const ORDER_VARS = [
  { key: 'first_name', label: 'First name' },
  { key: 'full_name', label: 'Full name' },
  { key: 'order_number', label: 'Order number' },
  { key: 'total', label: 'Order total' },
  { key: 'currency', label: 'Currency' },
  { key: 'items_count', label: 'Item count' },
  { key: 'shipping_city', label: 'Shipping city' },
  { key: 'static', label: 'Fixed text' },
]

const CART_VARS = [
  { key: 'first_name', label: 'First name' },
  { key: 'full_name', label: 'Full name' },
  { key: 'cart_total', label: 'Cart total' },
  { key: 'currency', label: 'Currency' },
  { key: 'items_count', label: 'Item count' },
  { key: 'discount_code', label: 'Discount code' },
  { key: 'static', label: 'Fixed text' },
]

function FeatureModal({
  kind,
  config,
  templates,
  onClose,
  onSaved,
}: {
  kind: 'cod' | 'recovery'
  config: any
  templates: Array<{ name: string; language: string }>
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<any>({ ...config })
  const [discounts, setDiscounts] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** Reminders whose optional second-language picker has been revealed. */
  const [secondLang, setSecondLang] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (kind === 'recovery') {
      fetch('/api/catalog')
        .then((r) => r.json())
        .then((j) => setDiscounts(j.discounts ?? []))
    }
  }, [kind])

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }))

  async function save() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/settings/shopify', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error)
        return
      }
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  const TemplateSelect = ({ field, label }: { field: string; label: string }) => (
    <Select label={label} value={form[field] ?? ''} onChange={(e) => set(field, e.target.value || null)}>
      <option value="">— none —</option>
      {templates.map((t) => (
        <option key={`${t.name}-${t.language}`} value={t.name}>
          {t.name} ({t.language})
        </option>
      ))}
    </Select>
  )

  const VarMap = ({ field, vars }: { field: string; vars: typeof ORDER_VARS }) => {
    const list: any[] = form[field] ?? []
    return (
      <div className="mt-1.5">
        {list.map((entry, i) => (
          <div key={i} className="mb-1 flex items-center gap-1.5">
            <span
              className="rounded px-1.5 py-0.5 text-[11px] font-bold"
              style={{ background: 'var(--w-card2)', fontFamily: "'JetBrains Mono', monospace" }}
            >
              {`{{${i + 1}}}`}
            </span>
            <select
              value={entry.source ?? 'static'}
              onChange={(e) => {
                const next = [...list]
                next[i] = { ...entry, source: e.target.value }
                set(field, next)
              }}
              className="min-w-0 flex-1 cursor-pointer rounded-lg border px-2 py-1 text-[12px]"
              style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
            >
              {vars.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.label}
                </option>
              ))}
            </select>
            {entry.source === 'static' && (
              <input
                value={entry.value ?? ''}
                onChange={(e) => {
                  const next = [...list]
                  next[i] = { ...entry, value: e.target.value }
                  set(field, next)
                }}
                className="min-w-0 flex-1 rounded-lg border px-2 py-1 text-[12px] outline-none"
                style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
              />
            )}
            <button
              onClick={() => set(field, list.filter((_, j) => j !== i))}
              className="cursor-pointer border-0 bg-transparent p-1"
              style={{ color: 'var(--w-muted)' }}
            >
              ×
            </button>
          </div>
        ))}
        <Button size="sm" onClick={() => set(field, [...list, { source: 'first_name' }])}>
          + Variable
        </Button>
      </div>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'cod' ? 'COD order confirmation' : 'Abandoned cart recovery'}
      width={680}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save settings
          </Button>
        </>
      }
    >
      {kind === 'cod' ? (
        <>
          <label className="mb-4 flex items-center gap-3">
            <input
              type="checkbox"
              checked={form.cod_enabled ?? false}
              onChange={(e) => set('cod_enabled', e.target.checked)}
              className="h-4 w-4 cursor-pointer"
              style={{ accentColor: '#16A34A' }}
            />
            <span className="text-[13px] font-medium">Enable COD confirmation</span>
          </label>

          <TemplateSelect field="cod_confirm_template" label="Confirmation template (sent immediately)" />
          <VarMap field="cod_confirm_var_map" vars={ORDER_VARS} />

          <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <Input
              label="Reminder 1 after (hours)"
              type="number"
              value={String(form.cod_reminder1_hours ?? 24)}
              onChange={(e) => set('cod_reminder1_hours', Number(e.target.value))}
            />
            <Input
              label="Reminder 2 after (hours)"
              type="number"
              value={String(form.cod_reminder2_hours ?? 48)}
              onChange={(e) => set('cod_reminder2_hours', Number(e.target.value))}
            />
          </div>

          <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <TemplateSelect field="cod_reminder1_template" label="Reminder 1 template" />
            <TemplateSelect field="cod_reminder2_template" label="Reminder 2 template" />
          </div>

          <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <Input
              label="Cancel with no reply after (hours)"
              type="number"
              value={String(form.cod_no_reply_hours ?? 72)}
              onChange={(e) => set('cod_no_reply_hours', Number(e.target.value))}
            />
            <TemplateSelect field="cod_no_reply_template" label="No-reply template" />
          </div>

          <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <Input
              label='"Yes" keywords'
              value={(form.cod_yes_keywords ?? []).join(', ')}
              onChange={(e) => set('cod_yes_keywords', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
            />
            <Input
              label='"No" keywords'
              value={(form.cod_no_keywords ?? []).join(', ')}
              onChange={(e) => set('cod_no_keywords', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
            />
          </div>

          <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <Input label="Pending tag" value={form.cod_tag_pending ?? ''} onChange={(e) => set('cod_tag_pending', e.target.value)} />
            <Input label="Confirmed tag" value={form.cod_tag_confirmed ?? ''} onChange={(e) => set('cod_tag_confirmed', e.target.value)} />
            <Input label="Cancelled tag" value={form.cod_tag_cancelled ?? ''} onChange={(e) => set('cod_tag_cancelled', e.target.value)} />
          </div>

          <div className="mt-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--w-muted)' }}>
            Only live <b>orders/create</b> webhooks start a confirmation — importing historical orders never
            messages anyone. Matching ignores accents and case, so &quot;Sí&quot; and &quot;si&quot; both work.
          </div>
        </>
      ) : (
        <>
          <label className="mb-4 flex items-center gap-3">
            <input
              type="checkbox"
              checked={form.recovery_enabled ?? false}
              onChange={(e) => set('recovery_enabled', e.target.checked)}
              className="h-4 w-4 cursor-pointer"
              style={{ accentColor: '#16A34A' }}
            />
            <span className="text-[13px] font-medium">Enable cart recovery</span>
          </label>

          <div className="mb-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <Input
              label="1st after (min)"
              type="number"
              value={String(form.recovery_delay1_minutes ?? 45)}
              onChange={(e) => set('recovery_delay1_minutes', Number(e.target.value))}
            />
            <Input
              label="2nd after (min)"
              type="number"
              value={String(form.recovery_delay2_minutes ?? 1440)}
              onChange={(e) => set('recovery_delay2_minutes', Number(e.target.value))}
            />
            <Input
              label="3rd after (min)"
              type="number"
              value={String(form.recovery_delay3_minutes ?? 2880)}
              onChange={(e) => set('recovery_delay3_minutes', Number(e.target.value))}
            />
            <Input
              label="Cooldown (days)"
              type="number"
              value={String(form.recovery_cooldown_days ?? 7)}
              onChange={(e) => set('recovery_cooldown_days', Number(e.target.value))}
              hint="Skip repeat chasing"
            />
          </div>

          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="mb-3 rounded-[10px] border p-3"
              style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
            >
              <div className="mb-2 text-[12.5px] font-semibold">Reminder {n}</div>

              {/* One template is the normal case. The second language stays
                  available for stores that need it, but does not clutter the
                  form until it is asked for. */}
              <TemplateSelect field={`recovery_r${n}_template_en`} label="Template" />

              {form[`recovery_r${n}_template_es`] || secondLang.has(n) ? (
                <div className="mt-2.5">
                  <TemplateSelect
                    field={`recovery_r${n}_template_es`}
                    label="Spanish template (used when the customer's locale is Spanish)"
                  />
                </div>
              ) : (
                <button
                  onClick={() => setSecondLang((p) => new Set(p).add(n))}
                  className="mt-1.5 cursor-pointer text-[12px] font-medium"
                  style={{ color: '#16A34A', background: 'none', border: 0, padding: 0 }}
                >
                  + Add a Spanish version
                </button>
              )}
              <VarMap field={`recovery_r${n}_var_map`} vars={CART_VARS} />
              <div className="mt-2">
                <Select
                  label="Attach a discount (optional)"
                  value={form[`recovery_r${n}_discount_id`] ?? ''}
                  onChange={(e) => set(`recovery_r${n}_discount_id`, e.target.value || null)}
                >
                  <option value="">— no discount —</option>
                  {discounts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ))}

          <Input
            label="STOP keywords"
            value={(form.recovery_stop_keywords ?? []).join(', ')}
            onChange={(e) =>
              set('recovery_stop_keywords', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))
            }
            hint="Sending any of these opts the customer out of marketing. COD confirmations are unaffected."
          />

          <div
            className="mt-3 rounded-lg px-3 py-2 text-[11.5px] leading-relaxed"
            style={{ background: 'var(--w-ambertint)', color: '#92400E' }}
          >
            The template&apos;s URL button must be a <b>Dynamic URL</b> whose base is
            <code style={{ fontFamily: "'JetBrains Mono', monospace" }}> https://{config.store_domain}/{'{{1}}'}</code> —
            Wasify sends only the path and query of the cart link as the value. The checkout is re-read
            immediately before every send, so a customer who has already paid is never messaged.
          </div>
        </>
      )}

      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}
