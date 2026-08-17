'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase/client'
import { appendMessage, sessionWindow } from '@/lib/window'
import { avatarColors, formatPhone, initialsOf } from '@/lib/phone'
import { Button, Modal, Pill, money, relTime, useToast } from '@/components/ui'
import {
  IconChevronLeft, IconPaperclip, IconPlus, IconSearch, IconSend, IconSmile, IconTemplates,
} from '@/components/icons'
import type { Agent, MessageTemplate } from '@/lib/types'

const FILTERS = ['All', 'Unassigned', 'Mine', 'Open', 'Pending', 'Closed'] as const
type Filter = (typeof FILTERS)[number]

type Conv = {
  id: string
  contact_id: string
  status: string
  assigned_to: string | null
  labels: string[]
  last_message_text: string | null
  last_message_at: string | null
  last_inbound_at: string | null
  unread_count: number
  contacts: {
    id: string
    name: string | null
    phone: string
    rfm_segment: string | null
    locale: string | null
    opt_in_status: string | null
  } | null
}

type Msg = {
  id: string
  conversation_id: string
  sender_type: string
  sender_name: string | null
  content_type: string
  content: string | null
  media_url: string | null
  media_mime: string | null
  media_filename: string | null
  message_id: string | null
  template_name: string | null
  status: string
  error_message: string | null
  is_internal_note: boolean
  created_at: string
}

type CannedReply = { id: string; shortcut: string; body: string }

export function InboxClient({
  agents,
  selfAgentId,
  cannedReplies,
  templates,
}: {
  agents: Agent[]
  selfAgentId: string | null
  cannedReplies: CannedReply[]
  templates: MessageTemplate[]
}) {
  const toast = useToast()

  const [convs, setConvs] = useState<Conv[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [loadingThread, setLoadingThread] = useState(false)
  const [filter, setFilter] = useState<Filter>('All')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'reply' | 'note'>('reply')
  const [sending, setSending] = useState(false)

  const [compact, setCompact] = useState(false)
  const [pane, setPane] = useState<'list' | 'thread' | 'info'>('list')
  const [templateOpen, setTemplateOpen] = useState(false)
  const [newChatOpen, setNewChatOpen] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  /** Blocks a second click firing another REAL send before the first returns. */
  const sendingTemplateRef = useRef(false)

  /* ------------------------------ layout ------------------------------ */

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1300px)')
    const apply = () => setCompact(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  /* ---------------------------- data loads ---------------------------- */

  const loadConversations = useCallback(async () => {
    const res = await fetch('/api/conversations?limit=200', { cache: 'no-store' })
    const json = await res.json()
    if (res.ok) setConvs(json.conversations ?? [])
    else toast(json.error ?? 'Could not load conversations', 'red')
  }, [toast])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  const loadThread = useCallback(async (id: string) => {
    setLoadingThread(true)
    try {
      const res = await fetch(`/api/conversations/${id}/messages`, { cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setMessages(json.messages ?? [])
    } finally {
      setLoadingThread(false)
    }
  }, [])

  const openConversation = useCallback(
    async (id: string) => {
      setActiveId(id)
      setDraft('')
      setMode('reply')
      if (compact) setPane('thread')
      await loadThread(id)
      // Clear the badge locally, then persist + send the read receipt.
      setConvs((prev) => prev?.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)) ?? prev)
      fetch(`/api/conversations/${id}/read`, { method: 'POST' }).catch(() => {})
    },
    [compact, loadThread]
  )

  /* ------------------------------ realtime ---------------------------- */

  useEffect(() => {
    const sb = supabaseBrowser()
    const channel = sb
      .channel('inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => {
        loadConversations()
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new as Msg
        setMessages((prev) => (m.conversation_id === activeIdRef.current ? appendMessage(prev, m) : prev))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new as Msg
        setMessages((prev) => prev.map((p) => (p.id === m.id ? { ...p, ...m } : p)))
      })
      .subscribe()

    // Reconnect / tab-visible resync so a dropped socket never silently stales.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        loadConversations()
        if (activeIdRef.current) loadThread(activeIdRef.current)
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      sb.removeChannel(channel)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadConversations, loadThread])

  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, activeId])

  /* ----------------------------- filtering ---------------------------- */

  const filtered = useMemo(() => {
    if (!convs) return null
    const needle = search.trim().toLowerCase()
    const digits = search.replace(/\D/g, '')

    return convs.filter((c) => {
      if (filter === 'Unassigned' && c.assigned_to) return false
      if (filter === 'Mine' && c.assigned_to !== selfAgentId) return false
      if (filter === 'Open' && c.status !== 'open') return false
      if (filter === 'Pending' && c.status !== 'pending') return false
      if (filter === 'Closed' && c.status !== 'closed') return false

      if (!needle) return true
      return (
        c.contacts?.name?.toLowerCase().includes(needle) ||
        (digits.length >= 3 && c.contacts?.phone?.includes(digits)) ||
        c.last_message_text?.toLowerCase().includes(needle)
      )
    })
  }, [convs, filter, search, selfAgentId])

  const active = convs?.find((c) => c.id === activeId) ?? null
  const win = sessionWindow(active?.last_inbound_at)

  /* ------------------------------ actions ----------------------------- */

  async function send() {
    const text = draft.trim()
    if (!text || !activeId || sending) return

    setSending(true)
    const kind = mode === 'note' ? 'note' : 'text'
    const optimisticId = `tmp-${Date.now()}`

    if (kind === 'text') {
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          conversation_id: activeId,
          sender_type: 'agent',
          sender_name: null,
          content_type: 'text',
          content: text,
          media_url: null,
          media_mime: null,
          media_filename: null,
          message_id: null,
          template_name: null,
          status: 'sending',
          error_message: null,
          is_internal_note: false,
          created_at: new Date().toISOString(),
        },
      ])
    }
    setDraft('')

    try {
      const res = await fetch(`/api/conversations/${activeId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, body: text }),
      })
      const json = await res.json()

      if (!res.ok) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === optimisticId ? { ...m, status: 'failed', error_message: json.error } : m
          )
        )
        toast(json.error ?? 'Could not send', 'red')
        if (json.code === 'window_expired') setTemplateOpen(true)
        return
      }

      setMessages((prev) => appendMessage(prev, json.message, optimisticId))
      loadConversations()
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? { ...m, status: 'failed', error_message: e.message } : m))
      )
      toast('Network error while sending', 'red')
    } finally {
      setSending(false)
    }
  }

  async function sendTemplate(name: string, language: string, variables: string[], headerImage?: string) {
    if (!activeId) return

    // A ref, not state: two clicks in the same tick both read the old state
    // value and both get through. This is a REAL WhatsApp message — a double
    // click used to send the customer the same template twice.
    if (sendingTemplateRef.current) return
    sendingTemplateRef.current = true

    try {
      const res = await fetch(`/api/conversations/${activeId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'template',
          template_name: name,
          template_language: language,
          variables,
          header_image_url: headerImage || undefined,
        }),
      })
      const json = await res.json()

      if (!res.ok) {
        toast(json.error ?? 'Template send failed', 'red')
        return
      }

      setTemplateOpen(false)
      // Realtime already delivered this row — appending it again is what put
      // every template in the thread twice.
      setMessages((prev) => appendMessage(prev, json.message))
      toast('Template sent')
      loadConversations()
    } catch (e: any) {
      toast(e?.message ?? 'Network error while sending', 'red')
    } finally {
      sendingTemplateRef.current = false
    }
  }

  async function setStatus(status: string) {
    if (!activeId) return
    await fetch(`/api/conversations/${activeId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    toast(status === 'closed' ? 'Conversation closed' : `Marked ${status}`)
    loadConversations()
  }

  async function assign(agentId: string | null) {
    if (!activeId) return
    await fetch(`/api/conversations/${activeId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    })
    const agent = agents.find((a) => a.id === agentId)
    toast(agent ? `Assigned to ${agent.name}` : 'Unassigned')
    loadConversations()
  }

  async function bulk(action: 'assign' | 'close') {
    const ids = [...selected]
    if (!ids.length) return
    await fetch('/api/conversations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action, agent_id: action === 'assign' ? selfAgentId : undefined }),
    })
    toast(action === 'close' ? 'Selected conversations closed' : `${ids.length} conversations assigned`)
    setSelected(new Set())
    loadConversations()
  }

  /* --------------------------- canned replies -------------------------- */

  const cannedOpen = draft.startsWith('/') && mode === 'reply'
  const cannedMatches = cannedReplies.filter((c) =>
    c.shortcut.toLowerCase().startsWith(draft.slice(1).toLowerCase())
  )

  /* ------------------------------- render ------------------------------ */

  const showList = !compact || pane === 'list'
  const showThread = !compact || pane === 'thread'
  const showInfo = !compact || pane === 'info'

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      {/* ---------------------------- LIST ---------------------------- */}
      {showList && (
        <div
          className="flex flex-col"
          style={{
            width: compact ? '100%' : 320,
            minWidth: compact ? 0 : 320,
            background: 'var(--w-card)',
            borderRight: '1px solid var(--w-border)',
          }}
        >
          <div className="flex items-center justify-between px-3.5 pb-2 pt-3.5">
            <div className="text-[17px] font-bold" style={{ fontFamily: "'Manrope', sans-serif" }}>
              Inbox
            </div>
            {selected.size > 0 ? (
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => bulk('assign')}>
                  Assign
                </Button>
                <Button size="sm" onClick={() => bulk('close')}>
                  Close
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="primary" onClick={() => setNewChatOpen(true)}>
                <IconPlus size={13} /> New
              </Button>
            )}
          </div>

          <div className="px-3.5 pb-2">
            <div
              className="flex items-center gap-2 rounded-lg border px-3 py-[7px]"
              style={{ background: 'var(--w-canvas)', borderColor: 'var(--w-border)' }}
            >
              <IconSearch size={14} style={{ color: '#6B7280' }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search conversations"
                className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 px-3.5 pb-2.5">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="cursor-pointer rounded-full border px-2.5 py-[3px] text-[11.5px] font-medium"
                style={{
                  background: filter === f ? '#16A34A' : 'var(--w-card)',
                  color: filter === f ? '#fff' : 'var(--w-muted)',
                  borderColor: filter === f ? '#16A34A' : 'var(--w-border)',
                }}
              >
                {f}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {filtered === null && (
              <div className="flex flex-col gap-2 p-3.5">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="w-skel" style={{ height: 54 }} />
                ))}
              </div>
            )}

            {filtered?.length === 0 && (
              <div className="px-5 py-10 text-center text-[13px]" style={{ color: 'var(--w-muted)' }}>
                {search || filter !== 'All'
                  ? 'No conversations match this filter.'
                  : 'No conversations yet. They appear here the moment someone messages your WhatsApp number.'}
              </div>
            )}

            {filtered?.map((c) => {
              const isActive = c.id === activeId
              const name = c.contacts?.name || formatPhone(c.contacts?.phone)
              const colors = avatarColors(c.contacts?.phone ?? c.id)
              const w = sessionWindow(c.last_inbound_at)

              return (
                <div
                  key={c.id}
                  onClick={() => openConversation(c.id)}
                  className="flex cursor-pointer gap-2.5 px-3.5 py-[11px]"
                  style={{
                    borderBottom: '1px solid var(--w-border)',
                    borderLeft: `3px solid ${isActive ? '#16A34A' : 'transparent'}`,
                    background: isActive ? 'var(--w-greentint)' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      setSelected((prev) => {
                        const next = new Set(prev)
                        e.target.checked ? next.add(c.id) : next.delete(c.id)
                        return next
                      })
                    }}
                    className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer"
                    style={{ accentColor: '#16A34A' }}
                  />
                  <span
                    className="flex h-9 w-9 min-w-9 items-center justify-center rounded-full text-[12px] font-bold"
                    style={{ background: colors.bg, color: colors.fg }}
                  >
                    {initialsOf(c.contacts?.name, c.contacts?.phone)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13.5px] font-semibold">{name}</span>
                      <span className="shrink-0 text-[11px]" style={{ color: 'var(--w-muted)' }}>
                        {relTime(c.last_message_at)}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="truncate text-[12px]" style={{ color: 'var(--w-muted)' }}>
                        {c.last_message_text || 'No messages yet'}
                      </span>
                      {c.unread_count > 0 && (
                        <span
                          className="shrink-0 rounded-full px-[6px] py-px text-[10.5px] font-bold text-white"
                          style={{ background: '#22C55E' }}
                        >
                          {c.unread_count}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      <span
                        className="text-[10.5px] font-semibold"
                        style={{ color: w.open ? '#16A34A' : 'var(--w-muted)' }}
                      >
                        ⏱ {w.label}
                      </span>
                      {(c.labels ?? []).slice(0, 2).map((l) => (
                        <span
                          key={l}
                          className="rounded px-1.5 py-px text-[10px] font-semibold"
                          style={{ background: 'var(--w-infotint)', color: '#2563EB' }}
                        >
                          {l}
                        </span>
                      ))}
                    </span>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* --------------------------- THREAD --------------------------- */}
      {showThread && (
        <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--w-chatbg)' }}>
          {!active ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <div>
                <div className="text-[15px] font-semibold">Select a conversation</div>
                <div className="mt-1 text-[13px]" style={{ color: 'var(--w-muted)' }}>
                  Pick a chat on the left, or start a new one.
                </div>
              </div>
            </div>
          ) : (
            <>
              <div
                className="flex min-h-[54px] items-center gap-2.5 px-4 py-2"
                style={{ background: 'var(--w-card)', borderBottom: '1px solid var(--w-border)' }}
              >
                {compact && (
                  <button
                    onClick={() => setPane('list')}
                    className="cursor-pointer border-0 bg-transparent p-1"
                    style={{ color: 'var(--w-muted)' }}
                  >
                    <IconChevronLeft size={20} />
                  </button>
                )}
                <span
                  className="flex h-[34px] w-[34px] items-center justify-center rounded-full text-[12px] font-bold"
                  style={{ background: '#F0FDF4', color: '#16A34A' }}
                >
                  {initialsOf(active.contacts?.name, active.contacts?.phone)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-bold">
                    {active.contacts?.name || formatPhone(active.contacts?.phone)}
                  </div>
                  <div
                    className="truncate text-[11.5px]"
                    style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--w-muted)' }}
                  >
                    +{active.contacts?.phone}
                  </div>
                </div>

                <select
                  value={active.assigned_to ?? ''}
                  onChange={(e) => assign(e.target.value || null)}
                  className="cursor-pointer rounded-lg border px-2 py-1 text-[12px]"
                  style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                >
                  <option value="">Unassigned</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>

                <select
                  value={active.status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="cursor-pointer rounded-lg border px-2 py-1 text-[12px]"
                  style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
                >
                  <option value="open">Open</option>
                  <option value="pending">Pending</option>
                  <option value="closed">Closed</option>
                </select>

                {compact && (
                  <button
                    onClick={() => setPane('info')}
                    className="cursor-pointer whitespace-nowrap border-0 bg-transparent text-[12px] font-semibold"
                    style={{ color: '#16A34A' }}
                  >
                    Customer ›
                  </button>
                )}
              </div>

              <div ref={scrollRef} className="w-chat-canvas min-h-0 flex-1 overflow-y-auto px-[22px] py-[18px]">
                {loadingThread && messages.length === 0 && (
                  <div className="flex flex-col gap-2">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div
                        key={i}
                        className="w-skel"
                        style={{ height: 38, width: `${40 + (i % 3) * 15}%`, marginLeft: i % 2 ? 'auto' : 0 }}
                      />
                    ))}
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  {messages.map((m, i) => (
                    <MessageBubble
                      key={m.id}
                      message={m}
                      showDivider={needsDivider(messages[i - 1], m)}
                    />
                  ))}
                </div>

                {!win.open && messages.length > 0 && (
                  <div className="mt-4 flex justify-center">
                    <div
                      className="max-w-md rounded-[10px] border px-3.5 py-2.5 text-center text-[12.5px]"
                      style={{ background: 'var(--w-ambertint)', borderColor: '#FDE68A', color: '#92400E' }}
                    >
                      ⚠️ Session closed — 24h window expired. A template message is required to re-open the
                      conversation.
                      <div className="mt-2">
                        <Button size="sm" onClick={() => setTemplateOpen(true)}>
                          Pick template
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* composer */}
              <div className="relative px-3.5 pb-3.5 pt-2" style={{ background: 'var(--w-card)' }}>
                {cannedOpen && cannedMatches.length > 0 && (
                  <div
                    className="absolute bottom-full left-3.5 right-3.5 mb-2 rounded-[10px] border p-1.5"
                    style={{
                      background: 'var(--w-card)',
                      borderColor: 'var(--w-border)',
                      boxShadow: '0 -4px 16px rgba(16,24,40,.08)',
                    }}
                  >
                    <div
                      className="px-2 pb-1 pt-1 text-[11px] font-bold uppercase tracking-[.05em]"
                      style={{ color: 'var(--w-muted)' }}
                    >
                      Canned replies
                    </div>
                    {cannedMatches.slice(0, 5).map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setDraft(c.body)}
                        className="block w-full cursor-pointer rounded-lg border-0 bg-transparent px-2 py-1.5 text-left"
                      >
                        <span
                          className="text-[12px] font-bold"
                          style={{ fontFamily: "'JetBrains Mono', monospace", color: '#16A34A' }}
                        >
                          /{c.shortcut}
                        </span>
                        <span className="ml-2 text-[12px]" style={{ color: 'var(--w-muted)' }}>
                          {c.body.slice(0, 60)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="mb-2 flex items-center gap-1.5">
                  <button
                    onClick={() => setMode('reply')}
                    className="cursor-pointer rounded-full border-0 px-2.5 py-[3px] text-[11.5px] font-semibold"
                    style={{
                      background: mode === 'reply' ? '#16A34A' : 'var(--w-canvas)',
                      color: mode === 'reply' ? '#fff' : 'var(--w-muted)',
                    }}
                  >
                    Reply
                  </button>
                  <button
                    onClick={() => setMode('note')}
                    className="cursor-pointer rounded-full border-0 px-2.5 py-[3px] text-[11.5px] font-semibold"
                    style={{
                      background: mode === 'note' ? '#EAB308' : 'var(--w-canvas)',
                      color: mode === 'note' ? '#fff' : 'var(--w-muted)',
                    }}
                  >
                    Internal note
                  </button>
                  <span className="ml-auto text-[11px]" style={{ color: 'var(--w-muted)' }}>
                    Type / for canned replies
                  </span>
                </div>

                <div
                  className="flex items-end gap-2 rounded-xl border px-2.5 py-2"
                  style={{
                    background: mode === 'note' ? '#FEF9C3' : 'var(--w-canvas)',
                    borderColor: mode === 'note' ? '#FDE047' : 'var(--w-border)',
                  }}
                >
                  <button
                    title="Templates"
                    onClick={() => setTemplateOpen(true)}
                    className="cursor-pointer border-0 bg-transparent p-1"
                    style={{ color: 'var(--w-muted)' }}
                  >
                    <IconTemplates size={18} />
                  </button>
                  <button
                    title="Emoji"
                    onClick={() => setDraft((d) => `${d}🙂`)}
                    className="cursor-pointer border-0 bg-transparent p-1"
                    style={{ color: 'var(--w-muted)' }}
                  >
                    <IconSmile size={18} />
                  </button>
                  <button
                    title="Attach"
                    disabled
                    className="border-0 bg-transparent p-1 opacity-40"
                    style={{ color: 'var(--w-muted)', cursor: 'not-allowed' }}
                  >
                    <IconPaperclip size={18} />
                  </button>

                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        send()
                      }
                    }}
                    rows={1}
                    disabled={mode === 'reply' && !win.open}
                    placeholder={
                      mode === 'note'
                        ? 'Write an internal note — use @ to mention an agent'
                        : win.open
                          ? 'Type a message…'
                          : 'Window expired — send a template to re-open'
                    }
                    className="max-h-32 min-h-[24px] flex-1 resize-none border-0 bg-transparent text-[13.5px] outline-none disabled:cursor-not-allowed"
                  />

                  <Button
                    variant="primary"
                    size="sm"
                    onClick={send}
                    loading={sending}
                    disabled={!draft.trim() || (mode === 'reply' && !win.open)}
                    style={{ borderRadius: 999, padding: '7px 10px' }}
                  >
                    <IconSend size={15} />
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---------------------------- INFO ---------------------------- */}
      {showInfo && active && (
        <ContactPanel
          conversation={active}
          compact={compact}
          onBack={() => setPane('thread')}
          onToast={toast}
        />
      )}

      <TemplatePickerModal
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        templates={templates}
        onSend={sendTemplate}
      />

      <NewChatModal
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        onCreated={async (id) => {
          setNewChatOpen(false)
          await loadConversations()
          openConversation(id)
        }}
      />
    </div>
  )
}

/* ==================================================================== */
/* Message bubble                                                        */
/* ==================================================================== */

function needsDivider(prev: Msg | undefined, current: Msg) {
  if (!prev) return true
  return new Date(prev.created_at).toDateString() !== new Date(current.created_at).toDateString()
}

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })
}

function Ticks({ status }: { status: string }) {
  if (status === 'failed') return <span style={{ color: '#EF4444' }}>✕</span>
  if (status === 'sending') return <span style={{ opacity: 0.5 }}>🕐</span>
  if (status === 'sent') return <span style={{ color: '#9CA3AF' }}>✓</span>
  if (status === 'delivered') return <span style={{ color: '#9CA3AF' }}>✓✓</span>
  if (status === 'read') return <span style={{ color: '#2563EB' }}>✓✓</span>
  return null
}

function MessageBubble({ message: m, showDivider }: { message: Msg; showDivider: boolean }) {
  const outbound = m.sender_type !== 'customer'
  const time = new Date(m.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })

  return (
    <>
      {showDivider && (
        <div className="my-2 flex justify-center">
          <span
            className="rounded-full px-2.5 py-[3px] text-[11px] font-semibold"
            style={{ background: 'rgba(0,0,0,.08)', color: 'var(--w-muted)' }}
          >
            {dayLabel(m.created_at)}
          </span>
        </div>
      )}

      {m.is_internal_note ? (
        <div className="flex justify-center">
          <div
            className="max-w-[75%] rounded-[10px] border px-3 py-2 text-[12.5px]"
            style={{ background: '#FEF9C3', borderColor: '#FDE047', color: '#854D0E' }}
          >
            <div className="mb-0.5 text-[11px] font-bold">
              📝 Internal note · {m.sender_name || 'You'}:
            </div>
            {m.content}
          </div>
        </div>
      ) : (
        <div className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
          <div
            className={outbound ? 'wbubout' : 'wbubin'}
            style={{
              maxWidth: '72%',
              background: outbound ? 'var(--w-bubble-out)' : 'var(--w-bubble-in)',
              color: '#111827',
              borderRadius: 10,
              padding: '7px 10px 5px',
              boxShadow: '0 1px 1px rgba(0,0,0,.08)',
            }}
          >
            {(m.content_type === 'image' || m.content_type === 'template') && m.media_url && (
              // Templates with an image header carry their image here — the
              // thread must show what the customer actually received.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={m.media_url}
                alt={m.media_filename || 'image'}
                className="mb-1 max-h-64 rounded-md"
                style={{ maxWidth: '100%' }}
              />
            )}

            {(m.content_type === 'document' || m.content_type === 'audio' || m.content_type === 'video') && (
              <div
                className="mb-1 flex items-center gap-2 rounded-md px-2 py-1.5"
                style={{ background: 'rgba(0,0,0,.05)' }}
              >
                <IconPaperclip size={15} />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-semibold">
                    {m.media_filename || m.content_type}
                  </span>
                  <span className="block text-[11px] opacity-70">{m.media_mime || ''}</span>
                </span>
              </div>
            )}

            {m.template_name && (
              <div className="mb-1 text-[10.5px] font-bold uppercase tracking-[.04em]" style={{ opacity: 0.55 }}>
                Template · {m.template_name}
              </div>
            )}

            <div className="whitespace-pre-wrap break-words text-[13.5px] leading-snug">{m.content}</div>

            <div className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px]" style={{ opacity: 0.6 }}>
              {time}
              {outbound && <Ticks status={m.status} />}
            </div>

            {m.status === 'failed' && m.error_message && (
              <div className="mt-1 text-[11px]" style={{ color: '#B91C1C' }}>
                {m.error_message}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/* ==================================================================== */
/* Right rail — customer 360                                             */
/* ==================================================================== */

function ContactPanel({
  conversation,
  compact,
  onBack,
  onToast,
}: {
  conversation: Conv
  compact: boolean
  onBack: () => void
  onToast: (t: string, tone?: any) => void
}) {
  const [detail, setDetail] = useState<any>(null)

  useEffect(() => {
    setDetail(null)
    fetch(`/api/contacts/${conversation.contact_id}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => {})
  }, [conversation.contact_id])

  const c = detail?.contact
  const section = 'mb-1.5 mt-4 text-[10.5px] font-bold uppercase tracking-[.06em]'

  return (
    <div
      className="overflow-y-auto"
      style={{
        width: compact ? '100%' : 300,
        minWidth: compact ? 0 : 300,
        background: 'var(--w-card)',
        borderLeft: '1px solid var(--w-border)',
      }}
    >
      {compact && (
        <button
          onClick={onBack}
          className="flex min-h-11 w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-4 text-[13px]"
          style={{ borderBottom: '1px solid var(--w-border)', color: 'var(--w-text)' }}
        >
          <IconChevronLeft size={17} /> Back to chat
        </button>
      )}

      <div className="px-4 py-5 text-center">
        <span
          className="mx-auto mb-2.5 flex h-14 w-14 items-center justify-center rounded-full text-[18px] font-bold"
          style={{ background: '#F0FDF4', color: '#16A34A' }}
        >
          {initialsOf(conversation.contacts?.name, conversation.contacts?.phone)}
        </span>
        <div className="text-[15px] font-bold">
          {conversation.contacts?.name || formatPhone(conversation.contacts?.phone)}
        </div>
        <div className="text-[12px]" style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--w-muted)' }}>
          +{conversation.contacts?.phone}
        </div>
        {c?.email && (
          <div className="truncate text-[12px]" style={{ color: 'var(--w-muted)' }}>
            {c.email}
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap justify-center gap-1.5">
          {(detail?.tags ?? []).map((t: any) => (
            <span
              key={t.id}
              className="rounded-full px-2 py-[2px] text-[11px] font-semibold"
              style={{ background: 'var(--w-greentint)', color: '#16A34A' }}
            >
              {t.name}
            </span>
          ))}
          {c?.opt_in_status === 'opted_in' && (
            <span
              className="rounded-full px-2 py-[2px] text-[11px] font-semibold"
              style={{ background: 'var(--w-greentint)', color: '#16A34A' }}
            >
              opted-in
            </span>
          )}
          {c?.opt_in_status === 'opted_out' && (
            <span
              className="rounded-full px-2 py-[2px] text-[11px] font-semibold"
              style={{ background: 'var(--w-errortint)', color: '#DC2626' }}
            >
              opted-out
            </span>
          )}
        </div>
      </div>

      <div className="px-4 pb-6">
        <div className="flex items-center justify-between">
          <div className={section} style={{ color: 'var(--w-muted)', margin: 0 }}>
            Shopify
          </div>
          {c?.rfm_segment && <Pill tone="blue">{c.rfm_segment.toUpperCase()}</Pill>}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {[
            ['Total spent', money(c?.lifetime_spent ?? 0)],
            ['Orders', String(c?.orders_count ?? 0)],
            ['AOV', money(c?.avg_order_value ?? 0)],
            ['Last order', c?.last_order_at ? relTime(c.last_order_at) : '—'],
            ['Country', c?.country || '—'],
            ['Accepts mktg', c?.accepts_marketing ? 'Yes ✓' : 'No'],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-lg border px-2.5 py-2"
              style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
            >
              <div className="text-[10.5px]" style={{ color: 'var(--w-muted)' }}>
                {label}
              </div>
              <div className="mt-0.5 truncate text-[13px] font-bold">{value}</div>
            </div>
          ))}
        </div>

        <div className={section} style={{ color: 'var(--w-muted)' }}>
          Recent orders
        </div>
        {(detail?.orders ?? []).length === 0 ? (
          <div className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
            No orders yet.
          </div>
        ) : (
          (detail?.orders ?? []).slice(0, 3).map((o: any) => (
            <div
              key={o.id}
              className="flex items-center justify-between gap-2 py-2"
              style={{ borderBottom: '1px solid var(--w-border)' }}
            >
              <span className="min-w-0">
                <span
                  className="block truncate text-[12.5px] font-semibold"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  #{o.order_number || o.shopify_order_id}
                </span>
                <span className="block text-[11px]" style={{ color: 'var(--w-muted)' }}>
                  {relTime(o.shopify_created_at)} · {money(o.total_price, o.currency ?? 'EUR')}
                </span>
              </span>
              <Pill tone={o.financial_status === 'paid' ? 'green' : o.is_cod ? 'amber' : 'gray'}>
                {o.is_cod && o.financial_status !== 'paid' ? 'COD pending' : o.financial_status || 'pending'}
              </Pill>
            </div>
          ))
        )}

        <div className={section} style={{ color: 'var(--w-muted)' }}>
          Open deals
        </div>
        {(detail?.deals ?? []).length === 0 ? (
          <div className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
            No open deals.
          </div>
        ) : (
          (detail?.deals ?? []).map((d: any) => (
            <div
              key={d.id}
              className="mb-1.5 rounded-lg border px-2.5 py-2"
              style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[12.5px] font-bold">{d.title}</span>
                <span className="text-[12.5px] font-bold" style={{ color: '#2563EB' }}>
                  {money(d.value, d.currency)}
                </span>
              </div>
              <div className="text-[11px]" style={{ color: 'var(--w-muted)' }}>
                Stage: {d.stage_name ?? '—'}
              </div>
            </div>
          ))
        )}

        <div className={section} style={{ color: 'var(--w-muted)' }}>
          Browsing &amp; cart
        </div>
        {detail?.openCheckout ? (
          <div className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
            🔗 Checkout started {relTime(detail.openCheckout.shopify_created_at)}, not completed —{' '}
            <b style={{ color: 'var(--w-text)' }}>
              {money(detail.openCheckout.total_price, detail.openCheckout.currency ?? 'EUR')}
            </b>
          </div>
        ) : (
          <div className="text-[12px]" style={{ color: 'var(--w-muted)' }}>
            No open cart right now.
          </div>
        )}

        <div className={section} style={{ color: 'var(--w-muted)' }}>
          Notes
        </div>
        <NoteComposer contactId={conversation.contact_id} notes={detail?.notes ?? []} onSaved={onToast} />
      </div>
    </div>
  )
}

function NoteComposer({
  contactId,
  notes,
  onSaved,
}: {
  contactId: string
  notes: any[]
  onSaved: (t: string) => void
}) {
  const [value, setValue] = useState('')
  const [list, setList] = useState(notes)

  useEffect(() => setList(notes), [notes])

  async function save() {
    const body = value.trim()
    if (!body) return
    const res = await fetch(`/api/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    })
    if (res.ok) {
      const json = await res.json()
      setList((prev) => [json.note, ...prev])
      setValue('')
      onSaved('Note saved')
    }
  }

  return (
    <>
      <div className="flex gap-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="Add a note…"
          className="min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-[12.5px] outline-none"
          style={{ background: 'var(--w-canvas)', borderColor: 'var(--w-border)' }}
        />
        <Button size="sm" onClick={save} disabled={!value.trim()}>
          Add
        </Button>
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        {list.slice(0, 5).map((n: any) => (
          <div
            key={n.id}
            className="rounded-lg px-2.5 py-1.5 text-[12px]"
            style={{ background: 'var(--w-card2)' }}
          >
            {n.body}
            <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--w-muted)' }}>
              {n.author_name || 'You'} · {relTime(n.created_at)}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/* ==================================================================== */
/* Template picker + new chat                                            */
/* ==================================================================== */

export function TemplatePickerModal({
  open,
  onClose,
  templates,
  onSend,
}: {
  open: boolean
  onClose: () => void
  templates: MessageTemplate[]
  onSend: (name: string, language: string, variables: string[], headerImage?: string) => void
}) {
  const [picked, setPicked] = useState<MessageTemplate | null>(null)
  const [vars, setVars] = useState<string[]>([])
  const [headerImage, setHeaderImage] = useState('')

  const approved = templates.filter((t) => t.status === 'APPROVED')

  useEffect(() => {
    if (!open) {
      setPicked(null)
      setVars([])
      setHeaderImage('')
    }
  }, [open])

  const varCount = picked ? countVariables(picked.body_text ?? '') : 0
  const hasImageHeader = ((picked as any)?.header_type ?? 'none') === 'image'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={picked ? `Send "${picked.name}"` : 'Choose a template'}
      width={560}
      footer={
        picked ? (
          <>
            <Button onClick={() => setPicked(null)}>Back</Button>
            <Button
              variant="primary"
              onClick={() => onSend(picked.name, picked.language, vars.slice(0, varCount), headerImage.trim())}
              disabled={
                vars.slice(0, varCount).some((v) => !v?.trim()) || (hasImageHeader && !headerImage.trim())
              }
            >
              Send template
            </Button>
          </>
        ) : null
      }
    >
      {approved.length === 0 && (
        <div className="py-6 text-center text-[13px]" style={{ color: 'var(--w-muted)' }}>
          No Approved templates yet. Sync them from Meta on the Templates screen.
        </div>
      )}

      {!picked &&
        approved.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setPicked(t)
              setVars(Array(countVariables(t.body_text ?? '')).fill(''))
              setHeaderImage((t as any).header_media_url || (t as any).sample_values?.header_url || '')
            }}
            className="mb-1.5 block w-full cursor-pointer rounded-lg border p-3 text-left"
            style={{ background: 'var(--w-card2)', borderColor: 'var(--w-border)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold">{t.name}</span>
              <Pill tone="gray">{t.language}</Pill>
            </div>
            <div className="mt-1 line-clamp-2 text-[12px]" style={{ color: 'var(--w-muted)' }}>
              {t.body_text}
            </div>
          </button>
        ))}

      {picked && (
        <>
          <div
            className="mb-3 overflow-hidden rounded-lg text-[13px] leading-relaxed"
            style={{ background: 'var(--w-bubble-out)', color: '#111827' }}
          >
            {hasImageHeader && headerImage.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={headerImage} alt="" className="w-full object-cover" style={{ maxHeight: 140 }} />
            )}
            <div className="p-3">
              {(picked.body_text ?? '').replace(/\{\{(\d+)\}\}/g, (_m, n) => vars[Number(n) - 1] || `{{${n}}}`)}
            </div>
          </div>

          {hasImageHeader && (
            <label className="mb-2 block">
              <span className="mb-1 block text-[12px] font-medium">Header image URL</span>
              <input
                value={headerImage}
                onChange={(e) => setHeaderImage(e.target.value)}
                placeholder="https://cdn.shopify.com/…/photo.jpg"
                className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
                style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
              />
              <span className="mt-1 block text-[11px]" style={{ color: 'var(--w-muted)' }}>
                This template has an image header — the customer receives this image above the text.
              </span>
            </label>
          )}
          {Array.from({ length: varCount }).map((_, i) => (
            <label key={i} className="mb-2 block">
              <span className="mb-1 block text-[12px] font-medium">Variable {`{{${i + 1}}}`}</span>
              <input
                value={vars[i] ?? ''}
                onChange={(e) => setVars((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
                style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
              />
            </label>
          ))}
          {varCount === 0 && (
            <div className="text-[12.5px]" style={{ color: 'var(--w-muted)' }}>
              This template has no variables.
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

function countVariables(body: string) {
  const found = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
  return found.length ? Math.max(...found) : 0
}

function NewChatModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (conversationId: string) => void
}) {
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not start the chat')
        return
      }
      onCreated(json.conversation_id)
      setPhone('')
      setName('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New conversation"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={create} disabled={!phone.trim()}>
            Start chat
          </Button>
        </>
      }
    >
      <label className="mb-3 block">
        <span className="mb-1.5 block text-[12.5px] font-medium">Phone number</span>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+34 600 123 456"
          className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
          style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
        />
        <span className="mt-1 block text-[11.5px]" style={{ color: 'var(--w-muted)' }}>
          Include the country code. Existing contacts are matched automatically, so replies land in the same
          thread.
        </span>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium">Name (optional)</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
          style={{ background: 'var(--w-card)', borderColor: 'var(--w-border)' }}
        />
      </label>
      {error && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--w-errortint)', color: '#B91C1C' }}>
          {error}
        </div>
      )}
      <div className="mt-3 text-[12px]" style={{ color: 'var(--w-muted)' }}>
        Outside the 24-hour window you can only open with an approved template.
      </div>
    </Modal>
  )
}
