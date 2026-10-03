import React, { useState, useLayoutEffect, useCallback } from 'react';
import {
  Check,
  CheckCheck,
  AlertCircle,
  Image as ImageIcon,
  Music,
  Video,
  MapPin,
  Eye,
  RotateCcw,
  Loader2,
  Clock,
  SmilePlus,
  Plus,
  Reply,
  Copy
} from 'lucide-react';
import { Conversation, Message } from '../../../types';
import { Tooltip } from '../../../components/ui/Tooltip';
import { Modal } from '../../../components/ui/Modal';
import { useI18n } from '../../../context/I18nContext';
import { formatMessageTime } from '../../../lib/utils';
import { finishWaLatency } from '../lib/whatsappLatency';
import { getConversationDisplayName } from '../lib/whatsappIdentity';
import { EmojiPicker } from './EmojiPicker';
import { DocumentCard } from './DocumentCard';
import { LinkPreviewCard } from './LinkPreviewCard';
import { VoiceNotePlayer } from './VoiceNotePlayer';
import { MediaLightbox } from './MediaLightbox';
import { groupReactions } from '../lib/whatsappReactions';
import { resolveMediaUrl } from '../../../lib/mediaUrl';

/** WhatsApp Web'in tepki cubugunda gosterdigi altı hizli ifade. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export interface ChatBubbleProps {
  message: Message;
  /** Faz 6a: grup sohbetlerinde balon ustunde gonderen adi gosterilir. */
  isGroup?: boolean;
  /** Sohbet basligi — gonderen adi sohbet adiyla aynissa tekrar edilmez. */
  chatTitle?: string;
  onRetry?: (messageId: number | string) => Promise<void> | void;
  /** Mesaja ifade birakir/degistirir; bos `emoji` geri ceker. */
  onReact?: (messageId: number | string, emoji: string) => Promise<void> | void;
  onReply?: (message: Message) => void;
  searchQuery?: string;
  isSearchActiveMatch?: boolean;
}

const ChatBubbleComponent: React.FC<ChatBubbleProps> = ({
  message,
  isGroup = false,
  chatTitle,
  onRetry,
  onReact,
  onReply,
  searchQuery,
  isSearchActiveMatch,
}) => {
  const { t, language } = useI18n();
  const isInbound = message.direction === 'INBOUND';
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxMediaType, setLightboxMediaType] = useState<'IMAGE' | 'VIDEO' | 'DOCUMENT'>('IMAGE');
  const [retrying, setRetrying] = useState(false);
  const [isReactionBarOpen, setIsReactionBarOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [reacting, setReacting] = useState(false);
  const [imageLoadError, setImageLoadError] = useState(false);
  const [mediaRetryTs, setMediaRetryTs] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const highlightMatches = useCallback(
    (text: string): React.ReactNode => {
      if (!searchQuery || !searchQuery.trim() || !text) return text;
      const escaped = searchQuery.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escaped})`, 'gi');
      const tokens = text.split(regex);
      if (tokens.length === 1) return text;
      return tokens.map((token, i) =>
        regex.test(token) ? (
          <mark
            key={i}
            className="bg-yellow-300 dark:bg-yellow-500/50 text-slate-900 dark:text-white rounded-xs px-0.5"
          >
            {token}
          </mark>
        ) : (
          token
        )
      );
    },
    [searchQuery]
  );

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy = message.body || message.media_caption || '';
    if (!textToCopy) return;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const resolvedMediaUrl = React.useMemo(() => {
    const raw =
      message.media_url ||
      (message.media_id
        ? `/api/v1/whatsapp/media/${message.media_id}`
        : undefined) ||
      (message.message_type !== 'TEXT' && message.wa_message_id
        ? `/api/v1/whatsapp/media/${message.wa_message_id}`
        : undefined);
    const resolved = resolveMediaUrl(raw);
    if (!resolved) return undefined;
    if (mediaRetryTs) {
      const sep = resolved.includes('?') ? '&' : '?';
      return `${resolved}${sep}_retry=${mediaRetryTs}`;
    }
    return resolved;
  }, [message.media_url, message.media_id, message.wa_message_id, message.message_type, mediaRetryTs]);
  useLayoutEffect(() => {
    finishWaLatency('event_handler_to_message_commit_ms', message.id);
  }, [message]);

  const handleRetryClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry(message.id);
    } catch (err) {
      console.error('[ChatBubble] Retry failed:', err);
    } finally {
      setRetrying(false);
    }
  };

  const formatTime = (dateStr?: string) => {
    return formatMessageTime(dateStr, language);
  };

  // Tepki yalnizca KALICI (sayisal id'li) mesaja birakilabilir: iyimser satirin
  // henuz sunucu kimligi yoktur ve `/reactions` ucu ona 404 donerdi.
  const canReact = Boolean(onReact) && typeof message.id === 'number' && message.id > 0;

  // Ayni ifadeyi birden fazla kisi biraktiysa tek rozet + sayac gosterilir
  // (WhatsApp Web paritesi). "Benim" isaretli rozete tiklamak ifadeyi GERI CEKER.
  // Gruplama kurali TEK bir yerde (`groupReactions`) yasar; test kapisi da
  // ayni fonksiyonu dogrular.
  const groupedReactions = React.useMemo(
    () => groupReactions(message.reactions),
    [message.reactions],
  );

  // Hizli tepki cubugu disina tiklaninca kapanir (WhatsApp Web paritesi).
  const reactionBarRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!isReactionBarOpen) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!reactionBarRef.current) return;
      if (!reactionBarRef.current.contains(e.target as Node)) setIsReactionBarOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [isReactionBarOpen]);

  const handleReact = async (emoji: string) => {
    if (!canReact || !onReact || reacting) return;
    setIsReactionBarOpen(false);
    setIsPickerOpen(false);
    setReacting(true);
    try {
      await onReact(message.id, emoji);
    } catch (err) {
      // Hata YUTULMAZ ama balonu da dusurmez: cagiran (sohbet ekrani) iyimser
      // rozeti geri alir ve toast gosterir; burada konsola iz birakilir.
      console.error('[ChatBubble] Reaction failed:', err);
    } finally {
      setReacting(false);
    }
  };

  // I-5 / F-13: the group sender label is resolved by the SAME canonical
  // display helper as the conversation identity. A raw technical JID
  // (`jid:…`, `@lid`, `@g.us`, `@s.whatsapp.net`) is never rendered; the
  // helper resolves a PN JID to its phone, a known contact to its name, an
  // unmapped LID to a deterministic fallback.
  const senderLabel = React.useMemo(() => {
    if (!isInbound || !isGroup || !message.sender_name) return null;
    const label = getConversationDisplayName(
      {
        id: 0,
        lead_name: message.sender_name,
        lead_phone: message.sender_phone,
        is_group: false,
      } as Conversation,
      t,
    );
    if (!label || label === chatTitle) return null;
    return label;
  }, [isInbound, isGroup, message.sender_name, message.sender_phone, chatTitle, t]);

  const renderStatusIcon = () => {
    if (isInbound) return null;
    switch (message.status) {
      case 'PENDING':
        return (
          <Tooltip content={t('whatsapp.msgPending')}>
            <Clock className="w-3.5 h-3.5 text-slate-400 dark:text-slate-400 animate-pulse" />
          </Tooltip>
        );
      case 'SENT':
        return (
          <Tooltip content={t('leads.msgSent')}>
            <Check className="w-3.5 h-3.5 text-[#8696a0]" />
          </Tooltip>
        );
      case 'DELIVERED':
        return (
          <Tooltip content={t('leads.msgDelivered')}>
            <CheckCheck className="w-3.5 h-3.5 text-[#8696a0]" />
          </Tooltip>
        );
      case 'READ':
        return (
          <Tooltip content={t('leads.msgRead')}>
            <CheckCheck className="w-3.5 h-3.5 text-[#53bdeb]" />
          </Tooltip>
        );
      case 'FAILED':
        return (
          <Tooltip content={t('whatsapp.msgFailed')}>
            <AlertCircle className="w-3.5 h-3.5 text-rose-500" />
          </Tooltip>
        );
      default:
        return null;
    }
  };

  /**
   * Metin govdesi + (varsa) link onizleme karti.
   *
   * WhatsApp Web onizlemeyi metnin ALTINA koyar; metin her zaman gorunur
   * kalir. Onizleme yoksa (henuz cozulmemis veya basarisiz) yalnizca metin
   * cizilir — "yukleniyor" iskeleti GOSTERILMEZ, cunku onizleme gelecek diye
   * bir soz verilmemistir.
   */
  const formatBodyWithMentions = (text: string) => {
    if (!text) return null;
    let resolvedText = text;

    let quotedBlock: React.ReactNode = null;
    if (resolvedText.startsWith('> ')) {
      const splitIdx = resolvedText.indexOf('\n\n');
      if (splitIdx !== -1) {
        const quotePart = resolvedText.substring(2, splitIdx).trim();
        resolvedText = resolvedText.substring(splitIdx + 2).trim();
        quotedBlock = (
          <div className="mb-1.5 p-2 rounded-lg bg-black/[0.05] dark:bg-black/25 border-l-4 border-[#25D366] text-xs">
            <p className="line-clamp-2 text-[#54656f] dark:text-[#aebac1] font-medium italic">
              {quotePart}
            </p>
          </div>
        );
      }
    }

    if (resolvedText.includes('@228269022560256')) {
      resolvedText = resolvedText.replace(/@228269022560256/g, '@Tolga Cebeci');
    }
    if (resolvedText.includes('@183695935828021')) {
      resolvedText = resolvedText.replace(/@183695935828021/g, '@Cenk Kara');
    }

    const mentionRegex = /(@[A-Za-z0-9_ğüşıöçĞÜŞİÖÇ+]+(?:\s+[A-Za-z0-9_ğüşıöçĞÜŞİÖÇ]+)?)/g;
    const parts = resolvedText.split(mentionRegex);
    const content = parts.length === 1 ? highlightMatches(resolvedText) : parts.map((part, idx) => {
      if (part.startsWith('@') && part.length > 1) {
        return (
          <span
            key={idx}
            className="font-semibold text-[#00a884] dark:text-[#25D366] bg-[#00a884]/10 dark:bg-[#25D366]/20 px-1 py-0.5 rounded text-[13px] inline-flex items-center my-0.5 mx-0.5 align-baseline"
          >
            {highlightMatches(part)}
          </span>
        );
      }
      return <React.Fragment key={idx}>{highlightMatches(part)}</React.Fragment>;
    });

    return (
      <>
        {quotedBlock}
        {content}
      </>
    );
  };

  const renderTextWithPreview = (body: string) => (
    <div className="space-y-1.5 min-w-0">
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere] break-words min-w-0">
        {formatBodyWithMentions(body)}
      </p>
      {message.link_preview && (
        <LinkPreviewCard preview={message.link_preview} isOutbound={!isInbound} />
      )}
    </div>
  );

  const renderMediaContent = () => {
    switch (message.message_type) {
      case 'IMAGE':
        return (
          <div className="space-y-2">
            <div 
              onClick={() => {
                if (!imageLoadError && resolvedMediaUrl) {
                  setLightboxMediaType('IMAGE');
                  setIsLightboxOpen(true);
                }
              }}
              className="relative group rounded-xl overflow-hidden bg-slate-950/10 dark:bg-black/20 border border-black/5 dark:border-white/10 w-[260px] h-[180px] max-w-full cursor-pointer"
            >
              {resolvedMediaUrl && !imageLoadError ? (
                <>
                  <img 
                    src={resolvedMediaUrl} 
                    alt={message.media_caption || t('leads.imageAltFallback')} 
                    onError={() => setImageLoadError(true)}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                  />
                  <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white pointer-events-none">
                    <Eye className="w-5 h-5" />
                  </div>
                </>
              ) : imageLoadError ? (
                <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center bg-slate-200/50 dark:bg-white/[0.05]">
                  <ImageIcon className="w-8 h-8 mb-1.5 text-rose-500/80" />
                  <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300">{t('whatsapp.mediaLoadFailed')}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setImageLoadError(false);
                      setMediaRetryTs(Date.now());
                    }}
                    className="mt-2 px-2.5 py-1 text-[10px] font-semibold rounded bg-[#00a884] hover:bg-[#009272] text-white transition-colors cursor-pointer"
                  >
                    {t('whatsapp.mediaRetry')}
                  </button>
                </div>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-4 text-slate-500 dark:text-slate-400 bg-slate-200/50 dark:bg-white/[0.05]">
                  <ImageIcon className="w-10 h-10 mb-2 opacity-60" />
                  <span className="text-[11px] font-bold">{t('leads.imagePreview')}</span>
                  <span className="text-[9px] opacity-70 font-mono mt-0.5">{message.media_mime_type || 'image/jpeg'}</span>
                </div>
              )}
            </div>
            {message.media_caption && (
              <p className="whitespace-pre-wrap break-words font-medium text-xs">
                {highlightMatches(message.media_caption)}
              </p>
            )}
          </div>
        );

      case 'DOCUMENT':
        return (
          <div className="space-y-2">
            <DocumentCard
              filename={message.media_filename}
              mimeType={message.media_mime_type}
              url={resolvedMediaUrl}
              senderName={isInbound ? (chatTitle || message.sender_phone || undefined) : undefined}
              timestamp={formatTime(message.created_at)}
              isOutbound={!isInbound}
            />
            {message.media_caption && (
              <p className="whitespace-pre-wrap break-words font-medium text-xs">
                {highlightMatches(message.media_caption)}
              </p>
            )}
          </div>
        );

      case 'AUDIO':
        return (
          <div className="space-y-1.5 min-w-[240px]">
            {resolvedMediaUrl ? (
              <VoiceNotePlayer
                src={resolvedMediaUrl}
                mimeType={message.media_mime_type}
                isOutbound={!isInbound}
              />
            ) : (
              <div className="flex items-center space-x-2.5 p-2 rounded-xl bg-black/5 dark:bg-white/[0.06]">
                <div className="w-8 h-8 rounded-full bg-[#25D366]/20 text-[#25D366] flex items-center justify-center shrink-0">
                  <Music className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] font-bold block">{t('leads.voiceMessage')}</span>
                  <span className="text-[9px] font-mono text-slate-400">{message.media_mime_type || 'audio/ogg'}</span>
                </div>
              </div>
            )}
          </div>
        );

      case 'VIDEO':
        const videoSrc = resolvedMediaUrl
          ? (resolvedMediaUrl.includes('#') ? resolvedMediaUrl : `${resolvedMediaUrl}#t=0.1`)
          : undefined;

        return (
          <div className="space-y-2 w-[260px] max-w-full">
            <div className="relative group rounded-xl overflow-hidden bg-black/40 border border-black/5 dark:border-white/10 w-full h-[180px]">
              {videoSrc ? (
                <>
                  <video
                    controls
                    preload="metadata"
                    playsInline
                    src={videoSrc}
                    className="w-full h-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setLightboxMediaType('VIDEO');
                      setIsLightboxOpen(true);
                    }}
                    title={t('whatsapp.mediaOpenLightbox')}
                    aria-label={t('whatsapp.mediaOpenLightbox')}
                    className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-white/80 hover:text-white hover:bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer z-10"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-4 text-slate-500 dark:text-slate-400 bg-slate-200/50 dark:bg-white/[0.05]">
                  <Video className="w-8 h-8 mx-auto text-[#7367F0] mb-1.5" />
                  <span className="text-xs font-bold block">{t('leads.videoMessage')}</span>
                  <span className="text-[10px] text-slate-400 font-mono">{message.media_mime_type || 'video/mp4'}</span>
                </div>
              )}
            </div>
            {message.media_caption && (
              <p className="whitespace-pre-wrap break-words font-medium text-xs">
                {highlightMatches(message.media_caption)}
              </p>
            )}
          </div>
        );

      case 'LOCATION':
      case 'OTHER': {
        // D6: konum render'i artik ONCE message_type==='LOCATION'a bakar
        // (backend/gateway `classifyMessageType` bunu uretir). Eski kontrol
        // yalnizca Turkce 'Konum:' literaline bakıyordu; sunucu tarafi
        // isareti (📍 Konum) de tolere edilir — bunlar VERI isaretleridir,
        // UI metni degil (UI metni i18n'den gelir).
        const bodyText = message.body || '';
        const isLocation =
          message.message_type === 'LOCATION' ||
          /^📍?\s*Konum\b/i.test(bodyText);
        if (isLocation) {
          return (
            <div className="flex items-center space-x-2.5 p-2.5 rounded-xl bg-slate-200/60 dark:bg-white/[0.06] border border-black/5 dark:border-white/10 min-w-0">
              <MapPin className="w-5 h-5 text-rose-500 shrink-0" />
              <span className="text-xs font-bold [overflow-wrap:anywhere] break-words min-w-0">
                {bodyText || t('whatsapp.previewLocation')}
              </span>
            </div>
          );
        }
        return renderTextWithPreview(message.body || t('leads.mediaFallback'));
      }

      case 'STICKER':
        // Cikartma: balon icinde ciplak gorsel olarak durur.
        return resolvedMediaUrl ? (
          <img
            src={resolvedMediaUrl}
            alt={t('whatsapp.stickerAlt')}
            className="w-32 h-32 object-contain"
          />
        ) : (
          <div className="flex flex-col items-center justify-center p-4 text-slate-500 dark:text-slate-400">
            <ImageIcon className="w-8 h-8 mb-1 opacity-60" />
            <span className="text-[11px] font-bold">{t('whatsapp.stickerUnavailable')}</span>
          </div>
        );

      case 'TEXT':
      default:
        if (!message.body && !message.link_preview) {
          if (resolvedMediaUrl) {
            return (
              <div className="space-y-2">
                <div 
                  onClick={() => {
                    if (!imageLoadError && resolvedMediaUrl) {
                      setLightboxMediaType('IMAGE');
                      setIsLightboxOpen(true);
                    }
                  }}
                  className="relative group rounded-xl overflow-hidden bg-slate-950/10 dark:bg-black/20 border border-black/5 dark:border-white/10 w-[260px] h-[180px] max-w-full cursor-pointer"
                >
                  <img 
                    src={resolvedMediaUrl} 
                    alt={message.media_caption || t('leads.imageAltFallback')} 
                    onError={() => setImageLoadError(true)}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                  />
                  <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white pointer-events-none">
                    <Eye className="w-5 h-5" />
                  </div>
                </div>
              </div>
            );
          }
          return (
            <p className="text-xs italic opacity-60 text-slate-500 dark:text-slate-400">
              {t('whatsapp.unsupportedMessage')}
            </p>
          );
        }
        return renderTextWithPreview(message.body || '');
    }
  };

  return (
    <>
      <div className={`flex w-full ${groupedReactions.length > 0 ? 'mb-4' : 'mb-2'} ${isInbound ? 'justify-start' : 'justify-end'}`}>
        <div
          id={message.id ? `msg-${message.id}` : undefined}
          data-msg-id={message.id}
          className={`relative group max-w-[85%] sm:max-w-[75%] min-w-[68px] px-3 py-1.5 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] text-[13px] leading-relaxed transition-all duration-150 select-text ${
            isSearchActiveMatch ? 'ring-2 ring-[#00a884] dark:ring-[#25D366] shadow-md scale-[1.01]' : ''
          } ${
            isInbound
              ? 'bg-white dark:bg-[#202c33] text-[#111b21] dark:text-[#e9edef] rounded-lg rounded-tl-none border-none'
              : 'bg-[#d9fdd3] dark:bg-[#005c4b] text-[#111b21] dark:text-[#e9edef] rounded-lg rounded-tr-none border-none'
          }`}
        >
          {/* Authentic WhatsApp Web Corner Tail Notch */}
          {isInbound ? (
            <svg
              viewBox="0 0 8 13"
              width="8"
              height="13"
              className="absolute -left-2 top-0 text-white dark:text-[#202c33] fill-current pointer-events-none drop-shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]"
            >
              <path d="M1.533 3.568L8 12.18V0H2.812C1.042 0 .474 2.156 1.533 3.568z" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 8 13"
              width="8"
              height="13"
              className="absolute -right-2 top-0 text-[#d9fdd3] dark:text-[#005c4b] fill-current pointer-events-none drop-shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]"
            >
              <path d="M5.188 0H0v12.18l6.467-8.612C7.526 2.156 6.958 0 5.188 0z" />
            </svg>
          )}

          {/* Group Sender Name */}
          {senderLabel && (
            <div className="text-[11px] font-bold text-[#00a884] dark:text-[#25D366] mb-1 select-none flex items-center gap-1">
              <span>{senderLabel}</span>
            </div>
          )}

          {/* Message Content */}
          {renderMediaContent()}

          {/* Footer info: time & status check */}
          <div
            className={`flex items-center justify-end space-x-1 mt-0.5 text-[10px] select-none ${
              isInbound ? 'text-[#667781] dark:text-[#8696a0]' : 'text-[#667781] dark:text-[#8696a0]'
            }`}
          >
            <span>{formatTime(message.created_at || message.external_timestamp)}</span>
            {renderStatusIcon()}
          </div>

          {/* Tepki rozetleri: WhatsApp Native tarzı yuvarlak/hap biçiminde ferah rozet */}
          {groupedReactions.length > 0 && (
            <div
              className={`absolute -bottom-3 z-10 inline-flex items-center justify-center min-w-[28px] h-[26px] px-1.5 py-0.5 rounded-full shadow-[0_1.5px_4px_rgba(0,0,0,0.12)] dark:shadow-[0_2px_6px_rgba(0,0,0,0.35)] select-none transition-all duration-150 hover:scale-105 ${
                isInbound ? 'left-3' : 'right-3'
              } bg-white dark:bg-[#1E2333] border border-slate-200/90 dark:border-white/15`}
              data-testid={`reaction-chips-${message.id}`}
            >
              {groupedReactions.map((group) => (
                <button
                  key={group.emoji}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleReact(group.mine ? '' : group.emoji);
                  }}
                  disabled={!canReact || reacting}
                  title={group.mine ? t('whatsapp.reactionRemove') : t('whatsapp.reactionAdd')}
                  className="inline-flex items-center justify-center gap-1 cursor-pointer disabled:cursor-not-allowed hover:opacity-85 transition-opacity"
                >
                  <span className="text-[14px] leading-none inline-flex items-center justify-center">
                    {group.emoji}
                  </span>
                  {group.count > 1 && (
                    <span className="text-[10px] font-bold text-slate-600 dark:text-slate-300 ml-0.5 select-none leading-none">
                      {group.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* WhatsApp Web Hover Action Bar (Tepki, Yanıtla, Kopyala) */}
          <div
            className={`absolute -top-3.5 ${
              isInbound ? '-right-2' : '-left-2'
            } z-10 flex items-center gap-0.5 p-0.5 rounded-full bg-white dark:bg-[#202c33] border border-slate-200/80 dark:border-white/10 shadow-md opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity`}
          >
            {/* Tepki Tetikleyicisi */}
            {canReact && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsReactionBarOpen((open) => !open);
                }}
                disabled={reacting}
                title={t('whatsapp.reactionAdd')}
                aria-label={t('whatsapp.reactionAdd')}
                data-testid={`reaction-trigger-${message.id}`}
                className="p-1 rounded-full text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-40"
              >
                {reacting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <SmilePlus className="w-3.5 h-3.5" />
                )}
              </button>
            )}

            {/* Yanıtla Butonu */}
            {onReply && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onReply(message);
                }}
                title={t('whatsapp.reply')}
                aria-label={t('whatsapp.reply')}
                className="p-1 rounded-full text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
              >
                <Reply className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Kopyala Butonu */}
            {(message.body || message.media_caption) && (
              <button
                type="button"
                onClick={handleCopy}
                title={copied ? t('common.copied') : t('common.copy')}
                aria-label={copied ? t('common.copied') : t('common.copy')}
                className="p-1 rounded-full text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-[#25D366]" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            )}
          </div>

          {canReact && isReactionBarOpen && (
            <div
              ref={reactionBarRef}
              data-testid={`reaction-bar-${message.id}`}
              className={`absolute -top-11 ${
                isInbound ? 'left-0' : 'right-0'
              } z-20 flex items-center gap-0.5 px-1.5 py-1 rounded-full bg-white dark:bg-[#202c33] border border-slate-200 dark:border-white/10 shadow-lg animate-in fade-in slide-in-from-bottom-1 duration-150`}
            >
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleReact(emoji);
                  }}
                  disabled={reacting}
                  className="w-7 h-7 grid place-items-center text-base rounded-full hover:bg-slate-100 dark:hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-40"
                >
                  {emoji}
                </button>
              ))}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsReactionBarOpen(false);
                  setIsPickerOpen(true);
                }}
                title={t('whatsapp.reactionMore')}
                aria-label={t('whatsapp.reactionMore')}
                className="w-7 h-7 grid place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Failed State Retry Action */}
          {!isInbound && message.status === 'FAILED' && onRetry && (
            <div className="flex items-center justify-between space-x-2 mt-1.5 pt-1.5 border-t border-rose-300 dark:border-rose-800/50 select-none">
              <span className="text-[10px] text-rose-600 dark:text-rose-400 font-bold">
                {t('whatsapp.msgFailed')}
              </span>
              <button
                type="button"
                onClick={handleRetryClick}
                disabled={retrying}
                className="flex items-center space-x-1 px-2 py-0.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-[10px] font-extrabold text-rose-700 dark:text-rose-300 transition-all cursor-pointer disabled:opacity-50 border border-rose-300 dark:border-rose-700/50"
              >
                {retrying ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RotateCcw className="w-3 h-3" />
                )}
                <span>{t('whatsapp.retryBtn')}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tam ifade paneli: balonun icinde konumlanan genis panel sohbet
          kaydirma alaninda KIRPILIR, bu yuzden ayni `EmojiPicker` modal
          icinde acilir (bilesen ve arama/recents davranisi ayni kalir). */}
      {isPickerOpen && (
        <Modal
          isOpen={isPickerOpen}
          onClose={() => setIsPickerOpen(false)}
          title={t('whatsapp.reactionPickerTitle')}
          icon={SmilePlus}
          maxWidth="sm"
        >
          <EmojiPicker
            onPick={(char) => {
              setIsPickerOpen(false);
              void handleReact(char);
            }}
            onClose={() => setIsPickerOpen(false)}
            className="h-72"
          />
        </Modal>
      )}

      {/* Authentic WhatsApp Web Full-Screen Media Lightbox */}
      <MediaLightbox
        isOpen={isLightboxOpen}
        onClose={() => setIsLightboxOpen(false)}
        src={resolvedMediaUrl}
        mediaType={lightboxMediaType}
        caption={message.media_caption || undefined}
        filename={message.media_filename || undefined}
        senderName={isInbound ? (chatTitle || message.sender_phone || undefined) : undefined}
        timestamp={formatTime(message.created_at)}
      />
    </>
  );
};

// PHASE 2.K single-variable experiment: default shallow-compare memo (no custom comparator).
export const ChatBubble = React.memo(ChatBubbleComponent);
