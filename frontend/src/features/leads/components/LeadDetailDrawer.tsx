import React, { useState, useEffect, useRef } from 'react';
import { 
  Building2, 
  Phone, 
  MapPin, 
  Star, 
  Globe, 
  Send, 
  ShieldAlert, 
  Trash2, 
  ExternalLink,
  MessageSquare,
  Copy,
  Check,
  Sparkles,
  Mail,
  RefreshCw
} from 'lucide-react';
import { Lead, LeadStatus } from '../../../types';
import { Drawer } from '../../../components/ui/Drawer';
import { Avatar } from '../../../components/ui/Avatar';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { IconButton } from '../../../components/ui/IconButton';
import { WhatsAppIcon } from '../../../components/ui/whatsapp-icon';
import { GoogleMapsIcon } from '../../../components/ui/google-maps-icon';
import { ChatThread } from '../../whatsapp/components/ChatThread';
import { ChatComposer } from '../../whatsapp/components/ChatComposer';
import { TemplateSelectModal } from '../../whatsapp/components/TemplateSelectModal';
import { SendEmailModal } from './SendEmailModal';
import { useWhatsAppConversation } from '../../whatsapp/hooks/useWhatsAppConversation';
import { useI18n } from '../../../context/I18nContext';
import { translateApiError } from '../../whatsapp/lib/translateError';
import { useToast } from '../../../context/ToastContext';
import { ApiClient } from '../../../api/client';

export interface LeadDetailDrawerProps {
  lead: Lead | null;
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'overview' | 'chat';
  onSendMessage?: (lead: Lead) => void;
  onBlacklist?: (lead: Lead) => void;
  onDelete?: (lead: Lead) => void;
  onStatusChange?: (leadId: number, status: LeadStatus) => void;
  onLeadUpdated?: (lead: Lead) => void;
}

export const LeadDetailDrawer: React.FC<LeadDetailDrawerProps> = ({
  lead,
  isOpen,
  onClose,
  initialTab = 'overview',
  onSendMessage,
  onBlacklist,
  onDelete,
  onStatusChange,
  onLeadUpdated,
}) => {
  const { t } = useI18n();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<'overview' | 'chat'>(initialTab);
  const [currentLead, setCurrentLead] = useState<Lead | null>(lead);
  const [isEnriching, setIsEnriching] = useState<boolean>(false);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);

  useEffect(() => {
    setCurrentLead(lead);
  }, [lead]);

  const displayLead = currentLead || lead;

  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState<boolean>(false);
  const [isSendEmailModalOpen, setIsSendEmailModalOpen] = useState<boolean>(false);
  const [insertedComposerText, setInsertedComposerText] = useState<{ text: string; timestamp: number } | null>(null);
  const [copiedPhone, setCopiedPhone] = useState(false);

  const handleCopyPhone = async () => {
    const p = displayLead?.phone_e164 || displayLead?.phone;
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p);
      setCopiedPhone(true);
      toast.success(t('leads.phoneCopied'));
      setTimeout(() => setCopiedPhone(false), 1500);
    } catch {
      // fallback
    }
  };

  const handleCopyEmail = async (emailText: string) => {
    try {
      await navigator.clipboard.writeText(emailText);
      setCopiedEmail(emailText);
      toast.success(t('leads.emailCopied'));
      setTimeout(() => setCopiedEmail(null), 1500);
    } catch {
      // fallback
    }
  };

  const handleEnrichLead = async () => {
    if (!displayLead || !displayLead.website) return;
    setIsEnriching(true);
    try {
      const res = await ApiClient.enrichLead(displayLead.id);
      if (res.success && res.lead) {
        setCurrentLead(res.lead);
        onLeadUpdated?.(res.lead);
        toast.success(t('leads.enrichSuccess'));
      } else {
        if (res.lead) {
          setCurrentLead(res.lead);
          onLeadUpdated?.(res.lead);
        }
        toast.error(res.error || t('leads.enrichFailed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('leads.enrichFailed'));
    } finally {
      setIsEnriching(false);
    }
  };

  // Sync initialTab when drawer opens
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  // Hook for live conversation data
  const {
    conversation,
    messages,
    hasMore,
    loadingOlder,
    loading: chatLoading,
    loadOlderMessages,
    updateStatus,
    sendMessage,
    sendTemplate,
    retryMessage,
    sendMedia,
  } = useWhatsAppConversation({
    leadId: displayLead?.id,
    enabled: isOpen && activeTab === 'chat',
  });

  if (!displayLead) return null;

  const getGoogleMapsUrl = () => {
    if ((displayLead as any).maps_url) return (displayLead as any).maps_url;
    if ((displayLead as any).google_maps_url) return (displayLead as any).google_maps_url;
    if (displayLead.custom_data?.google_maps_url) return displayLead.custom_data.google_maps_url;
    if (displayLead.custom_data?.maps_url) return displayLead.custom_data.maps_url;
    const query = [displayLead.name, displayLead.address || [displayLead.district, displayLead.city].filter(Boolean).join(', ')].filter(Boolean).join(' ');
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  };

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title={displayLead.name}
      subtitle={displayLead.category || t('common.general')}
      icon={Building2}
      size="lg"
      footer={
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center space-x-1.5">
            {onBlacklist && (
              <IconButton
                icon={ShieldAlert}
                variant="warning"
                size="sm"
                tooltip={t('blacklist.addNumber')}
                onClick={() => {
                  onBlacklist(displayLead);
                  onClose();
                }}
              />
            )}
            {onDelete && (
              <IconButton
                icon={Trash2}
                variant="danger"
                size="sm"
                tooltip={t('common.delete')}
                onClick={() => {
                  onDelete(displayLead);
                  onClose();
                }}
              />
            )}
          </div>

          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              className="cursor-pointer"
            >
              {t('common.close')}
            </Button>
            {activeTab === 'overview' && (
              <Button
                size="sm"
                onClick={() => setActiveTab('chat')}
                className="bg-[#25D366] hover:bg-[#1EBE5D] text-white font-bold space-x-1.5 cursor-pointer shadow-md shadow-[#25D366]/20"
              >
                <WhatsAppIcon className="w-3.5 h-3.5" />
                <span>{t('leads.tabConversation')}</span>
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex flex-col h-full -mx-4 -my-4 sm:-mx-6 sm:-my-6">
        {/* Vuexy Segmented Tab Bar */}
        <div className="p-3 bg-slate-100/70 dark:bg-white/[0.03] border-b border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between shrink-0">
          <div className="flex p-1 rounded-xl bg-slate-200/80 dark:bg-black/40 space-x-1 w-full">
            <button
              type="button"
              onClick={() => setActiveTab('overview')}
              className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer ${
                activeTab === 'overview'
                  ? 'bg-white dark:bg-[#7367F0] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              <Building2 className="w-3.5 h-3.5" />
              <span>{t('leads.tabOverview')}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('chat')}
              className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer ${
                activeTab === 'chat'
                  ? 'bg-[#25D366] text-white shadow-xs'
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              <WhatsAppIcon className="w-3.5 h-3.5" />
              <span>{t('leads.tabConversation')}</span>
              {displayLead.status === 'REPLIED' && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              )}
            </button>
          </div>
        </div>

        {/* Tab Content */}
        {activeTab === 'overview' ? (
          <div className="flex-1 p-6 space-y-6 overflow-y-auto text-xs">
            {/* Business Hero Card */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-black/20 border border-slate-200/80 dark:border-white/[0.06] flex items-center space-x-3.5">
              <Avatar name={displayLead.name} size="lg" shape="rounded" />
              <div className="min-w-0 flex-1">
                <h4 className="font-extrabold text-sm text-slate-800 dark:text-white truncate">
                  {displayLead.name}
                </h4>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25 dark:text-[#A59DF8]">
                    {displayLead.category || t('common.general')}
                  </span>
                  {displayLead.entity_type && (
                    <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-200 dark:bg-white/[0.08] text-slate-600 dark:text-slate-300">
                      {displayLead.entity_type}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Status Display Card (Automatic CRM Pipeline) */}
            <div className="p-4 rounded-xl border border-slate-200/80 dark:border-white/[0.06] space-y-2 bg-slate-50/50 dark:bg-white/[0.02]">
              <div className="flex items-center justify-between">
                <label className="text-slate-400 dark:text-slate-500 font-bold block uppercase tracking-wider text-[10px]">
                  {t('leads.colStatus')}
                </label>
                <span className="text-[10px] text-slate-400 dark:text-slate-500 flex items-center gap-1 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  {t('leads.statusAutoManaged')}
                </span>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold ${
                  displayLead.status === 'NEW'
                    ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20'
                    : displayLead.status === 'CONTACTED'
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                    : displayLead.status === 'REPLIED'
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                    : displayLead.status === 'INTERESTED'
                    ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20'
                    : displayLead.status === 'UNSUBSCRIBED'
                    ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                    : 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    displayLead.status === 'NEW'
                      ? 'bg-blue-500'
                      : displayLead.status === 'CONTACTED'
                      ? 'bg-amber-500'
                      : displayLead.status === 'REPLIED'
                      ? 'bg-emerald-500 animate-pulse'
                      : displayLead.status === 'INTERESTED'
                      ? 'bg-purple-500'
                      : displayLead.status === 'UNSUBSCRIBED'
                      ? 'bg-rose-500'
                      : 'bg-slate-400'
                  }`} />
                  <span>
                    {displayLead.status === 'NEW'
                      ? t('leads.statusNew')
                      : displayLead.status === 'CONTACTED'
                      ? t('leads.statusContacted')
                      : displayLead.status === 'REPLIED'
                      ? t('leads.statusReplied')
                      : displayLead.status === 'INTERESTED'
                      ? t('leads.statusInterested')
                      : displayLead.status === 'UNSUBSCRIBED'
                      ? t('leads.statusUnsubscribed')
                      : t('leads.statusInvalid')}
                  </span>
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                  {displayLead.status === 'NEW' && t('leads.statusNewDesc')}
                  {displayLead.status === 'CONTACTED' && t('leads.statusContactedDesc')}
                  {displayLead.status === 'REPLIED' && t('leads.statusRepliedDesc')}
                  {displayLead.status === 'INTERESTED' && t('leads.statusInterestedDesc')}
                  {displayLead.status === 'UNSUBSCRIBED' && t('leads.statusUnsubscribedDesc')}
                  {displayLead.status === 'INVALID_NUMBER' && t('leads.statusInvalidDesc')}
                </span>
              </div>
            </div>

            {/* Contact Information */}
            <div className="p-4 rounded-xl border border-slate-200/80 dark:border-white/[0.06] space-y-3">
              <h5 className="text-[11px] font-extrabold uppercase text-slate-400 dark:text-slate-500 tracking-wider">
                {t('leads.colContact')}
              </h5>

              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 font-mono font-bold text-slate-700 dark:text-slate-200 min-w-0">
                  <Phone className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="truncate">{displayLead.phone_e164 || displayLead.phone || t('leads.noPhone')}</span>
                  {(displayLead.phone_e164 || displayLead.phone) && (
                    <button
                      type="button"
                      onClick={handleCopyPhone}
                      title={t('leads.copyPhone')}
                      aria-label={t('leads.copyPhone')}
                      className="p-1 rounded text-slate-400 hover:text-[#7367F0] hover:bg-slate-200/60 dark:hover:bg-white/[0.08] transition-colors cursor-pointer shrink-0"
                    >
                      {copiedPhone ? (
                        <Check className="w-3.5 h-3.5 text-[#28C76F]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>

                {displayLead.is_whatsapp_eligible ? (
                  <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-[#25D366]/15 text-[#25D366] font-bold text-[10px] shrink-0">
                    <WhatsAppIcon className="w-3 h-3" />
                    <span>{t('leads.whatsappActive')}</span>
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-400 shrink-0">
                    {t('leads.whatsappUnverified')}
                  </span>
                )}
              </div>

              {/* Discovered Info Email */}
              {(displayLead.email || (displayLead.emails && displayLead.emails.length > 0)) && (
                <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-white/[0.05]">
                  <div className="flex items-center space-x-2 text-slate-700 dark:text-slate-200 font-mono text-xs min-w-0">
                    <Mail className="w-4 h-4 text-[#7367F0] shrink-0" />
                    <span className="truncate font-semibold">{displayLead.email || displayLead.emails?.[0]}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setIsSendEmailModalOpen(true)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#7367F0]/10 hover:bg-[#7367F0]/20 text-[#7367F0] font-semibold text-[11px] transition-colors cursor-pointer"
                      title={t('leads.sendDirectEmail') || 'E-posta Gönder'}
                    >
                      <Send className="w-3 h-3" />
                      <span>{t('leads.sendDirectEmail') || 'E-posta Gönder'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopyEmail(displayLead.email || displayLead.emails![0])}
                      title={t('leads.copyEmail')}
                      aria-label={t('leads.copyEmail')}
                      className="p-1 rounded text-slate-400 hover:text-[#7367F0] hover:bg-slate-200/60 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
                    >
                      {copiedEmail === (displayLead.email || displayLead.emails?.[0]) ? (
                        <Check className="w-3.5 h-3.5 text-[#28C76F]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <a
                      href={`mailto:${displayLead.email || displayLead.emails?.[0]}`}
                      className="p-1 rounded text-slate-400 hover:text-[#7367F0] hover:bg-slate-200/60 dark:hover:bg-white/[0.08] transition-colors"
                      title={t('leads.sendEmail')}
                      aria-label={t('leads.sendEmail')}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              )}

              {/* Auto-enrichment in progress notice in contact card */}
              {isEnriching && !displayLead.email && (!displayLead.emails || displayLead.emails.length === 0) && (
                <div className="flex items-center space-x-2 pt-2 border-t border-slate-100 dark:border-white/[0.05] text-xs text-[#7367F0] animate-pulse">
                  <Sparkles className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span className="text-[11px] font-medium">{t('leads.autoEnrichingNotice')}</span>
                </div>
              )}

              {displayLead.website && (
                <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-white/[0.05]">
                  <div className="flex items-center space-x-2 text-slate-600 dark:text-slate-300">
                    <Globe className="w-4 h-4 text-[#7367F0]" />
                    <span className="truncate max-w-[200px]">{displayLead.website}</span>
                  </div>
                  <a
                    href={displayLead.website.startsWith('http') ? displayLead.website : `https://${displayLead.website}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#7367F0] hover:underline font-bold text-[11px] flex items-center gap-1"
                  >
                    <span>{t('leads.colRatingWeb')}</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>

            {/* Web & Social Media Intelligence (Data Enrichment) */}
            <div className="p-4 rounded-xl border border-slate-200/80 dark:border-white/[0.06] space-y-3 bg-gradient-to-b from-transparent to-slate-50/50 dark:to-white/[0.01]">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center space-x-1.5">
                  <Sparkles className="w-4 h-4 text-[#7367F0]" />
                  <h5 className="text-[11px] font-extrabold uppercase text-slate-700 dark:text-slate-200 tracking-wider">
                    {t('leads.enrichmentTitle')}
                  </h5>
                </div>

                <div className="flex items-center gap-2">
                  {displayLead.enrichment_status === 'ENRICHED' && (
                    <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 text-[10px] font-bold">
                      <Check className="w-3 h-3 mr-1" />
                      {t('leads.enrichmentStatusEnriched')}
                    </Badge>
                  )}
                  {displayLead.enrichment_status === 'FAILED' && (
                    <Badge variant="outline" className="border-rose-500/40 text-rose-600 dark:text-rose-400 bg-rose-500/10 text-[10px] font-bold">
                      {t('leads.enrichmentStatusFailed')}
                    </Badge>
                  )}
                  {displayLead.enrichment_status === 'NO_WEBSITE' && (
                    <Badge variant="outline" className="border-slate-400/40 text-slate-500 dark:text-slate-400 bg-slate-500/10 text-[10px] font-bold">
                      {t('leads.enrichmentStatusNoWebsite')}
                    </Badge>
                  )}
                  {(!displayLead.enrichment_status || displayLead.enrichment_status === 'NOT_ENRICHED') && (
                    <Badge variant="outline" className="border-[#7367F0]/40 text-[#7367F0] dark:text-[#A59DF8] bg-[#7367F0]/10 text-[10px] font-bold">
                      {t('leads.enrichmentStatusNotEnriched')}
                    </Badge>
                  )}

                  {displayLead.website && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isEnriching}
                      onClick={handleEnrichLead}
                      className="h-7 px-2.5 text-[11px] font-bold space-x-1 border-[#7367F0]/30 text-[#7367F0] hover:bg-[#7367F0]/10 cursor-pointer"
                    >
                      <Sparkles className={`w-3 h-3 ${isEnriching ? 'animate-spin' : ''}`} />
                      <span>{isEnriching ? t('leads.enriching') : (displayLead.enrichment_status === 'ENRICHED' ? t('leads.retryEnrich') : t('leads.enrichBtn'))}</span>
                    </Button>
                  )}
                </div>
              </div>

              {isEnriching && (
                <div className="flex items-center gap-2 p-2.5 rounded-lg bg-[#7367F0]/10 border border-[#7367F0]/20 text-[#7367F0] dark:text-[#A59DF8] text-xs font-medium animate-pulse">
                  <Sparkles className="w-4 h-4 animate-spin shrink-0" />
                  <span>{t('leads.autoEnrichingNotice')}</span>
                </div>
              )}

              {/* Emails List */}
              {displayLead.emails && displayLead.emails.length > 0 ? (
                <div className="space-y-1.5 pt-1">
                  <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider block">
                    {t('leads.foundEmails')}
                  </span>
                  <div className="flex flex-col gap-1.5">
                    {displayLead.emails.map((em, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-white/[0.04] border border-slate-200/60 dark:border-white/[0.04]"
                      >
                        <div className="flex items-center space-x-2 text-slate-700 dark:text-slate-200 font-mono text-xs truncate">
                          <Mail className="w-3.5 h-3.5 text-[#7367F0] shrink-0" />
                          <span className="truncate">{em}</span>
                          {idx === 0 && (
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#7367F0]/15 text-[#7367F0] font-sans font-bold">
                              Primary
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => setIsSendEmailModalOpen(true)}
                            title={t('leads.sendDirectEmail') || 'E-posta Gönder'}
                            className="p-1 rounded text-slate-400 hover:text-[#7367F0] hover:bg-slate-200/60 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
                          >
                            <Send className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCopyEmail(em)}
                            title={t('leads.copyEmail')}
                            className="p-1 rounded text-slate-400 hover:text-[#7367F0] hover:bg-slate-200/60 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
                          >
                            {copiedEmail === em ? (
                              <Check className="w-3.5 h-3.5 text-[#28C76F]" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : displayLead.enrichment_status === 'ENRICHED' ? (
                <div className="text-[11px] text-slate-400 italic">
                  {t('leads.noEmailsFound')}
                </div>
              ) : null}

              {/* Social Media Profiles */}
              {displayLead.social_links && Object.keys(displayLead.social_links).length > 0 ? (
                <div className="space-y-1.5 pt-1">
                  <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider block">
                    {t('leads.foundSocials')}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(displayLead.social_links).map(([network, url]) => (
                      <a
                        key={network}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold transition-transform hover:scale-105 active:scale-95 bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] text-slate-800 dark:text-slate-200 border border-slate-200/80 dark:border-white/[0.08]"
                      >
                        <span className="capitalize font-mono text-[11px]">{network}</span>
                        <ExternalLink className="w-3 h-3 text-slate-400" />
                      </a>
                    ))}
                  </div>
                </div>
              ) : displayLead.enrichment_status === 'ENRICHED' ? (
                <div className="text-[11px] text-slate-400 italic">
                  {t('leads.noSocialsFound')}
                </div>
              ) : null}

              {/* Meta Summary */}
              {(displayLead.meta_title || displayLead.meta_description) && (
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/[0.04] space-y-1">
                  <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider block">
                    {t('leads.aboutSummary')}
                  </span>
                  {displayLead.meta_title && (
                    <div className="font-bold text-slate-800 dark:text-slate-100 text-[11px]">
                      {displayLead.meta_title}
                    </div>
                  )}
                  {displayLead.meta_description && (
                    <p className="text-slate-600 dark:text-slate-300 text-[11px] leading-relaxed line-clamp-3">
                      {displayLead.meta_description}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Location & Maps */}
            <div className="p-4 rounded-xl border border-slate-200/80 dark:border-white/[0.06] space-y-3">
              <div className="flex items-center justify-between">
                <h5 className="text-[11px] font-extrabold uppercase text-slate-400 dark:text-slate-500 tracking-wider">
                  {t('leads.colLocation')}
                </h5>
                <a
                  href={getGoogleMapsUrl()}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[#7367F0] hover:underline font-bold text-[11px] flex items-center gap-1"
                >
                  <GoogleMapsIcon className="w-3.5 h-3.5" />
                  <span>Google Maps</span>
                </a>
              </div>

              <div className="flex items-start space-x-2 text-slate-600 dark:text-slate-300">
                <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <span>{lead.address || `${lead.district ? `${lead.district}, ` : ''}${lead.city || ''}`}</span>
              </div>

              {(lead.district || lead.city) && (
                <div className="flex items-center gap-2 text-[11px] text-slate-500">
                  {lead.city && <Badge variant="secondary">{lead.city}</Badge>}
                  {lead.district && <Badge variant="secondary">{lead.district}</Badge>}
                </div>
              )}
            </div>

            {/* Rating & Reviews */}
            {lead.rating && (
              <div className="p-4 rounded-xl border border-slate-200/80 dark:border-white/[0.06] flex items-center justify-between">
                <span className="text-slate-400 font-bold uppercase text-[10px] tracking-wider">
                  {t('leadFinder.cardRating')}
                </span>
                <div className="flex items-center space-x-1.5">
                  <Star className="w-4 h-4 text-[#FF9F43] fill-[#FF9F43]" />
                  <span className="font-bold text-slate-800 dark:text-white text-sm">{lead.rating}</span>
                  {lead.reviews_count ? (
                    <span className="text-slate-400 text-xs">({lead.reviews_count} {t('leads.colRatingWeb')})</span>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 bg-white dark:bg-[#181C28]">
            {/* Live Chat Thread */}
            <ChatThread
              conversationKey={lead.id}
              messages={messages}
              loading={chatLoading}
              hasMore={hasMore}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlderMessages}
              leadName={lead.name}
              leadPhone={lead.phone_e164 || lead.phone}
              onRetry={async (msgId) => {
                try {
                  await retryMessage(msgId);
                  toast.success(t('whatsapp.messageSent'), t('common.success'));
                } catch (err: any) {
                  toast.error(translateApiError(err, t) || t('whatsapp.msgFailed'), t('common.error'));
                }
              }}
            />

            {/* Live Composer */}
            <ChatComposer
              conversationId={conversation?.id}
              insertedText={insertedComposerText}
              onSend={async (text) => {
                try {
                  await sendMessage(text);
                  toast.success(t('whatsapp.messageSent'), t('common.success'));
                } catch (err: any) {
                  const msg = (err?.message || '').toLowerCase();
                  if (msg.includes('24 saat') || msg.includes('window')) {
                    toast.error(t('whatsapp.windowExpiredNotice'), t('common.error'));
                  } else {
                    toast.error(t('whatsapp.msgFailed'), t('common.error'));
                  }
                }
              }}
              onSendTemplate={() => setIsTemplateModalOpen(true)}
              onSendMedia={async (mediaType, mediaUrl, caption, filename) => {
                try {
                  await sendMedia(mediaType, mediaUrl, caption, filename);
                  toast.success(t('whatsapp.mediaSent'), t('common.success'));
                } catch (err: any) {
                  toast.error(t('whatsapp.mediaFailed'), t('common.error'));
                }
              }}
              onReopenConversation={async () => {
                try {
                  await updateStatus('ACTIVE');
                  toast.success(t('whatsapp.statusUpdated') || 'Diyalog yeniden açıldı', t('common.success'));
                } catch (err: any) {
                  toast.error(t('common.error'), t('common.error'));
                }
              }}
              isClosed={conversation?.status === 'CLOSED'}
              isWindowOpen={conversation?.is_window_open ?? true}
            />

            {/* Template Select Modal */}
            <TemplateSelectModal
              isOpen={isTemplateModalOpen}
              onClose={() => setIsTemplateModalOpen(false)}
              leadName={lead.name}
              onSelectTemplate={(renderedText) => {
                setInsertedComposerText({ text: renderedText, timestamp: Date.now() });
                setIsTemplateModalOpen(false);
              }}
              onSendTemplate={async (templateKey, variables) => {
                try {
                  await sendTemplate(templateKey, variables);
                  toast.success(t('whatsapp.templateSent') || 'Şablon başarıyla gönderildi', t('common.success'));
                } catch (err: any) {
                  toast.error(translateApiError(err, t) || t('whatsapp.templateFailed'), t('common.error'));
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Direct SMTP Outreach Modal */}
      <SendEmailModal
        lead={displayLead}
        isOpen={isSendEmailModalOpen}
        onClose={() => setIsSendEmailModalOpen(false)}
        onSuccess={() => {
          setIsSendEmailModalOpen(false);
          if (displayLead) {
            const updated = { ...displayLead, status: 'CONTACTED' as LeadStatus };
            setCurrentLead(updated);
            onLeadUpdated?.(updated);
          }
        }}
      />
    </Drawer>
  );
};
