/** Domain types mirroring supabase/schema.sql. Keep in sync when the schema moves. */

export type ConversationStatus = 'open' | 'pending' | 'closed'
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
export type SenderType = 'customer' | 'agent' | 'bot' | 'system'
export type ContentType =
  | 'text' | 'image' | 'video' | 'audio' | 'document'
  | 'location' | 'sticker' | 'template' | 'interactive' | 'note'

export type TemplateStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED'
export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'

export type BroadcastStatus =
  | 'draft' | 'scheduled' | 'sending' | 'sent' | 'paused' | 'cancelled' | 'failed'
export type RecipientStatus =
  | 'queued' | 'sent' | 'delivered' | 'read' | 'replied' | 'failed' | 'skipped'

export type OptInStatus = 'opted_in' | 'opted_out' | 'unknown'

export type CodStatus =
  | 'pending' | 'confirmed' | 'cancelled'
  | 'no_reply_cancelled' | 'skipped_no_phone' | 'failed'

export type RecoveryStatus =
  | 'active' | 'done' | 'completed_order'
  | 'skipped_no_phone' | 'suppressed_cooldown' | 'opted_out' | 'failed'

export type FlowStatus = 'draft' | 'active' | 'paused' | 'archived'
export type FlowRunStatus = 'active' | 'completed' | 'failed' | 'paused' | 'abandoned'

export interface Profile {
  id: string
  email: string | null
  full_name: string | null
  avatar_url: string | null
  locale: string
  onboarded: boolean
}

export interface Contact {
  id: string
  user_id: string
  phone: string
  name: string | null
  email: string | null
  company: string | null
  locale: string | null
  country: string | null
  city: string | null
  postcode: string | null
  shopify_customer_id: string | null
  lifetime_spent: number
  orders_count: number
  last_order_at: string | null
  avg_order_value: number
  opt_in_status: OptInStatus
  opt_in_source: string | null
  opt_in_at: string | null
  opt_out_at: string | null
  accepts_marketing: boolean
  rfm_segment: string | null
  rfm_recency: number | null
  rfm_frequency: number | null
  rfm_monetary: number | null
  source: string | null
  notes_count: number
  is_blocked: boolean
  created_at: string
  updated_at: string
}

export interface Tag {
  id: string
  user_id: string
  name: string
  color: string
}

export interface Conversation {
  id: string
  user_id: string
  contact_id: string
  status: ConversationStatus
  assigned_to: string | null
  labels: string[]
  last_message_text: string | null
  last_message_at: string | null
  last_inbound_at: string | null
  unread_count: number
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  user_id: string
  conversation_id: string
  contact_id: string | null
  sender_type: SenderType
  sender_name: string | null
  content_type: ContentType
  content: string | null
  media_url: string | null
  media_mime: string | null
  media_filename: string | null
  media_caption: string | null
  message_id: string | null
  reply_to_message_id: string | null
  interactive_reply_id: string | null
  template_name: string | null
  status: MessageStatus
  error_message: string | null
  is_internal_note: boolean
  created_at: string
}

export interface MessageTemplate {
  id: string
  user_id: string
  name: string
  language: string
  category: TemplateCategory
  status: TemplateStatus
  rejected_reason: string | null
  quality_score: string | null
  header_type: string | null
  header_text: string | null
  header_media_url: string | null
  body_text: string
  footer_text: string | null
  buttons: TemplateButton[]
  sample_values: Record<string, string[]>
  components: unknown
  usage_count: number
  created_at: string
}

export interface TemplateButton {
  kind: 'quick_reply' | 'url' | 'phone' | 'copy_code'
  text: string
  url?: string
  phone?: string
  dynamic?: boolean
}

export interface Broadcast {
  id: string
  user_id: string
  name: string
  template_id: string | null
  template_name: string | null
  template_language: string | null
  audience: BroadcastAudience
  variable_map: Record<string, VariableBinding[]>
  status: BroadcastStatus
  scheduled_at: string | null
  started_at: string | null
  completed_at: string | null
  total_recipients: number
  sent_count: number
  delivered_count: number
  read_count: number
  replied_count: number
  failed_count: number
  opted_out_count: number
  revenue: number
  cost: number
  created_at: string
}

export interface BroadcastAudience {
  mode: 'contacts' | 'tags' | 'segment' | 'all'
  contact_ids?: string[]
  tag_ids?: string[]
  segment_id?: string
}

export interface VariableBinding {
  kind: 'static' | 'contact_field' | 'custom_field'
  value: string
}

/* ----------------------------- segments ------------------------------ */

export type SegmentOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'not_contains' | 'is_set' | 'is_not_set'
  | 'in_last_days' | 'not_in_last_days'

export interface SegmentCondition {
  field: string
  operator: SegmentOperator
  value: string
}

export interface SegmentGroup {
  op: 'and' | 'or'
  conditions: SegmentCondition[]
}

export interface SegmentDefinition {
  op: 'and' | 'or'
  groups: SegmentGroup[]
}

export interface Segment {
  id: string
  user_id: string
  name: string
  description: string | null
  definition: SegmentDefinition
  is_dynamic: boolean
  color: string | null
  member_count: number
  last_computed_at: string | null
  created_at: string
}

/* ----------------------------- pipelines ----------------------------- */

export interface Pipeline {
  id: string
  user_id: string
  name: string
  is_default: boolean
}

export interface PipelineStage {
  id: string
  user_id: string
  pipeline_id: string
  name: string
  position: number
  color: string | null
  win_probability: number
  is_won: boolean
  is_lost: boolean
}

export interface Deal {
  id: string
  user_id: string
  pipeline_id: string
  stage_id: string
  contact_id: string | null
  title: string
  value: number
  currency: string
  owner_id: string | null
  next_action: string | null
  next_action_at: string | null
  position: number
  stage_entered_at: string
  created_at: string
}

/* ------------------------------ flows -------------------------------- */

export interface Flow {
  id: string
  user_id: string
  name: string
  description: string | null
  status: FlowStatus
  trigger_type: string
  trigger_config: Record<string, unknown>
  version: number
  entered_count: number
  completed_count: number
  revenue: number
  cost: number
  updated_at: string
}

export interface FlowNode {
  id: string
  user_id: string
  flow_id: string
  node_key: string
  position: number
  node_type: 'message' | 'template' | 'buttons' | 'list' | 'condition' | 'delay' | 'tag' | 'assign' | 'webhook' | 'end'
  config: FlowNodeConfig
}

export interface FlowNodeConfig {
  body?: string
  template_name?: string
  template_language?: string
  header?: string
  footer?: string
  buttons?: Array<{ id: string; title: string; next?: string }>
  delay_minutes?: number
  tag_id?: string
  agent_id?: string
  field?: string
  operator?: SegmentOperator
  value?: string
  next?: string
  next_if_true?: string
  next_if_false?: string
  url?: string
  [k: string]: unknown
}

/* ------------------------------ agents ------------------------------- */

export interface Agent {
  id: string
  user_id: string
  name: string
  email: string | null
  role: 'owner' | 'admin' | 'agent' | 'viewer'
  languages: string[]
  status: 'online' | 'away' | 'offline'
  avatar_color: string | null
  is_self: boolean
}

/* ------------------------- joined view models ------------------------ */

export interface ConversationListItem extends Conversation {
  contact: Pick<Contact, 'id' | 'name' | 'phone' | 'rfm_segment' | 'locale'> | null
}

export interface ContactWithTags extends Contact {
  tags: Tag[]
}
