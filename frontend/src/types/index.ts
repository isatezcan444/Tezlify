export type LeadStatus = 'NEW' | 'CONTACTED' | 'REPLIED' | 'INTERESTED' | 'UNSUBSCRIBED' | 'INVALID_NUMBER';

export type CommunicationGoal = 
  | 'FIRST_CONTACT'       // İlk Tanışma
  | 'SERVICE_PROMOTION'   // Ürün / Hizmet Tanıtımı
  | 'DISCOVERY'           // İhtiyaç Keşfi
  | 'OFFER'               // Teklif Sunma
  | 'MEETING'             // Görüşme Talebi
  | 'FOLLOW_UP';          // Takip Mesajı

export interface Lead {
  id: number;
  name: string;
  category?: string;
  phone: string;
  phone_e164: string;
  is_mobile: boolean;
  is_whatsapp_eligible: boolean;
  address?: string;
  city?: string;
  district?: string;
  website?: string;
  email?: string;
  latitude?: number;
  longitude?: number;
  maps_url?: string;
  rating?: number;
  reviews_count?: number;
  search_keyword?: string;
  search_location?: string;
  status: LeadStatus;
  entity_type?: 'BUSINESS' | 'CLINIC' | 'COMPANY' | 'PROFESSIONAL' | 'PERSON' | 'DIRECTORY_PROFILE' | 'UNKNOWN';
  verification_status?: 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';
  confidence_level?: 'HIGH' | 'MEDIUM' | 'LOW';
  confidence_score?: number;
  is_verified?: boolean;
  canonical_category?: string;
  category_score?: number;
  category_classification?: 'MATCH' | 'PARTIAL_MATCH' | 'RELATED' | 'AMBIGUOUS' | 'MISMATCH';
  discovered_from?: string;
  verified_by?: string;
  verification_trace?: unknown;
  notes?: string;
  custom_data?: Record<string, unknown>;
  emails?: string[];
  social_links?: Record<string, string>;
  meta_title?: string;
  meta_description?: string;
  enrichment_status?: 'NOT_ENRICHED' | 'ENRICHED' | 'FAILED' | 'NO_WEBSITE';
  enriched_at?: string;
  created_at?: string;
  updated_at?: string;
  last_contacted_at?: string;
}

export interface LeadEnrichResponse {
  success: boolean;
  lead: Lead;
  found_emails: string[];
  found_socials: Record<string, string>;
  meta_title?: string | null;
  meta_description?: string | null;
  error?: string | null;
}

export interface BulkEnrichRequest {
  lead_ids?: number[];
  enrich_all_matching?: boolean;
  search?: string;
  city?: string;
  districts?: string[];
  categories?: string[];
  status?: LeadStatus | string;
  whatsapp_eligible_only?: boolean;
}

export interface BulkEnrichResponse {
  total_requested: number;
  enriched_count: number;
  skipped_count: number;
  failed_count: number;
  items: Lead[];
}

export interface LeadImportPreviewResult {
  filename: string;
  total_rows: number;
  headers: string[];
  detected_mapping: {
    name?: string | null;
    phone?: string | null;
    city?: string | null;
    district?: string | null;
    category?: string | null;
    website?: string | null;
    address?: string | null;
    notes?: string | null;
  };
  preview_rows: Record<string, string>[];
}

export interface LeadImportResult {
  total_rows: number;
  imported_count: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  invalid_phone_count: number;
}

export type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';

export interface Campaign {
  id: number;
  name: string;
  description?: string;
  message_template: string;
  status: CampaignStatus;
  scheduled_at?: string;
  min_delay_seconds: number;
  max_delay_seconds: number;
  typing_delay_seconds: number;
  working_hours_enabled: boolean;
  working_hours_start: string;
  working_hours_end: string;
  daily_message_limit?: number;
  session_id?: number;
  whatsapp_session_id?: number;
  whatsapp_session_ids?: number[];
  group_id?: number;
  media_url?: string;
  media_type?: 'IMAGE' | 'DOCUMENT' | 'VIDEO' | 'AUDIO';
  media_filename?: string;
  sequence_enabled?: boolean;
  sequence_steps?: SequenceStep[];
  auto_stop_on_reply?: boolean;
  total_leads_target: number;
  sent_count: number;
  delivered_count: number;
  replied_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
}

export interface SequenceStep {
  step_number: number;
  delay_days: number;
  delay_hours: number;
  message_template: string;
  media_url?: string;
  media_type?: 'IMAGE' | 'DOCUMENT' | 'VIDEO' | 'AUDIO';
  media_filename?: string;
}

export type SequenceLeadStatus = 'ACTIVE' | 'COMPLETED' | 'STOPPED_ON_REPLY' | 'STOPPED_MANUAL' | 'OPT_OUT' | 'FAILED';

export interface SequenceLeadItem {
  id: number;
  campaign_id: number;
  lead_id: number;
  lead_name?: string;
  lead_phone?: string;
  whatsapp_session_id?: number;
  current_step: number;
  total_steps: number;
  status: SequenceLeadStatus;
  next_step_at?: string;
  last_step_sent_at?: string;
  stopped_at?: string;
  stop_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignGroup {
  id: number;
  name: string;
  description?: string;
  target_category?: string;
  target_location?: string;
  total_leads_count: number;
  whatsapp_eligible_count: number;
  created_at: string;
  updated_at: string;
}

export interface CampaignGroupDetail extends CampaignGroup {
  leads: Lead[];
}

export interface CampaignGroupCreatePayload {
  name?: string;
  description?: string;
  target_category?: string;
  target_location?: string;
  lead_ids?: number[];
}

export interface AddLeadsToGroupResponse {
  group_id: number;
  group_name: string;
  added_count: number;
  existing_count: number;
  total_leads_count: number;
  whatsapp_eligible_count: number;
  message: string;
}

export interface GenerateMessagePayload {
  communication_goal: CommunicationGoal;
  target_category?: string;
  offer_title?: string;
  key_benefit?: string;
  extra_information?: string;
  preferred_channel?: string;
  lead_need?: string;
  specific_question?: string;
  pricing_info?: string;
  meeting_purpose?: string;
  previous_topic?: string;
  language?: string;
  variation_seed?: number;
}

export interface GenerateMessageResponse {
  generated_message: string;
  communication_goal: string;
  language: string;
  strategy_summary?: string;
}


export type SessionStatus =
  | 'DISCONNECTED'
  | 'SCAN_QR'
  | 'RESTORING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RELINK_REQUIRED'
  | 'UNAVAILABLE'
  | 'ERROR'
  | 'BANNED';

export interface SessionSyncState {
  // Faz 7: gateway'deki GERÇEK initial-sync durumu (Baileys history progress).
  // Faz 11: ayni banner artik WS tabanli chunked sync job'i ile de beslenir
  // (stage/error alanlari gercek olaylardan gelir, sahte veri uretilmez).
  phase: 'idle' | 'syncing' | 'ready' | 'error' | string;
  progress?: number;
  stage?: string;
  error?: string | null;
  chats_total?: number;
  chats_synced?: number;
  contacts_synced?: number;
  messages_total?: number;
  messages_synced?: number;
  // G-6 handoff: `*_synced` are cumulative per-event counters (misleading as
  // entity counts). These non-destructive fields carry the REAL unique
  // entity counts and must be preferred by the progress screen when present.
  chats_unique?: number;
  contacts_unique?: number;
  messages_cached?: number;
  started_at?: string | null;
  completed_at?: string | null;
}

// Faz 11: WS tabanli initial-sync job sozlesmesi (backend WhatsAppSyncJobResponse).
export interface WhatsAppSyncJob {
  sync_id: string | null;
  state: 'IDLE' | 'SYNCING' | 'COMPLETED' | 'FAILED' | string;
  stage: string;
  error?: string | null;
  chats_total: number;
  chats_synced: number;
  contacts_synced: number;
  messages_total: number;
  messages_synced: number;
  started_at?: string | null;
  finished_at?: string | null;
}

// Faz 0 kontrakt — Loading Gate (WhatsApp Web paritesi): tek-authority yukleme kapisi.
export type LoadingGatePhase = 'idle' | 'qr' | 'connecting' | 'syncing_history' | 'loading_profiles' | 'ready' | 'error';
export interface LoadingGateCounts {
  chats_total: number;
  chats_synced: number;
  messages_total: number;
  messages_synced: number;
  avatars_total: number;
  avatars_fetched: number;
  avatars_missing: number;
}
export interface WhatsAppLoadingGate {
  session_id: number | null;
  phase: LoadingGatePhase | string;
  stage: string;
  progress: number;
  counts: LoadingGateCounts;
  /**
   * Informational only. Avatars keep streaming in after the gate opens, so this
   * is a hint for the UI and never a reason to keep someone waiting.
   */
  avatars_pending?: boolean;
  gateway_available: boolean;
  gateway_error?: string | null;
  error?: string | null;
}

export interface WhatsAppSession {
  id: number;
  whatsapp_number_id?: number | null;
  session_name: string;
  phone_number?: string;
  status: SessionStatus;
  qr_code?: string;
  is_active: boolean;
  // D1: these metrics are only real when the backend actually sends them.
  // They are optional so the UI never renders fabricated quota/warm-up data.
  warm_up_day?: number;
  daily_sent_count?: number;
  max_daily_limit?: number;
  // Faz 3: Numara Isıtma (Warm-Up Mode)
  is_warmup_enabled?: boolean;
  warmup_started_at?: string | null;
  warmup_current_day?: number;
  warmup_daily_limit?: number;
  warmup_target_limit?: number;
  warmup_graduated_at?: string | null;
  is_phone_online: boolean;
  battery_level?: number;
  error_message?: string;
  sync?: SessionSyncState;
  // Faz 14: hattin ILK senkronu tamamlandi mi (backend'de kalici). QR sonrasi
  // canli sohbetler bu alan `true` olana kadar kapali tutulur (WhatsApp Web
  // paritesi). Optional: alan gelmezse "bilinmiyor" sayilir ve kapi yalnizca
  // gercek bir senkron calisirken kapanir — asla sonsuza kadar kapanmaz.
  initial_sync_completed?: boolean;
  created_at: string;
  updated_at: string;
}

export enum LiveModeStatus {
  LIVE_DISCONNECTED = 'LIVE_DISCONNECTED',
  LIVE_CONNECTING = 'LIVE_CONNECTING',
  LIVE_CONNECTED = 'LIVE_CONNECTED',
}

export interface DashboardStats {
  total_leads: number;
  whatsapp_eligible_leads: number;
  contacted_leads: number;
  replied_leads: number;
  response_rate_percentage: number;
  total_campaigns: number;
  active_campaigns: number;
  connected_sessions: number;
  total_messages_sent: number;
  messages_sent_today: number;
  daily_volume: Array<{
    date: string;
    sent_messages: number;
    leads_scraped: number;
  }>;
  leads_by_status: Record<string, number>;
  top_categories: Array<{
    category: string;
    count: number;
  }>;
  recent_activity: Array<{
    id: number;
    phone: string;
    status: string;
    time: string;
    message_snippet: string;
  }>;
}

export interface AntiBanConfig {
  preset: string;
  min_delay_seconds: number;
  max_delay_seconds: number;
  typing_delay_seconds: number;
  daily_message_limit: number;
  working_hours_enabled: boolean;
  working_hours_start: string;
  working_hours_end: string;
  updated_at?: string;
}

export interface ScraperJob {
  id: number;
  keyword: string;
  location: string;
  city?: string;
  districts_json?: string[];
  source: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  total_found: number;
  total_valid_phones: number;
  total_new_leads: number;
  duration_seconds: number;
  error_message?: string;
  completed_at?: string;
  created_at: string;
}

export interface BlacklistEntry {
  id: number;
  phone_e164: string;
  reason: string;
  notes?: string;
  created_at: string;
  lead_name?: string;
  lead_category?: string;
  lead_city?: string;
  lead_district?: string;
  lead_address?: string;
  lead_rating?: number;
  lead_reviews_count?: number;
  lead_website?: string;
}

export interface BlacklistPaginationResponse {
  items: BlacklistEntry[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

export type ConversationStatus = 'ACTIVE' | 'ARCHIVED' | 'CLOSED';
export type MessageDirection = 'INBOUND' | 'OUTBOUND';
export type MessageType = 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'VIDEO' | 'STICKER' | 'LOCATION' | 'CONTACT' | 'TEMPLATE' | 'UNKNOWN' | 'OTHER';
export type ConversationMessageStatus = 'PENDING' | 'RECEIVED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/**
 * Sunucu tarafinda cozulmus link onizlemesi.
 *
 * `image_url` UZAK adres DEGIL, kimlik dogrulamali proxy yoludur
 * (`/api/v1/whatsapp/link-preview/image?u=<hash>`). Uzak gorseli dogrudan
 * yuklemek kullanicinin IP'sini sizdirir ve saglayicinin referrer/CORS
 * kurallarina takilir; proxy ikisi de cozer.
 *
 * `kind` hangi kartin cizilecegini soyler: LINK | VIDEO | IMAGE | DOCUMENT.
 * `embed_url` yalnizca izin listesindeki saglayicilar icin doludur
 * (YouTube) — keyfi URL'ler asla iframe'e konmaz.
 */
export interface LinkPreview {
  url: string;
  kind: 'LINK' | 'VIDEO' | 'IMAGE' | 'DOCUMENT';
  title?: string | null;
  description?: string | null;
  site_name?: string | null;
  image_url?: string | null;
  embed_url?: string | null;
}

export interface MessageReaction {
  /** Mesaj reaksiyonu: kisi basina mesaj basina TEK ifade.
   * `emoji` HER ZAMAN doludur; geri cekilmis satirlar sunucudan hic gelmez
   * (yokluk = ifade yok). `reactor_jid` kendi hattimiz icin 'ME' sentinelidir. */
  message_id: number;
  emoji: string;
  from_me: boolean;
  reactor_jid?: string | null;
  reactor_name?: string | null;
  updated_at?: string | null;
}

export interface Message {
  // Server messages carry a numeric DB primary key. Optimistic (not yet
  // persisted) messages carry a client-only string such as
  // `optimistic_cmsg_...` which must NEVER be sent to /retry.
  id: number | string;
  conversation_id: number;
  direction: MessageDirection;
  message_type: MessageType;
  status: ConversationMessageStatus;
  body?: string;
  media_id?: string | null;
  media_mime_type?: string | null;
  media_filename?: string | null;
  media_caption?: string | null;
  media_url?: string;
  wa_message_id?: string;
  client_message_id?: string;
  sender_phone?: string;
  sender_name?: string | null;
  recipient_phone?: string;
  error_message?: string;
  /** Bu mesaja birakilan ifadeler (kisi basina tek). Sunucu her zaman bu
   * anahtari dondurur; yoksa bos dizi. */
  reactions?: MessageReaction[];
  /** Govdedeki link icin sunucu tarafinda cozulmus onizleme. `null`/yok =
   * onizleme yok VEYA henuz cozulmedi — ikisi de ayni sekilde ele alinir
   * (kart cizilmez), cunku ikisi de kullaniciya gosterilecek bir sey
   * oldugunu soylemez. */
  link_preview?: LinkPreview | null;
  /** Yanitlanan (alintilanan) mesaj bilgisi snapshot'i (WhatsApp native reply). */
  quoted_message?: QuotedMessageData | null;
  /** WhatsApp native iletildi (forwarded) bayragi. */
  is_forwarded?: boolean;
  /** WhatsApp native sabitlendi (pinned) bilgileri. */
  is_pinned?: boolean;
  pinned_at?: string | null;
  pinned_until?: string | null;
  /** Granular message delivery lifecycle timestamps */
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  external_timestamp?: string;
  created_at: string;
}

export interface QuotedMessageData {
  stanza_id?: string | null;
  participant?: string | null;
  sender_name?: string | null;
  sender_phone?: string | null;
  message_type?: string;
  body?: string | null;
  thumbnail?: string | null;
  media_id?: string | null;
  media_url?: string | null;
}

export interface WhatsAppTemplateVariable {
  key: string;
  label: string;
  default_from?: string;
  default_value?: string;
}

export interface WhatsAppTemplate {
  key: string;
  name: string;
  name_en?: string;
  description?: string;
  category?: string;
  body_pattern: string;
  variables: WhatsAppTemplateVariable[];
}

export interface QuickReplyVariable {
  key: string;
  label: string;
  default_from?: string;
  default_value?: string;
}

export interface QuickReply {
  id: number;
  user_id?: string | null;
  shortcut: string;
  title: string;
  content: string;
  category?: string | null;
  variables?: QuickReplyVariable[] | null;
  created_at?: string;
  updated_at?: string;
}

export interface QuickReplyCreateRequest {
  shortcut: string;
  title: string;
  content: string;
  category?: string;
  variables?: QuickReplyVariable[];
}

export interface QuickReplyUpdateRequest {
  shortcut?: string;
  title?: string;
  content?: string;
  category?: string;
  variables?: QuickReplyVariable[];
}

export interface Conversation {
  id: number;
  lead_id?: number | null;
  lead_status?: LeadStatus | null;
  /** Backend WhatsApp line identity; same contact may exist on many lines. */
  session_id?: number | null;
  whatsapp_number_id?: number | null;
  contact_id?: number | null;
  channel: string;
  status: ConversationStatus;
  last_message_at?: string;
  unread_count: number;
  last_read_at?: string;
  created_at?: string;
  updated_at?: string;
  lead_name?: string;
  lead_phone?: string;
  lead_avatar_url?: string;
  is_group?: boolean;
  is_self?: boolean;
  // Sorun 4: WhatsApp arsiv durumu (Baileys metadata) — CRM status'tan bagimsiz.
  is_archived?: boolean;
  last_message_preview?: string;
  /** WhatsApp Web paritesi: liste satirinda SON MESAJIN en yeni ifadesi.
   * Eski bir mesaja birakilan ifade listede gorunmez (sunucu hesaplar). */
  last_reaction?: MessageReaction | null;
  // Faz 10 (P2): "Henüz WhatsApp Mesajı Yok" yalnızca message_count===0 &&
  // last_message_state==='NO_MESSAGES' iken gösterilir; LOADING/REPAIRING
  // durumlarında senkron sürüyor mesajı gösterilir.
  message_count?: number;
  last_message_state?: 'RESOLVED' | 'NO_MESSAGES' | 'REPAIRING' | 'LOADING' | string;
  identity_state?: 'RESOLVED_PROFILE' | 'RESOLVED_PHONE' | 'RESOLVED_JID' | 'RESOLVING_TRANSIENT' | 'UNRESOLVED_PERMANENT' | string;
  is_window_open?: boolean;
  last_inbound_at?: string;
  seconds_remaining?: number;
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
  has_more?: boolean;
  oldest_message_id?: number;
  newest_message_id?: number;
}

export interface HistoryEvidence {
  state: string;
  provider_checked: boolean;
  provider_exhausted: boolean;
  provider_msgs_returned: number;
}

export interface ConversationMessagesResponse {
  messages: Message[];
  has_more: boolean;
  oldest_message_id?: number;
  newest_message_id?: number;
  history_evidence?: HistoryEvidence;
}

export type CategoryFitLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'ALTERNATIVE';
export type BusinessGoal = 'DISCOVERY' | 'INTRO' | 'OFFER' | 'FOLLOW_UP' | 'MEETING';
export type CategorySource = 'DISCOVERED' | 'USER_ADDED';

export interface DiscoveredCategory {
  category_id: string;
  display_name: string;
  rationale: string;
  fit_level: CategoryFitLevel;
  search_keywords: string[];
  source: CategorySource;
  is_recommended: boolean;
  estimated_volume?: string;
}

export interface CategoryRecommendationResponse {
  offer_title: string;
  business_goal: BusinessGoal;
  discovered_categories: DiscoveredCategory[];
  suggested_custom_categories: string[];
}

export interface FitAssessment {
  fit_score: number;
  fit_level: CategoryFitLevel;
  target_category: string;
  category_approved_by_user: boolean;
  positive_signals: string[];
  risk_factors: string[];
  recommended_intent: BusinessGoal;
  recommended_message_snippet?: string;
}

export interface SmartMatchedLead {
  lead_id: number;
  name: string;
  phone: string;
  phone_e164?: string;
  is_whatsapp_eligible: boolean;
  city?: string;
  district?: string;
  website?: string;
  rating?: number;
  target_category: string;
  category_source: CategorySource;
  fit_assessment: FitAssessment;
}

export interface MatchLeadsResponse {
  total_evaluated: number;
  high_fit_count: number;
  medium_fit_count: number;
  low_fit_count: number;
  leads: SmartMatchedLead[];
}

export interface MessageRecommendationResponse {
  lead_id: number;
  lead_name: string;
  target_category: string;
  business_goal: BusinessGoal;
  strategy_summary: string;
  recommended_message: string;
  alternative_message?: string;
}

export type PlanTier = 'STARTER' | 'PRO' | 'AGENCY' | 'DEVELOPER_PRO' | 'UNLIMITED';

export interface UserProfile {
  id: string;
  email: string;
  full_name?: string;
  avatar_url?: string;
  plan_tier: PlanTier;
  leads_monthly_limit: number;
  leads_used_this_month: number;
  messages_daily_limit: number;
  created_at: string;
  is_admin?: boolean;
}

export interface ApiKeyItem {
  id: number;
  name: string;
  key_prefix: string;
  is_active: boolean;
  last_used_at?: string;
  expires_at?: string;
  created_at: string;
}

export interface ApiKeyCreatedItem extends ApiKeyItem {
  raw_key: string;
}

export interface WebhookItem {
  id: number;
  name: string;
  target_url: string;
  events: string[];
  is_active: boolean;
  secret: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryLogItem {
  id: number;
  subscription_id: number;
  event_type: string;
  payload?: Record<string, unknown>;
  status_code?: number;
  response_body?: string;
  duration_ms?: number;
  is_success: boolean;
  error_message?: string;
  created_at: string;
}

export interface WebhookTestResult {
  success: boolean;
  status_code?: number;
  response_body?: string;
  duration_ms?: number;
  error?: string;
}

export interface QuotaMetric {
  used: number;
  limit: number;
  remaining: number;
  percentage: number;
}

export interface QuotaUsageSummary {
  user_id: string;
  plan_tier: string;
  plan_name: string;
  billing_cycle: string;
  period_start: string;
  period_end: string;
  days_until_renewal: number;
  leads: QuotaMetric;
  whatsapp_daily: QuotaMetric;
  ai_daily: QuotaMetric;
  active_campaigns: QuotaMetric;
  features: {
    webhooks: boolean;
    api_access: boolean;
    export_csv: boolean;
    [key: string]: boolean;
  };
}

export interface PlanInfo {
  id: string;
  name: string;
  price_try: number;
  monthly_lead_scrape_limit: number;
  daily_whatsapp_outreach_limit: number;
  max_active_campaigns: number;
  ai_daily_limit: number;
  webhooks_enabled: boolean;
  api_access_enabled: boolean;
  export_csv_enabled: boolean;
  badge_color: string;
  description: string;
  features_list: string[];
  is_current?: boolean;
}

export interface PlanListResponse {
  current_plan_tier: string;
  plans: PlanInfo[];
}

export interface CampaignMediaUploadResponse {
  file_id: string;
  media_url: string;
  media_type: 'IMAGE' | 'DOCUMENT' | 'VIDEO' | 'AUDIO';
  mime_type: string;
  filename: string;
  size_bytes: number;
}

export interface AiSuggestionItem {
  id: string;
  title: string;
  text: string;
  tone: 'PROFESSIONAL' | 'PERSUASIVE' | 'CALL_TO_ACTION';
}

export interface AiMatchedQuickReply {
  id: number;
  shortcut: string;
  title: string;
  content: string;
  category?: string;
}

export interface AiSuggestReplyResponse {
  conversation_id: number;
  contact_name?: string;
  category?: string;
  detected_intent: string;
  intent_label: string;
  latest_customer_message?: string;
  suggestions: AiSuggestionItem[];
  matching_quick_replies: AiMatchedQuickReply[];
}

export interface WhatsAppWarmupStatus {
  session_id: number;
  session_name: string;
  phone_number?: string | null;
  is_warmup_enabled: boolean;
  current_day: number;
  daily_limit: number;
  sent_today: number;
  remaining_today: number;
  target_limit: number;
  is_graduated: boolean;
  started_at?: string | null;
  graduated_at?: string | null;
  schedule: Array<{ day: number; daily_limit: number; label: string }>;
}

export interface ProxyPoolStatus {
  enabled: boolean;
  total_proxies: number;
  active_proxies: number;
  rotation_strategy: string;
  proxies: string[];
  timeout_seconds: number;
}

export interface ProxyConfigPayload {
  enabled: boolean;
  proxies: string[];
  rotation_strategy: string;
  timeout_seconds?: number;
}

export interface ProxyTestResult {
  success: boolean;
  proxy_url: string;
  latency_ms?: number | null;
  exit_ip?: string | null;
  error?: string | null;
}

export interface SmtpConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  sender_email: string;
  sender_name?: string;
  use_tls?: boolean;
  use_ssl?: boolean;
  is_configured?: boolean;
}

export * from './admin';



