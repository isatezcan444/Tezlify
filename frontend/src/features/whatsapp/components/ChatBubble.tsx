import React, { useState, useLayoutEffect } from 'react';
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
  Plus
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
}

const ChatBubbleComponent: React.FC<ChatBubbleProps> = ({ message, isGroup = false, chatTitle, onRetry, onReact }) => {
  const { t, language } = useI18n();
  const isInbound = message.direction === 'INBOUND';
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [isReactionBarOpen, setIsReactionBarOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [reacting, setReacting] = useState(false);
  const resolvedMediaUrl = React.useMemo(() => {
    const raw =
      message.media_url ||
      (message.media_id
        ? `/api/v1/whatsapp/media/${message.media_id}`
        : message.wa_message_id && ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'].includes(message.message_type)
          ? `/api/v1/whatsapp/media/${message.wa_message_id}`
          : undefined);
    return resolveMediaUrl(raw);
  }, [message.media_url, message.media_id, message.wa_message_id, message.message_type]);
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
            <Clock className="w-3.5 h-3.5 text-white/60 animate-pulse" />
          </Tooltip>
        );
      case 'SENT':
        return (
          <Tooltip content={t('leads.msgSent')}>
            <Check className="w-3.5 h-3.5 text-white/70" />
          </Tooltip>
        );
      case 'DELIVERED':
        return (
          <Tooltip content={t('leads.msgDelivered')}>
            <CheckCheck className="w-3.5 h-3.5 text-white/70" />
          </Tooltip>
        );
      case 'READ':
        return (
          <Tooltip content={t('leads.msgRead')}>
            <CheckCheck className="w-3.5 h-3.5 text-cyan-200" />
          </Tooltip>
        );
      case 'FAILED':
        return (
          <Tooltip content={t('whatsapp.msgFailed')}>
            <AlertCircle className="w-3.5 h-3.5 text-rose-300" />
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
  const renderTextWithPreview = (body: string) => (
    <div className="space-y-1.5 min-w-0">
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere] break-words min-w-0">
        {body}
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
              onClick={() => setIsLightboxOpen(true)}
              className="relative group rounded-xl overflow-hidden bg-slate-950/10 dark:bg-black/20 border border-black/5 dark:border-white/10 max-w-[280px] cursor-pointer"
            >
              {resolvedMediaUrl ? (
                <img 
                  src={resolvedMediaUrl} 
                  alt={message.media_caption || t('leads.imageAltFallback')} 
                  className="w-full h-auto max-h-60 object-cover group-hover:scale-105 transition-transform duration-200"
                />
              ) : (
                <div className="flex flex-col items-center justify-center p-6 text-slate-500 dark:text-slate-400 bg-slate-200/50 dark:bg-white/[0.05]">
                  <ImageIcon className="w-10 h-10 mb-2 opacity-60" />
                  <span className="text-[11px] font-bold">{t('leads.imagePreview')}</span>
                  <span className="text-[9px] opacity-70 font-mono mt-0.5">{message.media_mime_type || 'image/jpeg'}</span>
                </div>
              )}
              <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white">
                <Eye className="w-5 h-5" />
              </div>
            </div>
            {message.media_caption && (
              <p className="whitespace-pre-wrap break-words font-medium text-xs">
                {message.media_caption}
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
              isOutbound={!isInbound}
            />
            {message.media_caption && (
              <p className="whitespace-pre-wrap break-words font-medium text-xs">
                {message.media_caption}
              </p>
            )}
          </div>
        );

      case 'AUDIO':
        return (
          <div className="space-y-1.5 min-w-[220px]">
            {resolvedMediaUrl ? (
              <audio controls preload="metadata" src={resolvedMediaUrl} className="w-full h-9 max-w-[260px]" />
            ) : (
              <div className="flex items-center space-x-2 p-2 rounded-xl bg-slate-200/60 dark:bg-white/[0.06]">
                <div className="w-8 h-8 rounded-full bg-[#28C76F]/20 text-[#28C76F] flex items-center justify-center shrink-0">
                  <Music className="w-4 h-4" />
                </div>
                <div className="flex-1">
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
          <div className="space-y-2 max-w-[280px]">
            {videoSrc ? (
              <video
                controls
                preload="metadata"
                playsInline
                // `#t=0.1` medya fragment'i tarayiciya ILK KAREYE atlamasini
                // soyler; bu sayede balon oynatilmadan once siyah bir
                // dikdortgen degil, videonun kendi karesi gorunur. Sunucu
                // tarafinda thumbnail uretmek yeni bir bagimlilik (ffmpeg)
                // gerektirirdi; bu cozum ayni sonucu bagimliliksiz verir.
                src={videoSrc}
                className="w-full max-h-60 rounded-xl border border-black/5 dark:border-white/10 bg-black"
              />
            ) : (
              <div className="rounded-xl overflow-hidden bg-slate-950/20 border border-black/5 dark:border-white/10 p-4 text-center">
                <Video className="w-8 h-8 mx-auto text-[#7367F0] mb-1.5" />
                <span className="text-xs font-bold block">{t('leads.videoMessage')}</span>
                <span className="text-[10px] text-slate-400 font-mono">{message.media_mime_type || 'video/mp4'}</span>
              </div>
            )}
            {message.media_caption && (
              <p className="whitespace-pre-wrap break-words font-medium text-xs">
                {message.media_caption}
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
        return renderTextWithPreview(message.body || t('leads.mediaFallback'));
    }
  };

  return (
    <>
      <div className={`flex w-full ${groupedReactions.length > 0 ? 'mb-4' : 'mb-2.5'} ${isInbound ? 'justify-start' : 'justify-end'}`}>
        <div
          // Sorun 11/12: baloncuk genişliği icerige bagli ama ust siniri
          // viewport'a gore (%75); asla mesaj metniyle yatay buyume YOK.
          className={`relative group max-w-[85%] sm:max-w-[75%] min-w-0 px-4 py-2.5 shadow-sm text-xs leading-relaxed transition-all duration-200 ${
            isInbound
              ? 'bg-slate-100 dark:bg-white/[0.08] text-slate-800 dark:text-slate-100 rounded-2xl rounded-tl-sm border border-slate-200/60 dark:border-white/[0.04]'
              : 'bg-[#7367F0] text-white rounded-2xl rounded-tr-sm shadow-[#7367F0]/20'
          }`}
        >
          {/* Faz 6a: gonderen yalnizca grup sohbetlerinde, sohbet adiyla ayni
              degilse gosterilir (WhatsApp Web paritesi). */}
          {senderLabel && (
            <div className="text-[11px] font-bold text-[#7367F0] dark:text-[#a59bf5] mb-1 select-none flex items-center gap-1">
              <span>{senderLabel}</span>
            </div>
          )}

          {/* Message Content */}
          {renderMediaContent()}

          {/* Footer info: time & status check */}
          <div
            className={`flex items-center justify-end space-x-1.5 mt-1.5 text-[10px] select-none ${
              isInbound ? 'text-slate-400 dark:text-slate-500' : 'text-white/80'
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

          {/* Tepki tetikleyicisi: yalnizca fare balonun uzerindeyken gorunur
              (WhatsApp Web paritesi). Inbound'da sagda, outbound'da solda. */}
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
              className={`absolute -top-3 ${
                isInbound ? '-right-3' : '-left-3'
              } z-10 p-1.5 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/10 shadow-md text-slate-500 dark:text-slate-300 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer disabled:opacity-40`}
            >
              {reacting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <SmilePlus className="w-3.5 h-3.5" />
              )}
            </button>
          )}

          {canReact && isReactionBarOpen && (
            <div
              ref={reactionBarRef}
              data-testid={`reaction-bar-${message.id}`}
              className={`absolute -top-11 ${
                isInbound ? 'left-0' : 'right-0'
              } z-20 flex items-center gap-0.5 px-1.5 py-1 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/10 shadow-lg animate-in fade-in slide-in-from-bottom-1 duration-150`}
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
            <div className="flex items-center justify-between space-x-2 mt-1.5 pt-1.5 border-t border-white/20 select-none">
              <span className="text-[10px] text-rose-200 font-bold">
                {t('whatsapp.msgFailed')}
              </span>
              <button
                type="button"
                onClick={handleRetryClick}
                disabled={retrying}
                className="flex items-center space-x-1 px-2 py-0.5 rounded-lg bg-rose-500/30 hover:bg-rose-500/50 text-[10px] font-extrabold text-white transition-all cursor-pointer disabled:opacity-50 border border-white/20"
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

      {/* Lightbox Modal for Image Preview */}
      {isLightboxOpen && (
        <Modal
          isOpen={isLightboxOpen}
          onClose={() => setIsLightboxOpen(false)}
          title={t('leads.imagePreview')}
          subtitle={message.media_caption || undefined}
          icon={ImageIcon}
          maxWidth="lg"
        >
          <div className="flex flex-col items-center justify-center p-4 bg-slate-950/20 rounded-xl">
            {resolvedMediaUrl ? (
              <img 
                src={resolvedMediaUrl} 
                alt={t('leads.imageAltFallback')} 
                className="max-h-[60vh] object-contain rounded-lg shadow-md"
              />
            ) : (
              <div className="py-12 text-center text-slate-400">
                <ImageIcon className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm font-bold">{t('leads.imageReady')}</p>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
};

// PHASE 2.K single-variable experiment: default shallow-compare memo (no custom comparator).
export const ChatBubble = React.memo(ChatBubbleComponent);
