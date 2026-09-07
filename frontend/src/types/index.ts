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
  custom_data?: Record<string, any>;
  created_at: string;
  updated_at: string;
  last_contacted_at?: string;
}

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';

export interface Campaign {
  id: number;
  name: string;
  description?: string;
  message_template: string;
  status: CampaignStatus;
  min_delay_seconds: number;
  max_delay_seconds: number;
  typing_delay_seconds: number;
  working_hours_enabled: boolean;
  working_hours_start: string;
  working_hours_end: string;
  session_id?: number;
  group_id?: number;
  total_leads_target: number;
  sent_count: number;
  delivered_count: number;
  replied_count: number;
  failed_count: number;
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


export type SessionStatus = 'DISCONNECTED' | 'SCAN_QR' | 'CONNECTING' | 'CONNECTED' | 'BANNED';

export interface WhatsAppSession {
  id: number;
  session_name: string;
  phone_number?: string;
  status: SessionStatus;
  qr_code?: string;
  is_active: boolean;
  warm_up_day: number;
  daily_sent_count: number;
  max_daily_limit: number;
  is_phone_online: boolean;
  battery_level?: number;
  error_message?: string;
  created_at: string;
  updated_at: string;
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

export interface MessageLog {
  id: number;
  lead_id: number;
  campaign_id?: number;
  session_id?: number;
  target_phone: string;
  rendered_message: string;
  status: string;
  wa_message_id?: string;
  reply_received: boolean;
  reply_text?: string;
  delay_applied_seconds?: number;
  sent_at?: string;
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
export type MessageType = 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'VIDEO' | 'TEMPLATE' | 'OTHER';
export type ConversationMessageStatus = 'RECEIVED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface Message {
  id: number;
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
  sender_phone?: string;
  sender_name?: string | null;
  recipient_phone?: string;
  error_message?: string;
  external_timestamp?: string;
  created_at: string;
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

export interface Conversation {
  id: number;
  lead_id: number;
  channel: string;
  status: ConversationStatus;
  last_message_at?: string;
  unread_count: number;
  last_read_at?: string;
  created_at: string;
  updated_at: string;
  lead_name?: string;
  lead_phone?: string;
  lead_avatar_url?: string;
  is_group?: boolean;
  last_message_preview?: string;
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

export interface ConversationMessagesResponse {
  messages: Message[];
  has_more: boolean;
  oldest_message_id?: number;
  newest_message_id?: number;
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
}

