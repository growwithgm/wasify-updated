-- ============================================================================
-- WASIFY 2.0 — CONSOLIDATED SCHEMA
-- ----------------------------------------------------------------------------
-- Paste this whole file into the Supabase SQL Editor of a BLANK project and
-- run it once. It is idempotent: re-running is safe and will not drop data.
--
-- Tenancy model: one Supabase auth user = one tenant.
--   * every table carries user_id (directly, or via its parent's FK)
--   * RLS policy is always `auth.uid() = user_id`
--   * the browser uses the anon key and relies on RLS
--   * server routes use the service-role key and MUST filter by user_id
--
-- Sections:
--   00  extensions + helpers
--   01  profiles & settings
--   02  contacts, tags, custom fields, consent, suppression
--   03  conversations & messages
--   04  templates
--   05  broadcasts
--   06  segments
--   07  automations
--   08  flows
--   09  chatbot (keyword rules + FAQ; AI fields reserved)
--   10  pipelines & deals
--   11  whatsapp config & webhook log
--   12  shopify config, commerce mirror & webhook log
--   13  COD confirmations
--   14  checkout recovery
--   15  discounts
--   16  agents, api keys, notifications, activity feed
--   17  triggers
--   18  row level security
--   19  realtime publication
-- ============================================================================

-- ============================================================================
-- 00  EXTENSIONS + HELPERS
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";

-- Keeps updated_at honest without every route having to remember.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Digits-only phone, mirroring src/lib/phone.ts sanitizePhone().
create or replace function public.sanitize_phone(input text)
returns text
language sql
immutable
as $$
  select regexp_replace(coalesce(input, ''), '\D', '', 'g');
$$;

-- ============================================================================
-- 01  PROFILES & SETTINGS
-- ============================================================================

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  full_name    text,
  avatar_url   text,
  locale       text not null default 'es',
  onboarded    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One row per tenant: business profile, hours, auto-replies, routing.
create table if not exists public.settings (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null unique references auth.users(id) on delete cascade,
  business_name         text,
  business_category     text,
  business_about        text,
  business_logo_url     text,
  timezone              text not null default 'Europe/Madrid',
  currency              text not null default 'EUR',
  -- business_hours: [{ "day":1, "open":"09:00", "close":"18:00", "closed":false }, …]
  business_hours        jsonb not null default '[]'::jsonb,
  greeting_enabled      boolean not null default false,
  greeting_message      text,
  away_enabled          boolean not null default false,
  away_message          text,
  -- routing_rules: [{ "name":"…", "match":{…}, "assign_to":"<agent uuid>" }, …]
  routing_rules         jsonb not null default '[]'::jsonb,
  auto_close_hours      integer not null default 0,   -- 0 = never auto-close
  notify_email          boolean not null default true,
  notify_push           boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists settings_user_idx on public.settings(user_id);

-- ============================================================================
-- 02  CONTACTS, TAGS, CUSTOM FIELDS, CONSENT, SUPPRESSION
-- ============================================================================

create table if not exists public.contacts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,

  -- phone is the ONLY required field; stored digits-only, country code included
  phone               text not null,
  name                text,
  email               text,
  company             text,
  locale              text,                 -- 'es', 'en', … drives template language
  country             text,
  city                text,
  postcode            text,

  -- commerce rollups, refreshed from shopify_orders
  shopify_customer_id text,
  lifetime_spent      numeric(12,2) not null default 0,
  orders_count        integer not null default 0,
  last_order_at       timestamptz,
  avg_order_value     numeric(12,2) not null default 0,

  -- marketing consent
  opt_in_status       text not null default 'unknown',   -- opted_in | opted_out | unknown
  opt_in_source       text,
  opt_in_at           timestamptz,
  opt_out_at          timestamptz,
  accepts_marketing   boolean not null default false,

  -- RFM, recomputed nightly
  rfm_segment         text,                 -- champions | loyal | at_risk | hibernating | new | …
  rfm_recency         integer,
  rfm_frequency       integer,
  rfm_monetary        integer,
  rfm_computed_at     timestamptz,

  source              text,                 -- shopify | whatsapp | csv | manual | api
  notes_count         integer not null default 0,
  is_blocked          boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- NOTE: deliberately NO unique constraint on (user_id, phone).
-- Dedupe is done in application code via phonesMatch() because the last-8-digit
-- rule cannot be expressed as a plain unique index. CSV import calls the same
-- matcher, which is the fix for the old app's duplicate-contact gap.
create index if not exists contacts_user_idx        on public.contacts(user_id);
create index if not exists contacts_user_phone_idx  on public.contacts(user_id, phone);
create index if not exists contacts_phone_tail_idx  on public.contacts(user_id, right(phone, 8));
create index if not exists contacts_name_trgm_idx   on public.contacts using gin (name gin_trgm_ops);
create index if not exists contacts_rfm_idx         on public.contacts(user_id, rfm_segment);
create index if not exists contacts_optin_idx       on public.contacts(user_id, opt_in_status);

create unique index if not exists contacts_shopify_customer_uidx
  on public.contacts(user_id, shopify_customer_id)
  where shopify_customer_id is not null;

create table if not exists public.tags (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  color       text not null default '#16A34A',
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.contact_tags (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  contact_id  uuid not null references public.contacts(id) on delete cascade,
  tag_id      uuid not null references public.tags(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (contact_id, tag_id)
);

create index if not exists contact_tags_contact_idx on public.contact_tags(contact_id);
create index if not exists contact_tags_tag_idx     on public.contact_tags(tag_id);

create table if not exists public.custom_fields (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  key         text not null,
  label       text not null,
  field_type  text not null default 'text',   -- text | number | date | select | boolean
  options     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  unique (user_id, key)
);

create table if not exists public.contact_custom_values (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  contact_id       uuid not null references public.contacts(id) on delete cascade,
  custom_field_id  uuid not null references public.custom_fields(id) on delete cascade,
  value            text,
  unique (contact_id, custom_field_id)
);

create table if not exists public.contact_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  contact_id  uuid not null references public.contacts(id) on delete cascade,
  body        text not null,
  author_name text,
  created_at  timestamptz not null default now()
);

create index if not exists contact_notes_contact_idx on public.contact_notes(contact_id, created_at desc);

-- Consent log shown on the contact drawer. Append-only.
create table if not exists public.consent_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  contact_id  uuid not null references public.contacts(id) on delete cascade,
  event       text not null,                 -- opt_in | opt_out | resubscribe
  source      text,                          -- website popup | checkout | whatsapp STOP | manual | import
  detail      text,
  keyword     text,                          -- the STOP word they actually sent, if any
  created_at  timestamptz not null default now()
);

create index if not exists consent_events_contact_idx on public.consent_events(contact_id, created_at desc);

-- Hard suppression: never send marketing to these numbers again.
create table if not exists public.suppression_list (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  phone       text not null,
  contact_id  uuid references public.contacts(id) on delete set null,
  reason      text not null default 'opt_out',   -- opt_out | bounced | manual | complaint
  keyword     text,
  source      text,
  created_at  timestamptz not null default now(),
  unique (user_id, phone)
);

-- CSV import jobs (the prototype shows progress + a per-row error report).
create table if not exists public.contact_imports (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  filename       text,
  status         text not null default 'pending',   -- pending | mapping | running | done | failed
  total_rows     integer not null default 0,
  imported_rows  integer not null default 0,
  merged_rows    integer not null default 0,
  skipped_rows   integer not null default 0,
  column_map     jsonb not null default '{}'::jsonb,
  apply_tags     jsonb not null default '[]'::jsonb,
  errors         jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);

-- ============================================================================
-- 03  CONVERSATIONS & MESSAGES
-- ============================================================================

create table if not exists public.conversations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  contact_id         uuid not null references public.contacts(id) on delete cascade,

  status             text not null default 'open',   -- open | pending | closed
  assigned_to        uuid,                            -- -> agents.id
  labels             jsonb not null default '[]'::jsonb,
  -- set by the Snooze action; the cron tick flips the row back to 'open'
  snoozed_until      timestamptz,

  last_message_text  text,
  last_message_at    timestamptz,
  -- anchors the 24h customer-service window; ONLY inbound messages touch it
  last_inbound_at    timestamptz,
  unread_count       integer not null default 0,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, contact_id)
);

create index if not exists conversations_user_idx     on public.conversations(user_id, last_message_at desc);
create index if not exists conversations_status_idx   on public.conversations(user_id, status);
create index if not exists conversations_window_idx   on public.conversations(user_id, last_inbound_at desc);
create index if not exists conversations_assigned_idx on public.conversations(user_id, assigned_to);
create index if not exists conversations_snoozed_idx  on public.conversations(snoozed_until)
  where snoozed_until is not null;

create table if not exists public.messages (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  conversation_id       uuid not null references public.conversations(id) on delete cascade,
  contact_id            uuid references public.contacts(id) on delete cascade,

  sender_type           text not null,                  -- customer | agent | bot | system
  sender_name           text,
  content_type          text not null default 'text',   -- text|image|video|audio|document|location|sticker|template|interactive|note
  content               text,

  -- media
  media_url             text,
  media_mime            text,
  media_filename        text,
  media_size            integer,
  media_caption         text,

  -- WhatsApp identifiers
  message_id            text,                           -- Meta wamid
  reply_to_message_id   uuid references public.messages(id) on delete set null,
  interactive_reply_id  text,                           -- button/list id the customer tapped
  -- buttons we attached to an outbound interactive message, so the thread can
  -- re-render them: [{ "id":"yes", "title":"Sí, confirmo" }, …]
  buttons               jsonb not null default '[]'::jsonb,
  template_name         text,
  template_language     text,

  status                text not null default 'sent',   -- sending|sent|delivered|read|failed
  error_code            integer,
  error_message         text,

  is_internal_note      boolean not null default false,
  pricing_category      text,                           -- marketing|utility|authentication|service
  pricing_cost          numeric(10,5),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists messages_conversation_idx on public.messages(conversation_id, created_at);
create index if not exists messages_user_idx         on public.messages(user_id, created_at desc);
create index if not exists messages_status_idx       on public.messages(user_id, status);
create unique index if not exists messages_wamid_uidx
  on public.messages(user_id, message_id) where message_id is not null;

create table if not exists public.message_reactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  message_id  uuid not null references public.messages(id) on delete cascade,
  emoji       text not null,
  by_type     text not null default 'agent',   -- agent | customer
  created_at  timestamptz not null default now(),
  unique (message_id, emoji, by_type)
);

-- "/gracias"-style shortcuts in the composer.
create table if not exists public.canned_replies (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  shortcut    text not null,
  body        text not null,
  language    text not null default 'es',
  usage_count integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, shortcut)
);

-- ============================================================================
-- 04  TEMPLATES
-- ============================================================================

create table if not exists public.message_templates (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,

  name                text not null,
  language            text not null default 'es',
  category            text not null default 'MARKETING',  -- MARKETING|UTILITY|AUTHENTICATION
  status              text not null default 'DRAFT',      -- DRAFT|PENDING|APPROVED|REJECTED|PAUSED|DISABLED
  rejected_reason     text,
  quality_score       text,                                -- GREEN|YELLOW|RED
  meta_template_id    text,

  -- authored content (the builder writes these)
  header_type         text,                                -- none|text|image|video|document
  header_text         text,
  header_media_url    text,
  body_text           text not null default '',
  footer_text         text,
  -- buttons: [{ "kind":"quick_reply|url|phone|copy_code", "text":"…", "url":"…", "phone":"…", "dynamic":true }]
  buttons             jsonb not null default '[]'::jsonb,
  -- sample values Meta requires at submit time: { "body": ["María","3"], "header": ["…"] }
  sample_values       jsonb not null default '{}'::jsonb,

  -- raw components as returned by the Graph API (source of truth after sync)
  components          jsonb,

  usage_count         integer not null default 0,
  last_used_at        timestamptz,
  submitted_at        timestamptz,
  approved_at         timestamptz,
  synced_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, name, language)
);

create index if not exists templates_user_idx   on public.message_templates(user_id, status);
create index if not exists templates_name_idx   on public.message_templates(user_id, name);

-- ============================================================================
-- 05  BROADCASTS
-- ============================================================================

create table if not exists public.broadcasts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,

  name               text not null,
  template_id        uuid references public.message_templates(id) on delete set null,
  template_name      text,
  template_language  text,

  -- audience: { "mode":"contacts|tags|segment|all", "contact_ids":[…], "tag_ids":[…], "segment_id":"…" }
  audience           jsonb not null default '{}'::jsonb,
  -- variable_map: { "body": [{ "kind":"static|contact_field|custom_field", "value":"…" }, …] }
  variable_map       jsonb not null default '{}'::jsonb,

  status             text not null default 'draft',  -- draft|scheduled|sending|sent|paused|cancelled|failed
  scheduled_at       timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,

  -- aggregates maintained by trigger from broadcast_recipients
  total_recipients   integer not null default 0,
  sent_count         integer not null default 0,
  delivered_count    integer not null default 0,
  read_count         integer not null default 0,
  replied_count      integer not null default 0,
  failed_count       integer not null default 0,
  opted_out_count    integer not null default 0,

  -- attribution
  revenue            numeric(12,2) not null default 0,
  cost               numeric(12,2) not null default 0,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists broadcasts_user_idx on public.broadcasts(user_id, created_at desc);

create table if not exists public.broadcast_recipients (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  broadcast_id  uuid not null references public.broadcasts(id) on delete cascade,
  contact_id    uuid references public.contacts(id) on delete set null,

  phone         text not null,
  name          text,
  status        text not null default 'queued',  -- queued|sent|delivered|read|replied|failed|skipped
  message_id    text,                            -- Meta wamid
  error_code    integer,
  error_message text,

  sent_at       timestamptz,
  delivered_at  timestamptz,
  read_at       timestamptz,
  replied_at    timestamptz,
  failed_at     timestamptz,
  created_at    timestamptz not null default now(),
  unique (broadcast_id, phone)
);

create index if not exists broadcast_recipients_bc_idx    on public.broadcast_recipients(broadcast_id, status);
create index if not exists broadcast_recipients_wamid_idx on public.broadcast_recipients(message_id) where message_id is not null;

-- ============================================================================
-- 06  SEGMENTS
-- ============================================================================

create table if not exists public.segments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  description    text,
  -- definition: nested groups, evaluated by src/lib/engines/segments.ts
  -- { "op":"and", "groups":[ { "op":"or", "conditions":[
  --     { "field":"total_spent", "operator":"gte", "value":"250" } ] } ] }
  definition     jsonb not null default '{"op":"and","groups":[]}'::jsonb,
  is_dynamic     boolean not null default true,
  color          text default '#16A34A',
  member_count   integer not null default 0,
  last_computed_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, name)
);

-- Materialised membership for static segments and for fast broadcast targeting.
create table if not exists public.segment_members (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  segment_id  uuid not null references public.segments(id) on delete cascade,
  contact_id  uuid not null references public.contacts(id) on delete cascade,
  added_at    timestamptz not null default now(),
  unique (segment_id, contact_id)
);

create index if not exists segment_members_segment_idx on public.segment_members(segment_id);

-- ============================================================================
-- 07  AUTOMATIONS
-- ============================================================================

create table if not exists public.automations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  description    text,
  trigger_type   text not null,   -- new_contact_created|first_inbound_message|new_message_received|keyword_match|tag_added|order_created
  -- trigger_config: { "keywords":["precio","envio"], "match":"contains|exact|starts_with" }
  trigger_config jsonb not null default '{}'::jsonb,
  is_active      boolean not null default false,
  run_count      integer not null default 0,
  last_run_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.automation_steps (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  automation_id  uuid not null references public.automations(id) on delete cascade,
  position       integer not null default 0,
  action_type    text not null,   -- send_message|send_template|add_tag|remove_tag|assign_agent|set_status|wait|create_deal|webhook
  -- config shape depends on action_type
  config         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists automation_steps_parent_idx on public.automation_steps(automation_id, position);

create table if not exists public.automation_logs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  automation_id  uuid not null references public.automations(id) on delete cascade,
  contact_id     uuid references public.contacts(id) on delete set null,
  status         text not null default 'success',   -- success|failed|skipped
  detail         text,
  created_at     timestamptz not null default now()
);

create index if not exists automation_logs_parent_idx on public.automation_logs(automation_id, created_at desc);

-- Steps waiting on a `wait` action, drained by the cron tick.
create table if not exists public.automation_pending (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  automation_id  uuid not null references public.automations(id) on delete cascade,
  contact_id     uuid not null references public.contacts(id) on delete cascade,
  next_step      integer not null default 0,
  run_after      timestamptz not null,
  created_at     timestamptz not null default now()
);

create index if not exists automation_pending_due_idx on public.automation_pending(run_after);

-- ============================================================================
-- 08  FLOWS
-- ============================================================================

create table if not exists public.flows (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  description    text,
  status         text not null default 'draft',   -- draft|active|paused|archived
  trigger_type   text not null default 'keyword', -- keyword|first_message|order_created|checkout_abandoned|manual|tag_added
  trigger_config jsonb not null default '{}'::jsonb,
  version        integer not null default 1,

  entered_count   integer not null default 0,
  completed_count integer not null default 0,
  revenue         numeric(12,2) not null default 0,
  cost            numeric(12,2) not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.flow_nodes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  flow_id     uuid not null references public.flows(id) on delete cascade,
  node_key    text not null,                  -- stable id referenced by branches
  position    integer not null default 0,
  node_type   text not null,                  -- message|template|buttons|list|condition|delay|tag|assign|webhook|end
  -- config: { "body":"…", "buttons":[{ "id":"yes","title":"Sí","next":"node_3" }], "next":"node_2" }
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (flow_id, node_key)
);

create index if not exists flow_nodes_flow_idx on public.flow_nodes(flow_id, position);

create table if not exists public.flow_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  flow_id       uuid not null references public.flows(id) on delete cascade,
  contact_id    uuid not null references public.contacts(id) on delete cascade,
  status        text not null default 'active',   -- active|completed|failed|paused|abandoned
  current_node  text,
  context       jsonb not null default '{}'::jsonb,
  resume_after  timestamptz,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);

-- ONE active run per (tenant, contact) — the guard that stops two flows
-- from talking over each other in the same thread.
create unique index if not exists flow_runs_one_active_uidx
  on public.flow_runs(user_id, contact_id) where status = 'active';

create index if not exists flow_runs_flow_idx   on public.flow_runs(flow_id, started_at desc);
create index if not exists flow_runs_resume_idx on public.flow_runs(resume_after) where status = 'active';

create table if not exists public.flow_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  flow_id     uuid not null references public.flows(id) on delete cascade,
  run_id      uuid references public.flow_runs(id) on delete cascade,
  contact_id  uuid references public.contacts(id) on delete set null,
  node_key    text,
  status      text not null default 'ok',   -- ok|error|skipped|branch
  detail      text,
  created_at  timestamptz not null default now()
);

create index if not exists flow_events_flow_idx on public.flow_events(flow_id, created_at desc);

-- ============================================================================
-- 09  CHATBOT  (keyword rules + FAQ work now; AI columns reserved, engine off)
-- ============================================================================

create table if not exists public.chatbot_config (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null unique references auth.users(id) on delete cascade,
  rules_enabled         boolean not null default true,
  faq_enabled           boolean not null default true,

  -- AI is intentionally parked: the UI shows these but the engine
  -- short-circuits while ai_enabled is false. No LLM calls are made.
  ai_enabled            boolean not null default false,
  ai_persona            text,
  ai_tone               text default 'warm',      -- warm|formal|playful
  ai_languages          text[] not null default array['es','en'],
  ai_allowed_topics     jsonb not null default '[]'::jsonb,
  ai_confidence_threshold integer not null default 70,

  handoff_enabled       boolean not null default true,
  handoff_rules         jsonb not null default '[]'::jsonb,
  business_hours_only   boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.chatbot_rules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  keywords     text[] not null default '{}',
  match_type   text not null default 'contains',   -- contains|exact|starts_with|regex
  reply_text   text not null,
  language     text not null default 'es',
  priority     integer not null default 0,
  is_active    boolean not null default true,
  hit_count    integer not null default 0,
  last_hit_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists chatbot_rules_user_idx on public.chatbot_rules(user_id, is_active, priority desc);

create table if not exists public.chatbot_faqs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  question     text not null,
  answer       text not null,
  languages    text[] not null default array['es'],
  keywords     text[] not null default '{}',
  used_count   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists chatbot_faqs_trgm_idx on public.chatbot_faqs using gin (question gin_trgm_ops);

create table if not exists public.chatbot_handoffs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  contact_id      uuid references public.contacts(id) on delete set null,
  agent_id        uuid,
  reason          text,
  confidence      numeric(5,2),
  created_at      timestamptz not null default now()
);

-- ============================================================================
-- 10  PIPELINES & DEALS
-- ============================================================================

create table if not exists public.pipelines (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.pipeline_stages (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  pipeline_id  uuid not null references public.pipelines(id) on delete cascade,
  name         text not null,
  position     integer not null default 0,
  color        text default '#16A34A',
  win_probability integer not null default 0,   -- 0-100, drives weighted forecast
  is_won       boolean not null default false,
  is_lost      boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists pipeline_stages_parent_idx on public.pipeline_stages(pipeline_id, position);

create table if not exists public.deals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  pipeline_id    uuid not null references public.pipelines(id) on delete cascade,
  stage_id       uuid not null references public.pipeline_stages(id) on delete cascade,
  contact_id     uuid references public.contacts(id) on delete set null,

  title          text not null,
  value          numeric(12,2) not null default 0,
  currency       text not null default 'EUR',
  owner_id       uuid,                          -- -> agents.id
  next_action    text,
  next_action_at timestamptz,
  position       integer not null default 0,
  stage_entered_at timestamptz not null default now(),
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists deals_stage_idx   on public.deals(stage_id, position);
create index if not exists deals_user_idx    on public.deals(user_id, created_at desc);
create index if not exists deals_contact_idx on public.deals(contact_id);

-- ============================================================================
-- 11  WHATSAPP CONFIG & WEBHOOK LOG
-- ============================================================================

create table if not exists public.whatsapp_config (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null unique references auth.users(id) on delete cascade,

  -- UNIQUE: inbound webhooks are routed to a tenant by this id, so a second
  -- tenant must never be able to claim another tenant's number.
  phone_number_id       text unique,
  waba_id               text,
  business_id           text,

  -- AES-256-GCM `iv:ct:tag` hex. Never returned to the browser.
  access_token          text,
  verify_token          text,

  display_phone_number  text,
  verified_name         text,
  quality_rating        text,               -- GREEN|YELLOW|RED  (UI: High/Medium/Low)
  messaging_tier        text,               -- TIER_1K | TIER_10K | TIER_100K | UNLIMITED
  messages_sent_24h     integer not null default 0,

  connection_status     text not null default 'disconnected',  -- disconnected|connecting|connected|error
  connection_error      text,
  webhook_subscribed    boolean not null default false,
  last_verified_at      timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.whatsapp_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade,
  event_type    text not null,                 -- messages|statuses|template_status_update|…
  phone_number_id text,
  payload       jsonb,
  status        text not null default 'received',   -- received|processed|failed|ignored
  error         text,
  duration_ms   integer,
  created_at    timestamptz not null default now()
);

create index if not exists wa_webhook_events_idx on public.whatsapp_webhook_events(user_id, created_at desc);

-- ============================================================================
-- 12  SHOPIFY CONFIG, COMMERCE MIRROR & WEBHOOK LOG
-- ============================================================================

create table if not exists public.shopify_config (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null unique references auth.users(id) on delete cascade,

  -- UNIQUE for the same reason as phone_number_id: webhook tenant routing.
  store_domain          text unique,
  store_name            text,
  store_currency        text,
  store_timezone        text,

  access_token          text,      -- encrypted
  refresh_token         text,      -- encrypted
  token_expires_at      timestamptz,
  scopes                text,

  connection_status     text not null default 'disconnected',
  connection_error      text,
  webhooks_registered   boolean not null default false,
  webhooks_registered_at timestamptz,
  last_sync_at          timestamptz,
  last_sync_status      text,

  -- ---------------- COD confirmation config ----------------
  cod_enabled                 boolean not null default false,
  cod_gateways                text[] not null default array['cash on delivery','contra reembolso','cod'],
  cod_confirm_template        text,
  cod_confirm_var_map         jsonb not null default '[]'::jsonb,
  cod_reminder_count          integer not null default 2,
  cod_reminder1_hours         integer not null default 24,
  cod_reminder1_template      text,
  cod_reminder1_var_map       jsonb not null default '[]'::jsonb,
  cod_reminder2_hours         integer not null default 48,
  cod_reminder2_template      text,
  cod_reminder2_var_map       jsonb not null default '[]'::jsonb,
  cod_no_reply_hours          integer not null default 72,
  cod_no_reply_template       text,
  cod_no_reply_var_map        jsonb not null default '[]'::jsonb,
  cod_confirmed_template      text,
  cod_confirmed_var_map       jsonb not null default '[]'::jsonb,
  cod_cancelled_template      text,
  cod_cancelled_var_map       jsonb not null default '[]'::jsonb,
  cod_tag_pending             text not null default 'COD Pending',
  cod_tag_confirmed           text not null default 'COD Confirmed',
  cod_tag_cancelled           text not null default 'COD Cancelled',
  cod_yes_keywords            text[] not null default array['si','sí','yes','ok','confirmo','vale'],
  cod_no_keywords             text[] not null default array['no','cancelar','cancel','anular'],
  cod_confirmed_reply         text,
  cod_cancelled_reply         text,

  -- ---------------- Abandoned checkout recovery config ----------------
  recovery_enabled            boolean not null default false,
  recovery_delay1_minutes     integer not null default 45,
  recovery_delay2_minutes     integer not null default 1440,
  recovery_delay3_minutes     integer not null default 2880,
  recovery_cooldown_days      integer not null default 7,
  -- A recovery sequence only ever STARTS for a cart younger than this. The
  -- guard that stops a backfill from messaging months-old checkouts: their
  -- tracking rows are created for history, but marked skipped_too_old.
  recovery_max_age_hours      integer not null default 24,
  recovery_stop_keywords      text[] not null default array['stop','baja','parar','unsubscribe'],

  recovery_r1_template_es     text,
  recovery_r1_template_en     text,
  recovery_r1_var_map         jsonb not null default '[]'::jsonb,
  recovery_r1_discount_id     uuid,
  recovery_r2_template_es     text,
  recovery_r2_template_en     text,
  recovery_r2_var_map         jsonb not null default '[]'::jsonb,
  recovery_r2_discount_id     uuid,
  recovery_r3_template_es     text,
  recovery_r3_template_en     text,
  recovery_r3_var_map         jsonb not null default '[]'::jsonb,
  recovery_r3_discount_id     uuid,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.shopify_orders (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  shopify_order_id     text not null,
  order_number         text,
  contact_id           uuid references public.contacts(id) on delete set null,

  customer_name        text,
  customer_email       text,
  customer_phone       text,
  customer_locale      text,

  total_price          numeric(12,2),
  subtotal_price       numeric(12,2),
  currency             text,
  items_count          integer not null default 0,
  line_items           jsonb not null default '[]'::jsonb,

  financial_status     text,
  fulfillment_status   text,
  gateway              text,
  is_cod               boolean not null default false,
  tags                 text,
  shipping_city        text,
  shipping_country     text,
  cancelled_at         timestamptz,

  -- 'webhook' rows may trigger messaging; 'backfill' rows NEVER may.
  source               text not null default 'webhook',
  shopify_created_at   timestamptz,
  -- Shopify's own updated_at: the backfill compares it to skip rows that have
  -- not changed, which is what lets repeated syncs walk deeper each run.
  shopify_updated_at   timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (user_id, shopify_order_id)
);

-- Added after the first release; keeps an existing database in step.
alter table public.shopify_orders add column if not exists shopify_updated_at timestamptz;
alter table public.shopify_config add column if not exists recovery_max_age_hours integer not null default 24;

create index if not exists shopify_orders_user_idx    on public.shopify_orders(user_id, shopify_created_at desc);
create index if not exists shopify_orders_contact_idx on public.shopify_orders(contact_id);

create table if not exists public.shopify_checkouts (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  shopify_checkout_id     text not null,
  token                   text,
  contact_id              uuid references public.contacts(id) on delete set null,

  customer_name           text,
  customer_email          text,
  customer_phone          text,
  customer_locale         text,

  total_price             numeric(12,2),
  currency                text,
  items_count             integer not null default 0,
  line_items              jsonb not null default '[]'::jsonb,
  abandoned_checkout_url  text,

  completed_at            timestamptz,
  recovered               boolean not null default false,
  recovered_order_id      text,

  -- Shopify only surfaces a checkout once it is abandonment-eligible, so its
  -- created_at is the anchor the reminder ladder measures from.
  abandoned_at            timestamptz,
  -- The full payload. Shopify adds fields faster than the mapper does, and a
  -- capture that dropped something is otherwise unrecoverable.
  raw                     jsonb,

  source                  text not null default 'webhook',
  shopify_created_at      timestamptz,
  shopify_updated_at      timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (user_id, shopify_checkout_id)
);

-- Added after the first release; keeps an existing database in step.
alter table public.shopify_checkouts add column if not exists abandoned_at timestamptz;
alter table public.shopify_checkouts add column if not exists raw jsonb;

create index if not exists shopify_checkouts_user_idx on public.shopify_checkouts(user_id, shopify_created_at desc);

create table if not exists public.shopify_fulfillments (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  shopify_fulfillment_id text not null,
  shopify_order_id       text,
  status                 text,
  shipment_status        text,
  tracking_company       text,
  tracking_number        text,
  tracking_url           text,
  source                 text not null default 'webhook',
  shopify_created_at     timestamptz,
  created_at             timestamptz not null default now(),
  unique (user_id, shopify_fulfillment_id)
);

-- Product mirror powering the Catalog screen.
create table if not exists public.shopify_products (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  shopify_product_id text not null,
  title              text,
  handle             text,
  sku                text,
  vendor             text,
  product_type       text,
  collections        jsonb not null default '[]'::jsonb,
  price              numeric(12,2),
  currency           text,
  inventory_quantity integer,
  image_url          text,
  status             text,                                  -- active|draft|archived
  catalog_sync_status text not null default 'pending',      -- pending|synced|failed|excluded
  catalog_sync_error text,
  synced_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, shopify_product_id)
);

create index if not exists shopify_products_user_idx on public.shopify_products(user_id, title);

create table if not exists public.shopify_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade,
  topic         text not null,
  store_domain  text,
  shopify_id    text,
  payload       jsonb,
  status        text not null default 'received',   -- received|processed|failed|ignored
  error         text,
  duration_ms   integer,
  created_at    timestamptz not null default now()
);

create index if not exists shopify_webhook_events_idx on public.shopify_webhook_events(user_id, created_at desc);

-- Cart-in-chat sessions (agent builds a cart inside the conversation).
create table if not exists public.chat_carts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  contact_id      uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  items           jsonb not null default '[]'::jsonb,
  total_value     numeric(12,2) not null default 0,
  currency        text not null default 'EUR',
  status          text not null default 'open',   -- open|checkout_sent|paid|abandoned|cancelled
  draft_order_id  text,
  checkout_url    text,
  payment_link    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists chat_carts_user_idx on public.chat_carts(user_id, updated_at desc);

-- ============================================================================
-- 13  COD CONFIRMATIONS
-- ============================================================================

create table if not exists public.cod_confirmations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  shopify_order_id   text not null,
  order_number       text,
  contact_id         uuid references public.contacts(id) on delete set null,
  phone              text,

  status             text not null default 'pending',
  -- pending | confirmed | cancelled | no_reply_cancelled | skipped_no_phone | failed

  messages_sent      integer not null default 0,
  reminder1_sent_at  timestamptz,
  reminder2_sent_at  timestamptz,
  no_reply_at        timestamptz,
  confirmed_at       timestamptz,
  cancelled_at       timestamptz,
  reply_text         text,
  last_error         text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- one row per order, forever: the idempotency guard for webhook retries
  unique (user_id, shopify_order_id)
);

create index if not exists cod_confirmations_status_idx on public.cod_confirmations(user_id, status);

-- ============================================================================
-- 14  CHECKOUT RECOVERY
-- ============================================================================

create table if not exists public.checkout_recoveries (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  shopify_checkout_id   text not null,
  checkout_row_id       uuid references public.shopify_checkouts(id) on delete cascade,
  contact_id            uuid references public.contacts(id) on delete set null,
  phone                 text,

  status                text not null default 'active',
  -- active | done | completed_order | skipped_no_phone | suppressed_cooldown
  -- | skipped_too_old | opted_out | failed

  reminders_sent        integer not null default 0,   -- 0..3
  reminder1_sent_at     timestamptz,
  reminder2_sent_at     timestamptz,
  reminder3_sent_at     timestamptz,
  discount_code         text,
  last_error            text,
  -- Consecutive failures for the stage currently due. A failed send does NOT
  -- consume its reminder — otherwise fixing a bad template never helps the
  -- carts already in flight — but it cannot retry forever either.
  send_attempts         integer not null default 0,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- one row per checkout — the DB-level guard against double sequences
  unique (user_id, shopify_checkout_id)
);

-- Added after the first release; keeps an existing database in step.
alter table public.checkout_recoveries
  add column if not exists send_attempts integer not null default 0;
-- Which thread the reminders were mirrored into, so the UI can link to it.
alter table public.checkout_recoveries
  add column if not exists conversation_id uuid references public.conversations(id) on delete set null;

create index if not exists checkout_recoveries_active_idx
  on public.checkout_recoveries(user_id, status) where status = 'active';

-- ============================================================================
-- 15  DISCOUNTS
-- ============================================================================

create table if not exists public.discounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  label            text not null,
  discount_type    text not null default 'percentage',   -- percentage|fixed_amount|free_shipping
  percentage       numeric(5,2),
  amount           numeric(12,2),
  currency         text not null default 'EUR',
  expiry_days      integer not null default 7,
  min_order_amount numeric(12,2),
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.discount_codes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  discount_id   uuid references public.discounts(id) on delete set null,
  contact_id    uuid references public.contacts(id) on delete set null,
  code          text not null,
  shopify_price_rule_id text,
  shopify_discount_id   text,
  status        text not null default 'active',   -- active|used|expired|revoked
  used_at       timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, code)
);

create index if not exists discount_codes_contact_idx on public.discount_codes(user_id, contact_id, status);

-- ============================================================================
-- 16  AGENTS, API KEYS, NOTIFICATIONS, ACTIVITY
-- ============================================================================

-- Agents are assignment targets owned by the tenant. In this single-tenant
-- build they are labels (no separate login); conversations.assigned_to and
-- deals.owner_id point here. A future team release turns these into invites.
create table if not exists public.agents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  email       text,
  role        text not null default 'agent',   -- owner|admin|agent|viewer
  languages   text[] not null default array['es'],
  status      text not null default 'offline', -- online|away|offline
  avatar_color text default '#16A34A',
  is_self     boolean not null default false,  -- the row representing the account owner
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists agents_user_idx on public.agents(user_id);

create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  key_prefix   text not null,          -- shown in the UI, e.g. wsk_live_a1b2
  key_hash     text not null,          -- sha256 of the full key; the key itself is shown once
  scopes       text[] not null default array['read'],
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (user_id, key_prefix)
);

create table if not exists public.api_key_usage (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  api_key_id  uuid references public.api_keys(id) on delete cascade,
  day         date not null default current_date,
  requests    integer not null default 0,
  unique (api_key_id, day)
);

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null default 'info',   -- info|success|warning|error
  text        text not null,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);

-- Dashboard "Live activity" feed.
create table if not exists public.activity_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,        -- message|order|broadcast|flow|template|cod|recovery|system
  title       text not null,
  detail      text,
  contact_id  uuid references public.contacts(id) on delete set null,
  amount      numeric(12,2),
  created_at  timestamptz not null default now()
);

create index if not exists activity_events_user_idx on public.activity_events(user_id, created_at desc);

-- Service-role-only audit trail.
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  actor       text,
  action      text not null,
  target      text,
  meta        jsonb,
  created_at  timestamptz not null default now()
);

-- ============================================================================
-- 17  TRIGGERS
-- ============================================================================

-- ---- updated_at on every table that has the column --------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','settings','contacts','canned_replies','conversations','messages',
    'message_templates','broadcasts','segments','automations','flows','chatbot_config',
    'chatbot_rules','chatbot_faqs','deals','whatsapp_config','shopify_config',
    'shopify_orders','shopify_checkouts','shopify_products','cod_confirmations',
    'checkout_recoveries','discounts','agents','chat_carts'
  ]
  loop
    execute format('drop trigger if exists trg_touch_%1$s on public.%1$I', t);
    execute format(
      'create trigger trg_touch_%1$s before update on public.%1$I
         for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---- profile + starter data on signup ---------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pipeline uuid;
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;

  insert into public.settings (user_id, business_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'business_name', 'My store'))
  on conflict (user_id) do nothing;

  insert into public.chatbot_config (user_id) values (new.id)
  on conflict (user_id) do nothing;

  -- the owner's own agent row, so assignment works from day one
  insert into public.agents (user_id, name, email, role, is_self, status)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
          new.email, 'owner', true, 'online');

  -- a default deal pipeline with sensible stages
  insert into public.pipelines (user_id, name, is_default)
  values (new.id, 'Wholesale & B2B', true)
  returning id into v_pipeline;

  insert into public.pipeline_stages (user_id, pipeline_id, name, position, win_probability, is_won, is_lost)
  values
    (new.id, v_pipeline, 'New lead',   0, 10,  false, false),
    (new.id, v_pipeline, 'Qualified',  1, 30,  false, false),
    (new.id, v_pipeline, 'Quote sent', 2, 55,  false, false),
    (new.id, v_pipeline, 'Negotiation',3, 75,  false, false),
    (new.id, v_pipeline, 'Won',        4, 100, true,  false),
    (new.id, v_pipeline, 'Lost',       5, 0,   false, true);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- broadcast aggregate counts ---------------------------------------------
create or replace function public.refresh_broadcast_counts()
returns trigger
language plpgsql
as $$
declare
  v_broadcast uuid := coalesce(new.broadcast_id, old.broadcast_id);
begin
  update public.broadcasts b
  set total_recipients = s.total,
      sent_count       = s.sent,
      delivered_count  = s.delivered,
      read_count       = s.read,
      replied_count    = s.replied,
      failed_count     = s.failed,
      opted_out_count  = s.skipped
  from (
    select
      count(*)                                                             as total,
      count(*) filter (where status in ('sent','delivered','read','replied')) as sent,
      count(*) filter (where status in ('delivered','read','replied'))      as delivered,
      count(*) filter (where status in ('read','replied'))                  as read,
      count(*) filter (where status = 'replied')                            as replied,
      count(*) filter (where status = 'failed')                             as failed,
      count(*) filter (where status = 'skipped')                            as skipped
    from public.broadcast_recipients
    where broadcast_id = v_broadcast
  ) s
  where b.id = v_broadcast;

  return null;
end;
$$;

drop trigger if exists trg_broadcast_counts on public.broadcast_recipients;
create trigger trg_broadcast_counts
  after insert or update of status or delete on public.broadcast_recipients
  for each row execute function public.refresh_broadcast_counts();

-- ---- keep contacts.notes_count honest ---------------------------------------
create or replace function public.refresh_contact_notes_count()
returns trigger
language plpgsql
as $$
declare v_contact uuid := coalesce(new.contact_id, old.contact_id);
begin
  update public.contacts
  set notes_count = (select count(*) from public.contact_notes where contact_id = v_contact)
  where id = v_contact;
  return null;
end;
$$;

drop trigger if exists trg_contact_notes_count on public.contact_notes;
create trigger trg_contact_notes_count
  after insert or delete on public.contact_notes
  for each row execute function public.refresh_contact_notes_count();

-- ---- segment member count ----------------------------------------------------
create or replace function public.refresh_segment_count()
returns trigger
language plpgsql
as $$
declare v_segment uuid := coalesce(new.segment_id, old.segment_id);
begin
  update public.segments
  set member_count = (select count(*) from public.segment_members where segment_id = v_segment)
  where id = v_segment;
  return null;
end;
$$;

drop trigger if exists trg_segment_count on public.segment_members;
create trigger trg_segment_count
  after insert or delete on public.segment_members
  for each row execute function public.refresh_segment_count();

-- ============================================================================
-- 18  ROW LEVEL SECURITY
-- ============================================================================

-- Every table below gets: enable RLS + one policy `auth.uid() = user_id`.
-- profiles is the exception (its PK *is* the user id).
do $$
declare t text;
begin
  foreach t in array array[
    'settings','contacts','tags','contact_tags','custom_fields','contact_custom_values',
    'contact_notes','consent_events','suppression_list','contact_imports',
    'conversations','messages','message_reactions','canned_replies','message_templates',
    'broadcasts','broadcast_recipients','segments','segment_members',
    'automations','automation_steps','automation_logs','automation_pending',
    'flows','flow_nodes','flow_runs','flow_events',
    'chatbot_config','chatbot_rules','chatbot_faqs','chatbot_handoffs',
    'pipelines','pipeline_stages','deals',
    'whatsapp_config','whatsapp_webhook_events',
    'shopify_config','shopify_orders','shopify_checkouts','shopify_fulfillments',
    'shopify_products','shopify_webhook_events','chat_carts',
    'cod_confirmations','checkout_recoveries','discounts','discount_codes',
    'agents','api_keys','api_key_usage','notifications','activity_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_all on public.%I', t);
    execute format(
      'create policy tenant_all on public.%I
         for all to authenticated
         using (auth.uid() = user_id)
         with check (auth.uid() = user_id)', t);
  end loop;
end $$;

alter table public.profiles enable row level security;
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for all to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- audit_log is service-role only: RLS on, and no policy at all means
-- authenticated clients can never read or write it.
alter table public.audit_log enable row level security;

-- ============================================================================
-- 19  REALTIME
-- ============================================================================

-- The Inbox subscribes to conversations + messages; the dashboard badge and
-- notification bell subscribe to the other three.
do $$
declare t text;
begin
  foreach t in array array['conversations','messages','notifications','activity_events','broadcasts']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then
      null;   -- already published, nothing to do
    end;
  end loop;
end $$;

-- Realtime needs the old row on UPDATE to compute deltas for these.
alter table public.conversations replica identity full;
alter table public.messages      replica identity full;

-- ============================================================================
-- DONE
-- ============================================================================
