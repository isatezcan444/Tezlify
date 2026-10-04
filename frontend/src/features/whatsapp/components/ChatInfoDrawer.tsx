import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  Building2,
  Copy,
  Check,
  Search,
  Image as ImageIcon,
  FileText,
  Link2,
  Star,
  Bell,
  BellOff,
  Lock,
  ChevronRight,
  ExternalLink,
  Play,
  Archive,
  RotateCcw,
  CheckCircle2,
  UserX,
  Users,
  ArrowLeft,
  Plus,
} from 'lucide-react';
import { Conversation, Message } from '../../../types';
import { ApiClient } from '../../../api/client';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { Avatar } from '../../../components/ui/Avatar';
import { resolveMediaUrl } from '../../../lib/mediaUrl';
import { formatPhoneNumber } from '../lib/whatsappIdentity';
import { formatMessageTime } from '../../../lib/utils';
import {
  getStarredMessagesForConversation,
  getStarredCountForConversation,
  subscribeStarredChanges,
  toggleMessageStar,
} from '../lib/starredMessages';
import { MediaLightbox } from './MediaLightbox';
import { DocumentViewer, resolveDocVisual } from './DocumentViewer';

export interface ChatInfoDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  conversation: Conversation;
  messages: Message[];
  onOpenLead?: (leadId: number) => void;
  onSearchInChat?: () => void;
  onStatusChange?: (convId: number, status: 'ACTIVE' | 'ARCHIVED' | 'CLOSED') => void;
  onJumpToMessage?: (messageId: string | number) => void;
}

type GalleryTab = 'MEDIA' | 'DOCS' | 'LINKS';

interface ExtractedLink {
  url: string;
  domain: string;
  messageId: string | number;
  timestamp: string;
}

export const ChatInfoDrawer: React.FC<ChatInfoDrawerProps> = ({
  isOpen,
  onClose,
  conversation,
  messages,
  onOpenLead,
  onSearchInChat,
  onStatusChange,
  onJumpToMessage,
}) => {
  const { t, language } = useI18n();
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<GalleryTab>('MEDIA');
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isStarredViewOpen, setIsStarredViewOpen] = useState(false);
  const [starredCount, setStarredCount] = useState<number>(() =>
    getStarredCountForConversation(conversation.id, messages)
  );
  const [starredMessages, setStarredMessages] = useState<Message[]>(() =>
    getStarredMessagesForConversation(conversation.id, messages)
  );

  useEffect(() => {
    const updateStarred = () => {
      setStarredCount(getStarredCountForConversation(conversation.id, messages));
      setStarredMessages(getStarredMessagesForConversation(conversation.id, messages));
    };
    updateStarred();
    return subscribeStarredChanges(updateStarred);
  }, [conversation.id, messages]);

  // Lightbox & DocumentViewer modal states
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxType, setLightboxType] = useState<'IMAGE' | 'VIDEO'>('IMAGE');
  const [lightboxCaption, setLightboxCaption] = useState<string | null>(null);
  const [lightboxFilename, setLightboxFilename] = useState<string | null>(null);

  const [docViewerSrc, setDocViewerSrc] = useState<string | null>(null);
  const [docViewerFilename, setDocViewerFilename] = useState<string | null>(null);
  const [docViewerMime, setDocViewerMime] = useState<string | null>(null);
  const [isAddingLead, setIsAddingLead] = useState(false);

  const handleAddToCrm = async () => {
    if (!cleanPhone || isAddingLead) return;
    setIsAddingLead(true);
    try {
      const created = await ApiClient.createLead({
        name: displayName || cleanPhone,
        phone: cleanPhone,
        phone_e164: cleanPhone,
        is_whatsapp_eligible: true,
        status: 'NEW' as any,
      });
      toast.success(t('whatsapp.addedToCrmSuccess'));
      if (onOpenLead && created?.id) {
        onOpenLead(created.id);
      }
    } catch (err: any) {
      toast.error(err.message || 'CRM adayı eklenemedi');
    } finally {
      setIsAddingLead(false);
    }
  };

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Only close drawer if internal modals are not open
        if (!lightboxSrc && !docViewerSrc) {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, lightboxSrc, docViewerSrc]);

  // Extract media items from messages
  const mediaItems = useMemo(() => {
    return messages.filter((m) => {
      const type = (m.message_type || '').toUpperCase();
      const mime = (m.media_mime_type || '').toLowerCase();
      return (
        type === 'IMAGE' ||
        type === 'VIDEO' ||
        mime.startsWith('image/') ||
        mime.startsWith('video/')
      );
    });
  }, [messages]);

  // Extract documents from messages
  const documentItems = useMemo(() => {
    return messages.filter((m) => {
      const type = (m.message_type || '').toUpperCase();
      const mime = (m.media_mime_type || '').toLowerCase();
      return (
        type === 'DOCUMENT' ||
        (m.media_filename && !mime.startsWith('image/') && !mime.startsWith('video/') && !mime.startsWith('audio/'))
      );
    });
  }, [messages]);

  // Extract links from messages
  const linkItems = useMemo(() => {
    const list: ExtractedLink[] = [];
    const urlRegex = /(https?:\/\/[^\s]+)/gi;

    for (const m of messages) {
      if (!m.body) continue;
      const matches = m.body.match(urlRegex);
      if (matches) {
        for (const rawUrl of matches) {
          try {
            // Strip trailing punctuation often typed at the end of URLs
            const cleanUrl = rawUrl.replace(/[.,!?;:)]+$/, '');
            const parsed = new URL(cleanUrl);
            list.push({
              url: cleanUrl,
              domain: parsed.hostname,
              messageId: m.id,
              timestamp: m.created_at,
            });
          } catch {}
        }
      }
    }
    return list;
  }, [messages]);

  if (!isOpen) return null;

  const isGroup = Boolean(conversation.is_group);
  const cleanPhone = conversation.lead_phone || '';
  const displayName = conversation.lead_name || formatPhoneNumber(cleanPhone) || (isGroup ? t('whatsapp.group') : t('whatsapp.contactInfo'));

  const handleCopyPhone = () => {
    if (!cleanPhone) return;
    navigator.clipboard.writeText(cleanPhone);
    setCopiedPhone(true);
    toast.success(t('whatsapp.phoneCopied'), t('common.success'));
    setTimeout(() => setCopiedPhone(false), 2000);
  };

  const handleCopyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedLink(url);
    toast.success(t('whatsapp.linkCopied'), t('common.success'));
    setTimeout(() => setCopiedLink(null), 2000);
  };

  return (
    <aside
      role="region"
      aria-label={isGroup ? t('whatsapp.groupInfo') : t('whatsapp.contactInfo')}
      data-testid="chat-info-drawer"
      className="w-80 md:w-96 shrink-0 border-l border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-[#111b21] flex flex-col h-full z-20 animate-in slide-in-from-right duration-200 ease-out select-text"
    >
      {/* 1. Header Bar */}
      <header className="h-[60px] px-4 border-b border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#202c33] flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-3">
          {isStarredViewOpen ? (
            <button
              type="button"
              onClick={() => setIsStarredViewOpen(false)}
              data-testid="back-info-drawer-btn"
              aria-label={t('common.back')}
              title={t('common.back')}
              className="p-1.5 rounded-full text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              data-testid="close-info-drawer-btn"
              aria-label={t('common.close')}
              className="p-1.5 rounded-full text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
          <h3 className="font-bold text-sm text-slate-800 dark:text-slate-100">
            {isStarredViewOpen
              ? t('whatsapp.starredMessages')
              : isGroup
              ? t('whatsapp.groupInfo')
              : t('whatsapp.contactInfo')}
          </h3>
        </div>
      </header>

      {/* 2. Body View */}
      {isStarredViewOpen ? (
        /* Starred Messages Sub-view */
        <div
          className="flex-1 overflow-y-auto overflow-x-hidden space-y-2.5 p-3 custom-scrollbar"
          data-testid="drawer-starred-list"
        >
          {starredMessages.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center text-center space-y-3 px-4">
              <div className="w-14 h-14 rounded-full bg-amber-500/15 dark:bg-amber-500/20 flex items-center justify-center text-amber-500">
                <Star className="w-7 h-7 fill-amber-500" />
              </div>
              <div className="space-y-1">
                <h4 className="font-bold text-sm text-slate-800 dark:text-slate-100">
                  {t('whatsapp.starredMessagesEmpty')}
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-[260px] leading-relaxed">
                  {t('whatsapp.starredMessagesEmptyDesc')}
                </p>
              </div>
            </div>
          ) : (
            starredMessages.map((msg) => {
              const isOutbound = msg.direction === 'OUTBOUND';
              const sender = isOutbound
                ? language === 'tr'
                  ? 'Siz'
                  : 'You'
                : displayName || cleanPhone;
              return (
                <div
                  key={msg.id}
                  onClick={() => onJumpToMessage?.(msg.id)}
                  data-testid={`starred-card-${msg.id}`}
                  className="p-3.5 rounded-2xl bg-white dark:bg-[#202c33] border border-slate-200/80 dark:border-white/[0.06] shadow-sm hover:border-[#7367F0]/40 transition-all cursor-pointer group/star"
                >
                  <div className="flex items-center justify-between text-[11px] mb-2">
                    <span className="font-bold text-slate-700 dark:text-slate-200 truncate max-w-[160px]">
                      {sender}
                    </span>
                    <div className="flex items-center space-x-2 text-slate-400">
                      <span>{formatMessageTime(msg.created_at || msg.external_timestamp, language)}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMessageStar(msg.id, conversation.id);
                        }}
                        title={t('whatsapp.unstarMessage')}
                        aria-label={t('whatsapp.unstarMessage')}
                        data-testid={`unstar-btn-${msg.id}`}
                        className="p-1 rounded-full text-amber-500 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                      >
                        <Star className="w-3.5 h-3.5 fill-amber-500 group-hover/star:fill-transparent" />
                      </button>
                    </div>
                  </div>
                  {msg.body && (
                    <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-3 select-text leading-relaxed">
                      {msg.body}
                    </p>
                  )}
                  {msg.media_filename && (
                    <div className="flex items-center space-x-1.5 mt-1.5 text-[11px] font-semibold text-[#7367F0]">
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{msg.media_filename}</span>
                    </div>
                  )}
                  {onJumpToMessage && (
                    <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-white/[0.04] flex items-center justify-end text-[10px] font-bold text-[#7367F0] opacity-80 group-hover/star:opacity-100">
                      <span>{t('whatsapp.jumpToMessage')} &rarr;</span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      ) : (
        /* Main Drawer Body */
        <div className="flex-1 overflow-y-auto overflow-x-hidden space-y-2.5 p-3 custom-scrollbar">
        {/* Profile Card */}
        <div className="bg-white dark:bg-[#202c33] p-5 rounded-2xl shadow-sm border border-slate-200/80 dark:border-white/[0.06] flex flex-col items-center text-center">
          <div
            className="relative group/avatar cursor-pointer"
            onClick={() => {
              if (conversation.lead_avatar_url) {
                setLightboxSrc(conversation.lead_avatar_url);
                setLightboxType('IMAGE');
                setLightboxCaption(displayName);
              }
            }}
          >
            <Avatar
              name={displayName}
              image={conversation.lead_avatar_url}
              phone={cleanPhone}
              size="xl"
              shape="rounded"
              className="w-28 h-28 md:w-32 md:h-32 text-2xl font-bold shadow-md ring-4 ring-slate-100 dark:ring-white/[0.06]"
            />
            {conversation.lead_avatar_url && (
              <div className="absolute inset-0 rounded-2xl bg-black/40 opacity-0 group-hover/avatar:opacity-100 flex items-center justify-center transition-opacity text-white text-xs font-bold gap-1">
                <Search className="w-4 h-4" />
              </div>
            )}
          </div>

          <h4 className="mt-3.5 font-extrabold text-base text-slate-800 dark:text-slate-100 break-words max-w-full">
            {displayName}
          </h4>

          {isGroup ? (
            <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
              <Users className="w-3.5 h-3.5 text-[#7367F0]" />
              <span>{t('whatsapp.group')}</span>
            </div>
          ) : cleanPhone ? (
            <p className="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400 font-medium">
              {formatPhoneNumber(cleanPhone)}
            </p>
          ) : null}

          {/* CRM Profile Shortcut (if linked to a Lead) or Add to CRM */}
          {conversation.lead_id && onOpenLead ? (
            <button
              type="button"
              onClick={() => onOpenLead(conversation.lead_id!)}
              data-testid="drawer-open-lead-btn"
              className="mt-3.5 inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-[#7367F0]/10 hover:bg-[#7367F0]/20 text-[#7367F0] font-bold text-xs transition-colors cursor-pointer border border-[#7367F0]/20"
            >
              <Building2 className="w-3.5 h-3.5" />
              <span>{t('whatsapp.viewCrmLead')}</span>
            </button>
          ) : !isGroup && cleanPhone ? (
            <button
              type="button"
              onClick={handleAddToCrm}
              disabled={isAddingLead}
              className="mt-3.5 inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-bold text-xs transition-colors cursor-pointer border border-emerald-500/20"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{isAddingLead ? t('common.loading') : t('whatsapp.addToCrm')}</span>
            </button>
          ) : null}

          {/* Action Row */}
          <div className="mt-4 flex items-center justify-center gap-3 w-full pt-3 border-t border-slate-100 dark:border-white/[0.06]">
            {onSearchInChat && (
              <button
                type="button"
                onClick={onSearchInChat}
                className="flex-1 flex flex-col items-center py-2 px-1 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors cursor-pointer text-[11px] font-bold gap-1"
              >
                <Search className="w-4 h-4 text-[#7367F0]" />
                <span>{t('whatsapp.searchInChat')}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsMuted((v) => !v)}
              className="flex-1 flex flex-col items-center py-2 px-1 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors cursor-pointer text-[11px] font-bold gap-1"
            >
              {isMuted ? (
                <BellOff className="w-4 h-4 text-rose-500" />
              ) : (
                <Bell className="w-4 h-4 text-[#25D366]" />
              )}
              <span>{t('whatsapp.muteNotifications')}</span>
            </button>
          </div>
        </div>

        {/* About & Phone Number Section */}
        <div className="bg-white dark:bg-[#202c33] p-4 rounded-2xl shadow-sm border border-slate-200/80 dark:border-white/[0.06] space-y-3">
          <h5 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-400">
            {isGroup ? t('whatsapp.groupDescription') : t('whatsapp.aboutAndPhone')}
          </h5>

          {cleanPhone && (
            <div className="flex items-center justify-between text-xs py-1">
              <div>
                <span className="text-[11px] text-slate-400 block">{t('common.phone')}</span>
                <span className="font-mono font-bold text-slate-800 dark:text-slate-200">
                  {formatPhoneNumber(cleanPhone)}
                </span>
              </div>
              <button
                type="button"
                onClick={handleCopyPhone}
                title={t('common.copy')}
                aria-label={t('common.copy')}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
              >
                {copiedPhone ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}

          <div className="text-xs text-slate-600 dark:text-slate-300 italic pt-1">
            "{isGroup ? t('whatsapp.noDescription') : 'Hey there! I am using WhatsApp.'}"
          </div>
        </div>

        {/* Media, Links and Docs Section */}
        <div className="bg-white dark:bg-[#202c33] rounded-2xl shadow-sm border border-slate-200/80 dark:border-white/[0.06] overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between">
            <span className="text-xs font-extrabold text-slate-800 dark:text-slate-200">
              {t('whatsapp.mediaLinksDocs')}
            </span>
            <span className="text-[11px] font-bold text-slate-400">
              {mediaItems.length + documentItems.length + linkItems.length}
            </span>
          </div>

          {/* Gallery Tab Bar */}
          <div className="flex border-b border-slate-100 dark:border-white/[0.06] bg-slate-50/50 dark:bg-black/10">
            <button
              type="button"
              data-testid="drawer-tab-media"
              onClick={() => setActiveTab('MEDIA')}
              className={`flex-1 py-2 text-xs font-bold text-center border-b-2 transition-colors cursor-pointer ${
                activeTab === 'MEDIA'
                  ? 'border-[#25D366] text-[#25D366]'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {t('whatsapp.mediaTab')} ({mediaItems.length})
            </button>
            <button
              type="button"
              data-testid="drawer-tab-docs"
              onClick={() => setActiveTab('DOCS')}
              className={`flex-1 py-2 text-xs font-bold text-center border-b-2 transition-colors cursor-pointer ${
                activeTab === 'DOCS'
                  ? 'border-[#25D366] text-[#25D366]'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {t('whatsapp.docsTab')} ({documentItems.length})
            </button>
            <button
              type="button"
              data-testid="drawer-tab-links"
              onClick={() => setActiveTab('LINKS')}
              className={`flex-1 py-2 text-xs font-bold text-center border-b-2 transition-colors cursor-pointer ${
                activeTab === 'LINKS'
                  ? 'border-[#25D366] text-[#25D366]'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {t('whatsapp.linksTab')} ({linkItems.length})
            </button>
          </div>

          {/* Tab Content */}
          <div className="p-3">
            {activeTab === 'MEDIA' && (
              mediaItems.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400 space-y-1">
                  <ImageIcon className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
                  <p>{t('whatsapp.noMediaInChat')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-1.5" data-testid="drawer-media-grid">
                  {mediaItems.map((m) => {
                    const rawSrc = m.media_id ? resolveMediaUrl(m.media_id) : `/api/v1/whatsapp/media/${m.wa_message_id}`;
                    const isVideo = (m.message_type || '').toUpperCase() === 'VIDEO' || (m.media_mime_type || '').includes('video');
                    return (
                      <div
                        key={m.id}
                        onClick={() => {
                          setLightboxSrc(rawSrc);
                          setLightboxType(isVideo ? 'VIDEO' : 'IMAGE');
                          setLightboxCaption(m.media_caption || undefined);
                          setLightboxFilename(m.media_filename || undefined);
                        }}
                        className="relative aspect-square rounded-lg overflow-hidden bg-slate-100 dark:bg-black/30 border border-slate-200/60 dark:border-white/10 group cursor-pointer"
                      >
                        {isVideo ? (
                          <div className="w-full h-full flex items-center justify-center bg-slate-900 text-white">
                            <Play className="w-5 h-5 fill-white" />
                          </div>
                        ) : (
                          <img
                            src={rawSrc}
                            alt={m.media_filename || 'media'}
                            loading="lazy"
                            className="w-full h-full object-cover transition-transform group-hover:scale-105"
                          />
                        )}
                        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white">
                          <Search className="w-4 h-4" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}

            {activeTab === 'DOCS' && (
              documentItems.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400 space-y-1">
                  <FileText className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
                  <p>{t('whatsapp.noDocsInChat')}</p>
                </div>
              ) : (
                <div className="space-y-1.5" data-testid="drawer-docs-list">
                  {documentItems.map((m) => {
                    const { Icon, tone } = resolveDocVisual(m.media_filename, m.media_mime_type);
                    const rawSrc = m.media_id ? resolveMediaUrl(m.media_id) : `/api/v1/whatsapp/media/${m.wa_message_id}`;
                    return (
                      <div
                        key={m.id}
                        onClick={() => {
                          setDocViewerSrc(rawSrc);
                          setDocViewerFilename(m.media_filename || t('leads.documentFallbackName'));
                          setDocViewerMime(m.media_mime_type || 'application/octet-stream');
                        }}
                        className="flex items-center space-x-2.5 p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer border border-transparent hover:border-slate-200 dark:hover:border-white/10"
                      >
                        <div className={`p-2 rounded-lg border ${tone} shrink-0`}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate">
                            {m.media_filename || t('leads.documentFallbackName')}
                          </p>
                          <span className="text-[10px] font-mono text-slate-400 uppercase">
                            {m.media_mime_type?.split('/')[1] || 'DOC'}
                          </span>
                        </div>
                        <ExternalLink className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      </div>
                    );
                  })}
                </div>
              )
            )}

            {activeTab === 'LINKS' && (
              linkItems.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400 space-y-1">
                  <Link2 className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
                  <p>{t('whatsapp.noLinksInChat')}</p>
                </div>
              ) : (
                <div className="space-y-1.5" data-testid="drawer-links-list">
                  {linkItems.map((link, idx) => (
                    <div
                      key={`${link.messageId}-${idx}`}
                      className="flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors border border-transparent hover:border-slate-200 dark:hover:border-white/10 group"
                    >
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 flex-1 mr-2"
                      >
                        <p className="text-xs font-bold text-[#7367F0] truncate group-hover:underline">
                          {link.domain}
                        </p>
                        <p className="text-[11px] text-slate-400 truncate">
                          {link.url}
                        </p>
                      </a>
                      <button
                        type="button"
                        onClick={() => handleCopyLink(link.url)}
                        title={t('common.copy')}
                        className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-white/10 transition-colors"
                      >
                        {copiedLink === link.url ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </div>

        {/* Starred Messages Section */}
        <div
          onClick={() => setIsStarredViewOpen(true)}
          data-testid="drawer-starred-section"
          className="bg-white dark:bg-[#202c33] p-3.5 rounded-2xl shadow-sm border border-slate-200/80 dark:border-white/[0.06] flex items-center justify-between hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors cursor-pointer"
        >
          <div className="flex items-center space-x-3 text-xs font-bold text-slate-700 dark:text-slate-200">
            <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
            <span>{t('whatsapp.starredMessages')}</span>
          </div>
          <div className="flex items-center space-x-1.5 text-slate-400">
            <span
              className="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/[0.08] text-slate-600 dark:text-slate-300"
              data-testid="drawer-starred-count"
            >
              {starredCount}
            </span>
            <ChevronRight className="w-4 h-4" />
          </div>
        </div>

        {/* Encryption & Security Section */}
        <div className="bg-white dark:bg-[#202c33] p-4 rounded-2xl shadow-sm border border-slate-200/80 dark:border-white/[0.06] flex items-start space-x-3">
          <Lock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
          <div className="text-xs space-y-1">
            <span className="font-bold text-slate-800 dark:text-slate-200 block">
              {t('whatsapp.encryptionNoticeTitle')}
            </span>
            <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              {t('whatsapp.encryptionNoticeDesc')}
            </p>
          </div>
        </div>

        {/* Status Actions (Archive / Close / Reopen) */}
        {onStatusChange && (
          <div className="bg-white dark:bg-[#202c33] p-2 rounded-2xl shadow-sm border border-slate-200/80 dark:border-white/[0.06] space-y-1">
            {conversation.status === 'ACTIVE' ? (
              <>
                <button
                  type="button"
                  onClick={() => onStatusChange(conversation.id, 'ARCHIVED')}
                  className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
                >
                  <Archive className="w-4 h-4 text-slate-500" />
                  <span>{t('whatsapp.archive')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onStatusChange(conversation.id, 'CLOSED')}
                  className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4 text-slate-500" />
                  <span>{t('whatsapp.close')}</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => onStatusChange(conversation.id, 'ACTIVE')}
                className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-[#7367F0] hover:bg-[#7367F0]/10 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-4 h-4 text-[#7367F0]" />
                <span>{t('whatsapp.reopen')}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                toast.info(t('whatsapp.blockContact'), t('common.info'));
              }}
              className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
            >
              <UserX className="w-4 h-4" />
              <span>{isGroup ? t('whatsapp.exitGroup') : t('whatsapp.blockContact')}</span>
            </button>
          </div>
        )}
      </div>
      )}

      {/* Lightbox for Avatars & Gallery Media */}
      <MediaLightbox
        isOpen={Boolean(lightboxSrc)}
        onClose={() => setLightboxSrc(null)}
        src={lightboxSrc}
        mediaType={lightboxType}
        caption={lightboxCaption || undefined}
        filename={lightboxFilename || undefined}
        senderName={displayName}
      />

      {/* DocumentViewer for Gallery Documents */}
      <DocumentViewer
        isOpen={Boolean(docViewerSrc)}
        onClose={() => setDocViewerSrc(null)}
        src={docViewerSrc}
        filename={docViewerFilename || undefined}
        mimeType={docViewerMime || undefined}
        senderName={displayName}
      />
    </aside>
  );
};
