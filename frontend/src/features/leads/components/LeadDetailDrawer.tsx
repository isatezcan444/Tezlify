import React, { useState, useEffect } from 'react';
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
  MessageSquare
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
import { useWhatsAppConversation } from '../../whatsapp/hooks/useWhatsAppConversation';
import { useI18n } from '../../../context/I18nContext';
import { translateApiError } from '../../whatsapp/lib/translateError';
import { useToast } from '../../../context/ToastContext';

export interface LeadDetailDrawerProps {
  lead: Lead | null;
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'overview' | 'chat';
  onSendMessage?: (lead: Lead) => void;
  onBlacklist?: (lead: Lead) => void;
  onDelete?: (lead: Lead) => void;
  onStatusChange?: (leadId: number, status: LeadStatus) => void;
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
}) => {
  const { t } = useI18n();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<'overview' | 'chat'>(initialTab);

  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState<boolean>(false);

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
    leadId: lead?.id,
    enabled: isOpen && activeTab === 'chat',
  });

  if (!lead) return null;

  const getGoogleMapsUrl = () => {
    if ((lead as any).maps_url) return (lead as any).maps_url;
    if ((lead as any).google_maps_url) return (lead as any).google_maps_url;
    if (lead.custom_data?.google_maps_url) return lead.custom_data.google_maps_url;
    if (lead.custom_data?.maps_url) return lead.custom_data.maps_url;
    const query = [lead.name, lead.address || [lead.district, lead.city].filter(Boolean).join(', ')].filter(Boolean).join(' ');
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  };

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title={lead.name}
      subtitle={lead.category || t('common.general')}
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
                  onBlacklist(lead);
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
                  onDelete(lead);
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
              {lead.status === 'REPLIED' && (
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
              <Avatar name={lead.name} size="lg" shape="rounded" />
              <div className="min-w-0 flex-1">
                <h4 className="font-extrabold text-sm text-slate-800 dark:text-white truncate">
                  {lead.name}
                </h4>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25 dark:text-[#A59DF8]">
                    {lead.category || t('common.general')}
                  </span>
                  {lead.entity_type && (
                    <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-200 dark:bg-white/[0.08] text-slate-600 dark:text-slate-300">
                      {lead.entity_type}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Status Dropdown Picker */}
            <div className="p-4 rounded-xl border border-slate-200/80 dark:border-white/[0.06] space-y-2">
              <label className="text-slate-400 font-bold block uppercase tracking-wider text-[10px]">
                {t('leads.colStatus')}
              </label>
              <select
                value={lead.status}
                onChange={(e) => onStatusChange && onStatusChange(lead.id, e.target.value as LeadStatus)}
                className="w-full p-2.5 rounded-lg vuexy-input text-xs font-bold cursor-pointer"
              >
                <option value="NEW">{t('leads.statusNew')}</option>
                <option value="CONTACTED">{t('leads.statusContacted')}</option>
                <option value="REPLIED">{t('leads.statusReplied')}</option>
                <option value="INTERESTED">{t('leads.statusInterested')}</option>
                <option value="UNSUBSCRIBED">{t('leads.statusUnsubscribed')}</option>
                <option value="INVALID_NUMBER">{t('leads.statusInvalid')}</option>
              </select>
            </div>

            {/* Contact Information */}
            <div className="p-4 rounded-xl border border-slate-200/80 dark:border-white/[0.06] space-y-3">
              <h5 className="text-[11px] font-extrabold uppercase text-slate-400 dark:text-slate-500 tracking-wider">
                {t('leads.colContact')}
              </h5>

              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 font-mono font-bold text-slate-700 dark:text-slate-200">
                  <Phone className="w-4 h-4 text-slate-400" />
                  <span>{lead.phone_e164 || lead.phone || t('leads.noPhone')}</span>
                </div>

                {lead.is_whatsapp_eligible ? (
                  <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-[#25D366]/15 text-[#25D366] font-bold text-[10px]">
                    <WhatsAppIcon className="w-3 h-3" />
                    <span>{t('leads.whatsappActive')}</span>
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-400">
                    {t('leads.whatsappUnverified')}
                  </span>
                )}
              </div>

              {lead.website && (
                <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-white/[0.05]">
                  <div className="flex items-center space-x-2 text-slate-600 dark:text-slate-300">
                    <Globe className="w-4 h-4 text-[#7367F0]" />
                    <span className="truncate max-w-[200px]">{lead.website}</span>
                  </div>
                  <a
                    href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
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
                  Google Rating
                </span>
                <div className="flex items-center space-x-1.5">
                  <Star className="w-4 h-4 text-[#FF9F43] fill-[#FF9F43]" />
                  <span className="font-bold text-slate-800 dark:text-white text-sm">{lead.rating}</span>
                  {lead.reviews_count && (
                    <span className="text-slate-400 text-xs">({lead.reviews_count} reviews)</span>
                  )}
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
                  toast.success(t('whatsapp.messageSent') || 'Mesaj tekrar gönderildi', t('common.success'));
                } catch (err: any) {
                  toast.error(translateApiError(err, t) || t('whatsapp.msgFailed'), t('common.error'));
                }
              }}
            />

            {/* Live Composer */}
            <ChatComposer
              onSend={async (text) => {
                try {
                  await sendMessage(text);
                  toast.success(t('whatsapp.messageSent') || 'Mesaj başarıyla gönderildi', t('common.success'));
                } catch (err: any) {
                  const msg = (err?.message || '').toLowerCase();
                  if (msg.includes('24 saat') || msg.includes('window')) {
                    toast.error(t('whatsapp.windowExpiredNotice') || 'Bu konuşmaya devam etmek için bir şablon kullanın.', t('common.error'));
                  } else {
                    toast.error(t('whatsapp.msgFailed') || 'Mesaj gönderilemedi', t('common.error'));
                  }
                }
              }}
              onSendTemplate={() => setIsTemplateModalOpen(true)}
              onSendMedia={async (mediaType, mediaUrl, caption, filename) => {
                try {
                  await sendMedia(mediaType, mediaUrl, caption, filename);
                  toast.success(t('whatsapp.mediaSent') || 'Medya başarıyla gönderildi', t('common.success'));
                } catch (err: any) {
                  toast.error(t('whatsapp.mediaFailed') || 'Medya gönderilemedi', t('common.error'));
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
    </Drawer>
  );
};
