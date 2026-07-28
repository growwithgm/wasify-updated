'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Button, Card, CardTitle, EmptyState, ErrorState, Input, Modal, Page, PageHeader, Pill, Select,
  Table, TableSkeleton, Td, Th, Textarea, Toggle, ToastProvider, num, relTime, useToast,
} from '@/components/ui'
import { IconChatbot, IconPlus, IconSend, IconTrash } from '@/components/icons'

export default function ChatbotPage() {
  return (
    <ToastProvider>
      <ChatbotScreen />
    </ToastProvider>
  )
}

function ChatbotScreen() {
  const toast = useToast()
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  const [ruleModal, setRuleModal] = useState<any>(null)
  const [faqModal, setFaqModal] = useState<any>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/chatbot', { cache: 'no-store' })
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

  async function patchConfig(patch: any) {
    setData((d: any) => ({ ...d, config: { ...d.config, ...patch } }))
    const res = await fetch('/api/chatbot', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      toast('Could not save', 'red')
      load()
    }
  }

  async function deleteRule(id: string) {
    await fetch(`/api/chatbot/rules?id=${id}`, { method: 'DELETE' })
    toast('Rule deleted')
    load()
  }

  async function deleteFaq(id: string) {
    await fetch(`/api/chatbot/faqs?id=${id}`, { method: 'DELETE' })
    toast('FAQ deleted')
    load()
  }

  const config = data?.config

  return (
    <Page>
      <PageHeader
        title="Chatbot & AI Agent"
        subtitle="Keyword rules, knowledge base and automatic replies"
      />

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={load} />
        </div>
      )}

      {!data ? (
        <TableSkeleton rows={6} cols={4} />
      ) : (
        <>
          {/* master switches */}
          <Card className="mb-4">
            <div className="flex flex-wrap items-center gap-6">
              <Toggle
                checked={config?.rules_enabled ?? true}
                onChange={(v) => patchConfig({ rules_enabled: v })}
                label="Keyword auto-reply rules"
                sub="Instant, deterministic replies"
              />
              <Toggle
                checked={config?.faq_enabled ?? true}
                onChange={(v) => patchConfig({ faq_enabled: v })}
                label="FAQ knowledge base"
                sub="Answers matched by word overlap"
              />
              <Toggle
                checked={config?.business_hours_only ?? false}
                onChange={(v) => patchConfig({ business_hours_only: v })}
                label="Business hours only"
                sub="Set your hours in Settings"
              />
            </div>
            <div
              className="mt-3 border-t pt-3 text-[12px] leading-relaxed"
              style={{ borderColor: 'var(--w-border)', color: 'var(--w-muted)' }}
            >
              The bot never replies when a conversation is assigned to an agent, and never outside the 24-hour
              window — both are checked before every send.
            </div>
          </Card>

          <div data-r="grid" className="mb-4 grid gap-3.5" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
            {/* rules */}
            <Card padding={0}>
              <div className="px-5 pb-1 pt-5">
                <CardTitle
                  title="Keyword auto-reply rules"
                  sub="Checked in priority order — the first match wins"
                  right={
                    <Button size="sm" variant="primary" onClick={() => setRuleModal({})}>
                      <IconPlus size={12} /> Rule
                    </Button>
                  }
                />
              </div>

              {data.rules.length === 0 ? (
                <EmptyState
                  title="No rules yet"
                  body='Add a rule like "envío, envio, shipping" → "Enviamos en 24-48h a toda España."'
                  action={
                    <Button variant="primary" onClick={() => setRuleModal({})}>
                      Add your first rule
                    </Button>
                  }
                />
              ) : (
                <Table minWidth={520}>
                  <thead>
                    <tr>
                      <Th>Keywords</Th>
                      <Th>Reply</Th>
                      <Th align="right">Hits</Th>
                      <Th>Status</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.rules.map((r: any) => (
                      <tr key={r.id} className="cursor-pointer" onClick={() => setRuleModal(r)}>
                        <Td>
                          <span className="flex flex-wrap gap-1">
                            {(r.keywords ?? []).slice(0, 4).map((k: string) => (
                              <span
                                key={k}
                                className="rounded px-1.5 py-px text-[11px] font-semibold"
                                style={{ background: 'var(--w-greentint)', color: '#16A34A' }}
                              >
                                {k}
                              </span>
                            ))}
                          </span>
                        </Td>
                        <Td style={{ color: 'var(--w-muted)', fontSize: 12 }}>
                          {r.reply_text.slice(0, 60)}
                          {r.reply_text.length > 60 ? '…' : ''}
                        </Td>
                        <Td align="right">{num(r.hit_count)}</Td>
                        <Td>
                          <Pill tone={r.is_active ? 'green' : 'gray'}>{r.is_active ? 'Active' : 'Off'}</Pill>
                        </Td>
                        <Td align="right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteRule(r.id)
                            }}
                            className="cursor-pointer border-0 bg-transparent p-1"
                            style={{ color: 'var(--w-muted)' }}
                          >
                            <IconTrash size={13} />
                          </button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            {/* simulator */}
            <Simulator />
          </div>

          {/* FAQ */}
          <Card padding={0} className="mb-4">
            <div className="px-5 pb-1 pt-5">
              <CardTitle
                title="FAQ knowledge base"
                sub="Matched by word overlap — a confident match answers, an unsure one stays silent"
                right={
                  <Button size="sm" variant="primary" onClick={() => setFaqModal({})}>
                    <IconPlus size={12} /> Entry
                  </Button>
                }
              />
            </div>

            {data.faqs.length === 0 ? (
              <EmptyState
                title="No FAQ entries"
                body="Add the questions customers ask most. The bot only answers when the match is confident — a wrong answer is worse than no answer."
                action={
                  <Button variant="primary" onClick={() => setFaqModal({})}>
                    Add an entry
                  </Button>
                }
              />
            ) : (
              <Table minWidth={640}>
                <thead>
                  <tr>
                    <Th>Question</Th>
                    <Th>Answer</Th>
                    <Th>Languages</Th>
                    <Th align="right">Used</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {data.faqs.map((f: any) => (
                    <tr key={f.id} className="cursor-pointer" onClick={() => setFaqModal(f)}>
                      <Td className="font-medium">{f.question}</Td>
                      <Td style={{ color: 'var(--w-muted)', fontSize: 12 }}>
                        {f.answer.slice(0, 70)}
                        {f.answer.length > 70 ? '…' : ''}
                      </Td>
                      <Td>{(f.languages ?? []).join(', ')}</Td>
                      <Td align="right">{num(f.used_count)}×</Td>
                      <Td align="right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteFaq(f.id)
                          }}
                          className="cursor-pointer border-0 bg-transparent p-1"
                          style={{ color: 'var(--w-muted)' }}
                        >
                          <IconTrash size={13} />
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {/* AI agent — parked */}
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <div className="text-[14.5px] font-semibold">AI agent</div>
                  <Pill tone="amber">Coming soon</Pill>
                </div>
                <div className="mt-1 max-w-2xl text-[12.5px] leading-relaxed" style={{ color: 'var(--w-muted)' }}>
                  Persona, tone, intent classification, a confidence threshold and automatic handoff to a human
                  are designed and the database is ready — but the LLM is deliberately switched off, so no model
                  is called and there is no per-message cost. Everything above works today without it.
                </div>
              </div>
              <IconChatbot size={30} style={{ color: 'var(--w-muted)', flexShrink: 0 }} />
            </div>

            <div className="mt-4 grid gap-3 opacity-60" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              <Input label="Persona" value={config?.ai_persona ?? ''} disabled placeholder="Friendly shop assistant" />
              <Select label="Tone" value={config?.ai_tone ?? 'warm'} disabled>
                <option value="warm">Warm &amp; concise</option>
                <option value="formal">Formal</option>
                <option value="playful">Playful</option>
              </Select>
              <Input
                label="Confidence threshold"
                value={`${config?.ai_confidence_threshold ?? 70}%`}
                disabled
                hint="Below this, hand off to a human"
              />
            </div>

            {data.handoffs.length > 0 && (
              <>
                <div
                  className="mb-1.5 mt-4 text-[11px] font-bold uppercase tracking-[.05em]"
                  style={{ color: 'var(--w-muted)' }}
                >
                  Handoff log
                </div>
                {data.handoffs.map((h: any) => (
                  <div key={h.id} className="py-1 text-[12.5px]">
                    {h.contacts?.name || `+${h.contacts?.phone}`} — {h.reason ?? 'handed to a human'}{' '}
                    <span style={{ color: 'var(--w-muted)' }}>{relTime(h.created_at)}</span>
                  </div>
                ))}
              </>
            )}
          </Card>
        </>
      )}

      {ruleModal && (
        <RuleModal
          rule={ruleModal}
          onClose={() => setRuleModal(null)}
          onSaved={() => {
            setRuleModal(null)
            load()
            toast('Rule saved')
          }}
        />
      )}

      {faqModal && (
        <FaqModal
          faq={faqModal}
          onClose={() => setFaqModal(null)}
          onSaved={() => {
            setFaqModal(null)
            load()
            toast('FAQ saved')
          }}
        />
      )}
    </Page>
  )
}

/* ------------------------------------------------------------------ */

function Simulator() {
  const [text, setText] = useState('')
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    if (!text.trim()) return
    setBusy(true)
    try {
      const res = await fetch('/api/chatbot/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      setResult(await res.json())
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardTitle title="Try it" sub="Nothing is sent — this runs the same matchers as the live webhook" />

      <div className="w-chat-canvas mb-3 rounded-xl p-3" style={{ minHeight: 150 }}>
        {text && (
          <div className="mb-2 flex justify-start">
            <div
              className="wbubin max-w-[85%] rounded-[10px] px-2.5 py-1.5 text-[13px]"
              style={{ background: 'var(--w-bubble-in)', color: '#111827' }}
            >
              {text}
            </div>
          </div>
        )}

        {result &&
          (result.reply ? (
            <div className="flex justify-end">
              <div
                className="wbubout max-w-[85%] rounded-[10px] px-2.5 py-1.5 text-[13px]"
                style={{ background: 'var(--w-bubble-out)', color: '#111827' }}
              >
                {result.reply}
              </div>
            </div>
          ) : (
            <div className="py-4 text-center text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
              No confident match — the bot would stay silent and leave this for an agent.
            </div>
          ))}

        {!text && !result && (
          <div className="py-8 text-center text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
            Type a customer message below.
          </div>
        )}
      </div>

      <div className="flex gap-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="¿Cuánto tarda el envío?"
          className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-[13px] outline-none"
          style={{ background: 'var(--w-canvas)', borderColor: 'var(--w-border)' }}
        />
        <Button variant="primary" loading={busy} onClick={run} disabled={!text.trim()}>
          <IconSend size={14} />
        </Button>
      </div>

      {result && (
        <div className="mt-2 text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
          {result.matched === 'rule' && (
            <>
              Matched a <b>keyword rule</b> on {result.keywords?.join(', ')}
            </>
          )}
          {result.matched === 'faq' && (
            <>
              Matched the <b>FAQ</b> &quot;{result.question}&quot; with a score of {result.score}
            </>
          )}
          {result.matched === 'none' && <>No rule or FAQ matched.</>}
        </div>
      )}
    </Card>
  )
}

function RuleModal({ rule, onClose, onSaved }: { rule: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    id: rule.id,
    keywords: (rule.keywords ?? []).join(', '),
    match_type: rule.match_type ?? 'contains',
    reply_text: rule.reply_text ?? '',
    priority: rule.priority ?? 0,
    is_active: rule.is_active ?? true,
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/chatbot/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          keywords: form.keywords.split(',').map((k: string) => k.trim()).filter(Boolean),
        }),
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

  return (
    <Modal
      open
      onClose={onClose}
      title={rule.id ? 'Edit rule' : 'New keyword rule'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save rule
          </Button>
        </>
      }
    >
      <Input
        label="Keywords (comma separated)"
        value={form.keywords}
        onChange={(e) => setForm({ ...form, keywords: e.target.value })}
        placeholder="envio, envío, shipping, cuando llega"
        hint="Matching ignores accents and case, and only matches whole words."
        className="mb-3"
      />
      <div className="mb-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Select
          label="Match type"
          value={form.match_type}
          onChange={(e) => setForm({ ...form, match_type: e.target.value })}
        >
          <option value="contains">Contains the word</option>
          <option value="exact">Exact message</option>
          <option value="starts_with">Starts with</option>
          <option value="regex">Regular expression</option>
        </Select>
        <Input
          label="Priority"
          type="number"
          value={String(form.priority)}
          onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
          hint="Higher runs first"
        />
      </div>
      <Textarea
        label="Reply"
        value={form.reply_text}
        rows={3}
        onChange={(e) => setForm({ ...form, reply_text: e.target.value })}
        placeholder="Enviamos en 24-48h a toda España. Envío gratis desde 50 €."
      />
      <div className="mt-3">
        <Toggle checked={form.is_active} onChange={(v) => setForm({ ...form, is_active: v })} label="Active" />
      </div>
      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}

function FaqModal({ faq, onClose, onSaved }: { faq: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    id: faq.id,
    question: faq.question ?? '',
    answer: faq.answer ?? '',
    keywords: (faq.keywords ?? []).join(', '),
    languages: faq.languages ?? ['es'],
    is_active: faq.is_active ?? true,
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/chatbot/faqs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          keywords: form.keywords.split(',').map((k: string) => k.trim()).filter(Boolean),
        }),
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

  return (
    <Modal
      open
      onClose={onClose}
      title={faq.id ? 'Edit FAQ entry' : 'New FAQ entry'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save entry
          </Button>
        </>
      }
    >
      <Input
        label="Question"
        value={form.question}
        onChange={(e) => setForm({ ...form, question: e.target.value })}
        placeholder="¿Cuánto tarda el envío?"
        className="mb-3"
      />
      <Textarea
        label="Answer"
        value={form.answer}
        rows={3}
        onChange={(e) => setForm({ ...form, answer: e.target.value })}
        className="mb-3"
      />
      <Input
        label="Extra keywords (optional, comma separated)"
        value={form.keywords}
        onChange={(e) => setForm({ ...form, keywords: e.target.value })}
        placeholder="entrega, plazo, delivery"
        hint="Improves matching for phrasings the question itself does not contain."
      />
      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
    </Modal>
  )
}
