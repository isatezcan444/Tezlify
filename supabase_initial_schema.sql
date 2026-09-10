DO 8838 BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'discoveryrunstatus') THEN CREATE TYPE discoveryrunstatus AS ENUM ('PENDING', 'RUNNING', 'PARTIAL', 'SATURATED', 'BENCHMARK_RECOVERED', 'BUDGET_EXHAUSTED', 'COMPLETED', 'FAILED', 'CANCELLED'); END IF; END 8838;

DO 8838 BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leadstatus') THEN CREATE TYPE leadstatus AS ENUM ('NEW', 'CONTACTED', 'REPLIED', 'INTERESTED', 'UNSUBSCRIBED', 'INVALID_NUMBER'); END IF; END 8838;

DO 8838 BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scraperjobstatus') THEN CREATE TYPE scraperjobstatus AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'); END IF; END 8838;

DO 8838 BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'campaignstatus') THEN CREATE TYPE campaignstatus AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'); END IF; END 8838;

DO 8838 BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversationstatus') THEN CREATE TYPE conversationstatus AS ENUM ('ACTIVE', 'ARCHIVED', 'CLOSED'); END IF; END 8838;

DO 8838 BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'messagestatus') THEN CREATE TYPE messagestatus AS ENUM ('PENDING', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'REPLIED', 'FAILED', 'CANCELLED'); END IF; END 8838;

DO 8838 BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'messagedirection') THEN CREATE TYPE messagedirection AS ENUM ('INBOUND', 'OUTBOUND'); END IF; END 8838;

DO 8838 BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'messagetype') THEN CREATE TYPE messagetype AS ENUM ('TEXT', 'IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO', 'TEMPLATE', 'OTHER'); END IF; END 8838;

DO 8838 BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversationmessagestatus') THEN CREATE TYPE conversationmessagestatus AS ENUM ('RECEIVED', 'SENT', 'DELIVERED', 'READ', 'FAILED'); END IF; END 8838;

CREATE TABLE blacklist (
	id SERIAL NOT NULL, 
	phone_e164 VARCHAR(50) NOT NULL, 
	reason VARCHAR(255), 
	notes TEXT, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_blacklist_phone_e164 ON blacklist (phone_e164);

CREATE INDEX ix_blacklist_id ON blacklist (id);

CREATE TABLE campaign_groups (
	id SERIAL NOT NULL, 
	name VARCHAR(200) NOT NULL, 
	description TEXT, 
	target_category VARCHAR(100), 
	target_location VARCHAR(200), 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_campaign_groups_name ON campaign_groups (name);

CREATE INDEX ix_campaign_groups_target_category ON campaign_groups (target_category);

CREATE INDEX ix_campaign_groups_id ON campaign_groups (id);

CREATE TABLE discovery_runs (
	id SERIAL NOT NULL, 
	user_keyword VARCHAR(200) NOT NULL, 
	canonical_category VARCHAR(100) NOT NULL, 
	city VARCHAR(100) NOT NULL, 
	districts JSON NOT NULL, 
	status discoveryrunstatus, 
	completion_reason VARCHAR(100), 
	error_message TEXT, 
	total_raw_candidates INTEGER, 
	unique_entities_count INTEGER, 
	qualified_leads_count INTEGER, 
	rejected_candidates_count INTEGER, 
	known_entities_total INTEGER, 
	known_entities_recovered INTEGER, 
	known_entity_recall FLOAT, 
	provider_statistics JSON, 
	coverage_metrics JSON, 
	benchmark_report JSON, 
	started_at TIMESTAMP WITHOUT TIME ZONE, 
	completed_at TIMESTAMP WITHOUT TIME ZONE, 
	duration_seconds INTEGER, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_discovery_runs_id ON discovery_runs (id);

CREATE INDEX ix_discovery_runs_status ON discovery_runs (status);

CREATE INDEX ix_discovery_runs_city ON discovery_runs (city);

CREATE INDEX idx_disc_run_city_cat ON discovery_runs (city, canonical_category);

CREATE INDEX ix_discovery_runs_canonical_category ON discovery_runs (canonical_category);

CREATE TABLE leads (
	id SERIAL NOT NULL, 
	name VARCHAR(255) NOT NULL, 
	category VARCHAR(100), 
	entity_type VARCHAR(50), 
	verification_status VARCHAR(50), 
	confidence_level VARCHAR(20), 
	confidence_score INTEGER, 
	is_verified BOOLEAN, 
	canonical_category VARCHAR(100), 
	category_score FLOAT, 
	category_classification VARCHAR(50), 
	discovered_from VARCHAR(100), 
	verified_by VARCHAR(200), 
	verification_trace JSON, 
	phone VARCHAR(50) NOT NULL, 
	phone_e164 VARCHAR(30), 
	is_mobile BOOLEAN, 
	is_whatsapp_eligible BOOLEAN, 
	address TEXT, 
	city VARCHAR(100), 
	district VARCHAR(100), 
	latitude FLOAT, 
	longitude FLOAT, 
	website VARCHAR(255), 
	email VARCHAR(255), 
	rating FLOAT, 
	reviews_count INTEGER, 
	place_id VARCHAR(255), 
	search_keyword VARCHAR(200), 
	search_location VARCHAR(200), 
	source VARCHAR(50), 
	status leadstatus, 
	notes TEXT, 
	custom_data JSON, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	last_contacted_at TIMESTAMP WITHOUT TIME ZONE, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_leads_category ON leads (category);

CREATE INDEX ix_leads_name ON leads (name);

CREATE INDEX idx_lead_city_category ON leads (city, category);

CREATE INDEX ix_leads_entity_type ON leads (entity_type);

CREATE INDEX ix_leads_verification_status ON leads (verification_status);

CREATE INDEX ix_leads_status ON leads (status);

CREATE INDEX idx_lead_status_created ON leads (status, created_at);

CREATE INDEX ix_leads_search_keyword ON leads (search_keyword);

CREATE INDEX ix_leads_city ON leads (city);

CREATE INDEX ix_leads_id ON leads (id);

CREATE INDEX idx_lead_verified_entity ON leads (is_verified, entity_type);

CREATE INDEX ix_leads_is_verified ON leads (is_verified);

CREATE INDEX ix_leads_canonical_category ON leads (canonical_category);

CREATE INDEX ix_leads_district ON leads (district);

CREATE UNIQUE INDEX ix_leads_place_id ON leads (place_id);

CREATE UNIQUE INDEX ix_leads_phone_e164 ON leads (phone_e164);

CREATE TABLE contacts (
	id SERIAL NOT NULL, 
	user_id UUID, 
	phone_e164 VARCHAR(50) NOT NULL, 
	display_name VARCHAR(150), 
	lead_id INTEGER, 
	custom_attributes JSON, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(lead_id) REFERENCES leads (id) ON DELETE SET NULL
);

CREATE INDEX ix_contacts_id ON contacts (id);

CREATE INDEX ix_contacts_phone_e164 ON contacts (phone_e164);

CREATE INDEX ix_contacts_user_id ON contacts (user_id);

CREATE INDEX idx_contact_user_phone ON contacts (user_id, phone_e164);

CREATE TABLE raw_candidates (
	id SERIAL NOT NULL, 
	discovery_run_id INTEGER, 
	provider_name VARCHAR(50) NOT NULL, 
	provider_record_id VARCHAR(100), 
	strategy_id VARCHAR(100), 
	query_id VARCHAR(100), 
	query_text VARCHAR(500), 
	source_url VARCHAR(500), 
	raw_name VARCHAR(255) NOT NULL, 
	clean_name VARCHAR(255) NOT NULL, 
	raw_phone VARCHAR(100), 
	phone_e164 VARCHAR(30), 
	raw_website VARCHAR(255), 
	raw_address TEXT, 
	raw_lat FLOAT, 
	raw_lon FLOAT, 
	raw_category VARCHAR(100), 
	raw_payload JSON, 
	is_qualified BOOLEAN, 
	rejection_stage VARCHAR(50), 
	rejection_reason TEXT, 
	discovered_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_raw_candidates_discovery_run_id ON raw_candidates (discovery_run_id);

CREATE INDEX ix_raw_candidates_raw_name ON raw_candidates (raw_name);

CREATE INDEX ix_raw_candidates_is_qualified ON raw_candidates (is_qualified);

CREATE INDEX ix_raw_candidates_id ON raw_candidates (id);

CREATE INDEX ix_raw_candidates_provider_record_id ON raw_candidates (provider_record_id);

CREATE INDEX ix_raw_candidates_clean_name ON raw_candidates (clean_name);

CREATE INDEX idx_raw_cand_run_prov ON raw_candidates (discovery_run_id, provider_name);

CREATE INDEX idx_raw_cand_phone_name ON raw_candidates (phone_e164, clean_name);

CREATE INDEX ix_raw_candidates_provider_name ON raw_candidates (provider_name);

CREATE INDEX ix_raw_candidates_query_id ON raw_candidates (query_id);

CREATE INDEX ix_raw_candidates_phone_e164 ON raw_candidates (phone_e164);

CREATE TABLE scraper_jobs (
	id SERIAL NOT NULL, 
	keyword VARCHAR(200) NOT NULL, 
	location VARCHAR(200) NOT NULL, 
	city VARCHAR(100), 
	districts_json JSON, 
	source VARCHAR(50), 
	status scraperjobstatus, 
	total_found INTEGER, 
	total_valid_phones INTEGER, 
	total_new_leads INTEGER, 
	error_message TEXT, 
	duration_seconds INTEGER, 
	started_at TIMESTAMP WITHOUT TIME ZONE, 
	completed_at TIMESTAMP WITHOUT TIME ZONE, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_scraper_jobs_status ON scraper_jobs (status);

CREATE INDEX ix_scraper_jobs_id ON scraper_jobs (id);

CREATE INDEX ix_scraper_jobs_city ON scraper_jobs (city);

CREATE TABLE system_settings (
	id SERIAL NOT NULL, 
	key VARCHAR(100) NOT NULL, 
	preset VARCHAR(50), 
	min_delay_seconds INTEGER, 
	max_delay_seconds INTEGER, 
	typing_delay_seconds INTEGER, 
	daily_message_limit INTEGER, 
	working_hours_enabled BOOLEAN, 
	working_hours_start VARCHAR(10), 
	working_hours_end VARCHAR(10), 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_system_settings_key ON system_settings (key);

CREATE TABLE campaign_group_leads (
	group_id INTEGER NOT NULL, 
	lead_id INTEGER NOT NULL, 
	added_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (group_id, lead_id), 
	FOREIGN KEY(group_id) REFERENCES campaign_groups (id) ON DELETE CASCADE, 
	FOREIGN KEY(lead_id) REFERENCES leads (id) ON DELETE CASCADE
);

CREATE TABLE campaigns (
	id SERIAL NOT NULL, 
	name VARCHAR(200) NOT NULL, 
	description TEXT, 
	message_template TEXT NOT NULL, 
	status campaignstatus, 
	min_delay_seconds INTEGER, 
	max_delay_seconds INTEGER, 
	typing_delay_seconds INTEGER, 
	working_hours_enabled BOOLEAN, 
	working_hours_start VARCHAR(10), 
	working_hours_end VARCHAR(10), 
	group_id INTEGER, 
	total_leads_target INTEGER, 
	sent_count INTEGER, 
	delivered_count INTEGER, 
	replied_count INTEGER, 
	failed_count INTEGER, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(group_id) REFERENCES campaign_groups (id) ON DELETE SET NULL
);

CREATE INDEX ix_campaigns_id ON campaigns (id);

CREATE INDEX ix_campaigns_status ON campaigns (status);

CREATE TABLE conversations (
	id SERIAL NOT NULL, 
	user_id UUID, 
	lead_id INTEGER, 
	contact_id INTEGER, 
	channel VARCHAR(30) NOT NULL, 
	status conversationstatus NOT NULL, 
	last_message_at TIMESTAMP WITHOUT TIME ZONE, 
	unread_count INTEGER NOT NULL, 
	last_read_at TIMESTAMP WITHOUT TIME ZONE, 
	archived_at TIMESTAMP WITHOUT TIME ZONE, 
	closed_at TIMESTAMP WITHOUT TIME ZONE, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(lead_id) REFERENCES leads (id) ON DELETE SET NULL, 
	FOREIGN KEY(contact_id) REFERENCES contacts (id) ON DELETE SET NULL
);

CREATE INDEX ix_conversations_channel ON conversations (channel);

CREATE INDEX ix_conversations_lead_id ON conversations (lead_id);

CREATE INDEX ix_conversations_status ON conversations (status);

CREATE INDEX idx_conv_lead_channel_status ON conversations (lead_id, channel, status);

CREATE INDEX ix_conversations_id ON conversations (id);

CREATE INDEX ix_conversations_last_message_at ON conversations (last_message_at);

CREATE TABLE message_logs (
	id SERIAL NOT NULL, 
	user_id UUID, 
	lead_id INTEGER NOT NULL, 
	campaign_id INTEGER, 
	target_phone VARCHAR(50) NOT NULL, 
	rendered_message TEXT NOT NULL, 
	status messagestatus, 
	scheduled_for TIMESTAMP WITHOUT TIME ZONE, 
	sent_at TIMESTAMP WITHOUT TIME ZONE, 
	error_reason TEXT, 
	delay_applied_seconds INTEGER, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(lead_id) REFERENCES leads (id) ON DELETE CASCADE, 
	FOREIGN KEY(campaign_id) REFERENCES campaigns (id) ON DELETE SET NULL
);

CREATE INDEX idx_msg_status_sched ON message_logs (status, scheduled_for);

CREATE INDEX ix_message_logs_status ON message_logs (status);

CREATE INDEX ix_message_logs_target_phone ON message_logs (target_phone);

CREATE INDEX ix_message_logs_id ON message_logs (id);

CREATE INDEX ix_message_logs_campaign_id ON message_logs (campaign_id);

CREATE INDEX ix_message_logs_lead_id ON message_logs (lead_id);

CREATE INDEX ix_message_logs_scheduled_for ON message_logs (scheduled_for);

CREATE TABLE messages (
	id SERIAL NOT NULL, 
	user_id UUID, 
	conversation_id INTEGER NOT NULL, 
	direction messagedirection NOT NULL, 
	message_type messagetype NOT NULL, 
	body TEXT, 
	media_id VARCHAR(255), 
	media_mime_type VARCHAR(100), 
	media_filename VARCHAR(255), 
	media_caption TEXT, 
	sender_phone VARCHAR(50) NOT NULL, 
	recipient_phone VARCHAR(50) NOT NULL, 
	status conversationmessagestatus NOT NULL, 
	error_code INTEGER, 
	error_message TEXT, 
	external_timestamp TIMESTAMP WITHOUT TIME ZONE, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
);

CREATE INDEX ix_messages_id ON messages (id);

CREATE INDEX ix_messages_media_id ON messages (media_id);

CREATE INDEX ix_messages_status ON messages (status);

CREATE INDEX ix_messages_direction ON messages (direction);

CREATE INDEX ix_messages_sender_phone ON messages (sender_phone);

CREATE INDEX idx_msg_conv_created ON messages (conversation_id, created_at);

CREATE INDEX ix_messages_conversation_id ON messages (conversation_id);

CREATE INDEX ix_messages_recipient_phone ON messages (recipient_phone);

CREATE INDEX idx_msg_conv_id ON messages (conversation_id, id);