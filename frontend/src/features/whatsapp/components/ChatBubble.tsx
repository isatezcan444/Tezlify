import React, { useState, useLayoutEffect, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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
  Copy,
  Star,
  Forward,
  ChevronDown,
  Pin,
  FileText,
} from 'lucide-react';
import { Conversation, Message, QuotedMessageData } from '../../../types';
import { Tooltip } from '../../../components/ui/Tooltip';
import { Modal } from '../../../components/ui/Modal';
import { useToast } from '../../../context/ToastContext';
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
import { isMessageStarred, toggleMessageStar, subscribeStarredChanges } from '../lib/starredMessages';
import { isMessagePinned, toggleMessagePin, subscribePinnedChanges } from '../lib/pinnedMessages';

/** WhatsApp Web'in tepki cubugunda gosterdigi altı hizli ifade. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

/** WhatsApp Web grup katilimcilari icin otantik renk paleti */
export const GROUP_SENDER_COLORS = [
  'text-[#00a884] dark:text-[#25D366]',
  'text-[#53bdeb] dark:text-[#53bdeb]',
  'text-[#e542a3] dark:text-[#ff72cb]',
  'text-[#ff9f1c] dark:text-[#ffb03a]',
  'text-[#9b5de5] dark:text-[#b388ff]',
  'text-[#00bbf9] dark:text-[#38bdf8]',
  'text-[#f15bb5] dark:text-[#f472b6]',
  'text-[#2dd4bf] dark:text-[#2dd4bf]',
];

export function getSenderColorClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return GROUP_SENDER_COLORS[hash % GROUP_SENDER_COLORS.length];
}

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
  onForward?: (message: Message) => void;
  onDelete?: (message: Message) => Promise<void> | void;
  onEnterSelectMode?: (initialMessageId?: number | string) => void;
  onPrivateReply?: (message: Message) => void;
  onDirectMessageSender?: (senderPhone: string, senderName?: string) => void;
  onReport?: (message: Message) => void;
  isSelectMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (messageId: number | string) => void;
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
  onForward,
  onDelete,
  onEnterSelectMode,
  onPrivateReply,
  onDirectMessageSender,
  onReport,
  isSelectMode = false,
  isSelected = false,
  onToggleSelect,
  searchQuery,
  isSearchActiveMatch,
}) => {
  const { t, language } = useI18n();
  const toast = useToast();
  const isInbound = message.direction === 'INBOUND';
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxMediaType, setLightboxMediaType] = useState<'IMAGE' | 'VIDEO' | 'DOCUMENT'>('IMAGE');
  const [retrying, setRetrying] = useState(false);
  const [isReactionBarOpen, setIsReactionBarOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [reacting, setReacting] = useState(false);
  const [imageLoadError, setImageLoadError] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [mediaRetryTs, setMediaRetryTs] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [isStarred, setIsStarred] = useState<boolean>(() => isMessageStarred(message.id));
  const [isPinned, setIsPinned] = useState<boolean>(() => isMessagePinned(message.id));
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuCoords, setMenuCoords] = useState<{ top: number; left: number; placement: 'up' | 'down' } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (isSelectMode) {
      setIsMenuOpen(false);
      setIsReactionBarOpen(false);
    }
  }, [isSelectMode]);

  const handleToggleMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isMenuOpen && menuButtonRef.current) {
      const rect = menuButtonRef.current.getBoundingClientRect();
      const menuWidth = 160;
      const estimatedHeight = 240;
      const spaceBelow = window.innerHeight - rect.bottom;
      const placement: 'up' | 'down' = spaceBelow < estimatedHeight + 15 ? 'up' : 'down';

      let top = placement === 'up' ? rect.top - estimatedHeight - 4 : rect.bottom + 4;
      if (top < 10) top = 10;
      if (top + estimatedHeight > window.innerHeight - 10) {
        top = Math.max(10, window.innerHeight - estimatedHeight - 10);
      }

      let left = rect.right - menuWidth;
      if (left < 10) left = 10;
      if (left + menuWidth > window.innerWidth - 10) {
        left = window.innerWidth - menuWidth - 10;
      }

      setMenuCoords({ top, left, placement });
      setIsMenuOpen(true);
    } else {
      setIsMenuOpen(false);
    }
  };

  React.useEffect(() => {
    setIsStarred(isMessageStarred(message.id));
    return subscribeStarredChanges(() => {
      setIsStarred(isMessageStarred(message.id));
    });
  }, [message.id]);

  React.useEffect(() => {
    setIsPinned(isMessagePinned(message.id));
    return subscribePinnedChanges(() => {
      setIsPinned(isMessagePinned(message.id));
    });
  }, [message.id]);

  React.useEffect(() => {
    if (!isMenuOpen) return;
    const handleScrollOrResize = () => {
      setIsMenuOpen(false);
    };
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        menuButtonRef.current &&
        !menuButtonRef.current.contains(target)
      ) {
        setIsMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

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
      (mediaRetryTs && message.message_type !== 'TEXT' && message.wa_message_id
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

  React.useEffect(() => {
    setImageLoaded(false);
  }, [resolvedMediaUrl]);
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
  const canReact = !isSelectMode && Boolean(onReact) && typeof message.id === 'number' && message.id > 0;

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
    if (!isInbound || !isGroup || (!message.sender_name && !message.sender_phone)) return null;
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

  const participantName = senderLabel || message.sender_name || message.sender_phone || t('whatsapp.unknownSender');

  const handleDownloadMedia = useCallback(async () => {
    if (!resolvedMediaUrl) return;
    try {
      const res = await fetch(resolvedMediaUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = message.media_filename || (message.message_type === 'VIDEO' ? 'video.mp4' : 'media');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(blobUrl);
    } catch {
      const a = document.createElement('a');
      a.href = resolvedMediaUrl;
      a.download = message.media_filename || 'media';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }, [resolvedMediaUrl, message.media_filename, message.message_type]);

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
   */
  const scrollToQuotedMessage = (targetId?: string | null) => {
    if (!targetId) return;
    const targetEl =
      (document.querySelector(`[data-wa-id="${targetId}"]`) as HTMLElement) ||
      (document.querySelector(`[data-msg-id="${targetId}"]`) as HTMLElement) ||
      document.getElementById(`msg-${targetId}`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.add('ring-2', 'ring-[#00a884]', 'dark:ring-[#25D366]', 'bg-[#00a884]/15', 'dark:bg-[#25D366]/20');
      setTimeout(() => {
        targetEl.classList.remove('ring-2', 'ring-[#00a884]', 'dark:ring-[#25D366]', 'bg-[#00a884]/15', 'dark:bg-[#25D366]/20');
      }, 1800);
    }
  };

  const renderQuotedBlock = (quoted: QuotedMessageData) => {
    const isSelfSender = quoted.sender_name === 'ME' || quoted.sender_phone === 'ME';
    const displayName = isSelfSender ? t('whatsapp.youLabel') : (quoted.sender_name || t('whatsapp.participantFallback'));
    const senderColorClass = isSelfSender ? 'text-[#00a884] dark:text-[#25D366]' : getSenderColorClass(displayName);
    const thumbSrc =
      (quoted.thumbnail ? resolveMediaUrl(quoted.thumbnail) : undefined) ||
      (quoted.media_url
        ? resolveMediaUrl(quoted.media_url)
        : quoted.media_id
        ? resolveMediaUrl(`/api/v1/whatsapp/media/${quoted.media_id}`)
        : null);
    const mType = (quoted.message_type || 'TEXT').toUpperCase();

    const mediaLabel = (() => {
      if (quoted.body && quoted.body !== 'Video' && quoted.body !== 'Fotoğraf' && quoted.body !== 'Belge') {
        return quoted.body;
      }
      switch (mType) {
        case 'VIDEO':
          return t('whatsapp.previewVideo');
        case 'IMAGE':
          return t('whatsapp.previewImage');
        case 'DOCUMENT':
          return quoted.body || t('whatsapp.previewDocument');
        case 'AUDIO':
          return t('whatsapp.previewAudio');
        case 'STICKER':
          return t('whatsapp.previewSticker');
        case 'LOCATION':
          return quoted.body || t('whatsapp.previewLocation');
        case 'CONTACT':
          return quoted.body || t('whatsapp.previewContact');
        default:
          return quoted.body || '';
      }
    })();

    return (
      <div
        onClick={(e) => {
          e.stopPropagation();
          scrollToQuotedMessage(quoted.stanza_id);
        }}
        className="mb-1.5 p-2 rounded-lg bg-black/[0.05] dark:bg-black/25 border-l-[4px] border-[#00a884] dark:border-[#25D366] cursor-pointer hover:bg-black/[0.08] dark:hover:bg-black/35 transition-colors flex items-center justify-between gap-2.5 overflow-hidden text-xs max-w-full group/quote select-none"
      >
        <div className="min-w-0 flex-1 py-0.5">
          <div className={`font-semibold truncate text-[11.5px] leading-tight mb-1 ${senderColorClass}`}>
            {displayName}
          </div>
          <div className="flex items-center gap-1.5 text-[#54656f] dark:text-[#aebac1] text-xs font-normal leading-snug line-clamp-2">
            {mType === 'VIDEO' && <Video className="w-3.5 h-3.5 text-[#8696a0] shrink-0" />}
            {mType === 'IMAGE' && <ImageIcon className="w-3.5 h-3.5 text-[#8696a0] shrink-0" />}
            {mType === 'DOCUMENT' && <FileText className="w-3.5 h-3.5 text-[#8696a0] shrink-0" />}
            {mType === 'AUDIO' && <Music className="w-3.5 h-3.5 text-[#8696a0] shrink-0" />}
            {mType === 'LOCATION' && <MapPin className="w-3.5 h-3.5 text-[#8696a0] shrink-0" />}
            <span className="truncate">{mediaLabel}</span>
          </div>
        </div>

        {thumbSrc && (
          <div className="w-14 h-14 shrink-0 rounded overflow-hidden bg-black/10 dark:bg-black/30 relative flex items-center justify-center">
            {mType === 'VIDEO' && !quoted.thumbnail ? (
              <video
                src={`${thumbSrc}#t=0.1`}
                className="w-full h-full object-cover pointer-events-none"
                preload="metadata"
                muted
                playsInline
              />
            ) : (
              <img
                src={thumbSrc}
                alt="Quote preview"
                className="w-full h-full object-cover pointer-events-none"
                loading="lazy"
              />
            )}
            {mType === 'VIDEO' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/25">
                <Video className="w-4 h-4 text-white drop-shadow" />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  /**
   * Govdedeki @jid / @numara etiketlerini renkli cip olarak gosterir.
   *
   * Link onizlemesi metnin icine KARIŞTIRILMAZ: `renderTextWithPreview` icinde
   * ayri bir blok olarak cizilir. Bu ayrim cok onemli: onizleme metin
   * akisina eklenirse, uzun linklerde veya birden fazla linkte balonun
   * yerlesimi bozulur ve kullanici metni okuyamaz.
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
    if (!message.quoted_message && resolvedText.startsWith('> ')) {
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
                  {!imageLoaded && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-200/50 dark:bg-white/[0.05] animate-pulse">
                      <ImageIcon className="w-8 h-8 text-slate-400 opacity-60" />
                    </div>
                  )}
                  <img 
                    src={resolvedMediaUrl} 
                    alt={message.media_caption || t('leads.imageAltFallback')} 
                    loading="lazy"
                    onLoad={() => setImageLoaded(true)}
                    onError={() => setImageLoadError(true)}
                    className={`w-full h-full object-cover group-hover:scale-105 transition-all duration-200 ${
                      imageLoaded ? 'opacity-100' : 'opacity-0'
                    }`}
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
        if (
          message.media_mime_type?.startsWith('audio/') ||
          (message.media_filename && (
            message.media_filename.toLowerCase().startsWith('voice_') ||
            message.media_filename.toLowerCase().endsWith('.ogg') ||
            message.media_filename.toLowerCase().endsWith('.opus') ||
            message.media_filename.toLowerCase().endsWith('.mp3')
          ))
        ) {
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
              {message.media_caption && (
                <p className="whitespace-pre-wrap break-words font-medium text-xs">
                  {highlightMatches(message.media_caption)}
                </p>
              )}
            </div>
          );
        }
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
      <div
        onClick={isSelectMode ? () => onToggleSelect?.(message.id) : undefined}
        className={`relative flex w-full items-center transition-colors duration-150 ${
          isSelectMode
            ? `cursor-pointer py-1 px-2.5 -mx-2.5 rounded-lg ${
                isSelected
                  ? 'bg-[#00a884]/[0.08] dark:bg-[#00a884]/[0.15]'
                  : 'hover:bg-slate-200/40 dark:hover:bg-white/[0.04]'
              }`
            : ''
        } ${groupedReactions.length > 0 ? '!mb-5 sm:!mb-6 pb-0.5' : 'mb-1 sm:mb-1.5'} ${
          isInbound ? 'justify-start' : 'justify-end'
        }`}
      >
        {isSelectMode && (
          <div className="w-8 shrink-0 flex items-center justify-start mr-1 select-none">
            <div
              data-testid={`select-checkbox-${message.id}`}
              className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all shrink-0 ${
                isSelected
                  ? 'bg-[#00a884] dark:bg-[#25D366] border-[#00a884] dark:border-[#25D366] text-white shadow-sm'
                  : 'border-slate-300 dark:border-white/40 bg-white/80 dark:bg-black/20 hover:border-[#00a884]'
              }`}
            >
              {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
            </div>
          </div>
        )}
        <div
          id={message.id ? `msg-${message.id}` : undefined}
          data-msg-id={message.id}
          data-wa-id={message.wa_message_id}
          className={`relative group max-w-[85%] sm:max-w-[75%] min-w-[76px] pl-2.5 pr-2.5 pt-1.5 pb-1 sm:pl-3 sm:pr-3 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] text-[13px] leading-relaxed transition-all duration-150 select-text ${
            isSearchActiveMatch ? 'ring-2 ring-[#00a884] dark:ring-[#25D366] shadow-md scale-[1.01]' : ''
          } ${
            isInbound
              ? 'bg-white dark:bg-[#202c33] text-[#111b21] dark:text-[#e9edef] rounded-[7.5px] rounded-tl-none border-none'
              : 'bg-[#d9fdd3] dark:bg-[#005c4b] text-[#111b21] dark:text-[#e9edef] rounded-[7.5px] rounded-tr-none border-none'
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
            <div className={`text-[12.5px] font-semibold leading-tight tracking-wide mb-1 select-none flex items-center gap-1 ${getSenderColorClass(senderLabel)}`}>
              <span>{senderLabel}</span>
            </div>
          )}

          {/* Quoted Message Card */}
          {message.quoted_message && renderQuotedBlock(message.quoted_message)}

          {/* Message Content */}
          {renderMediaContent()}

          {/* Footer info: time & status check */}
          <div
            className={`flex items-center justify-end space-x-1 mt-0.5 text-[10px] select-none ${
              isInbound ? 'text-[#667781] dark:text-[#8696a0]' : 'text-[#667781] dark:text-[#8696a0]'
            }`}
          >
            {isPinned && (
              <Pin
                className="w-2.5 h-2.5 text-slate-500 dark:text-slate-400 -rotate-45 shrink-0 inline-block mr-0.5"
                data-testid={`msg-pinned-icon-${message.id}`}
                aria-label={t('whatsapp.menuPin')}
              />
            )}
            {isStarred && (
              <Star
                className="w-2.5 h-2.5 text-amber-500 fill-amber-500 shrink-0 inline-block mr-0.5"
                data-testid={`msg-starred-icon-${message.id}`}
                aria-label={t('whatsapp.starredMessages')}
              />
            )}
            <span>{formatTime(message.created_at || message.external_timestamp)}</span>
            {renderStatusIcon()}
          </div>

          {/* WhatsApp Web Authentic Reaction Pill */}
          {groupedReactions.length > 0 && (
            <div
              className={`absolute -bottom-2.5 z-10 inline-flex items-center justify-center min-w-[24px] h-[22px] px-1.5 py-0 rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.18)] dark:shadow-[0_1.5px_4px_rgba(0,0,0,0.4)] select-none transition-all duration-150 hover:scale-105 ${
                isInbound ? 'left-2.5' : 'right-2.5'
              } bg-white dark:bg-[#1f2c34] border border-slate-200/90 dark:border-white/10`}
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
                  className="inline-flex items-center justify-center gap-0.5 cursor-pointer disabled:cursor-not-allowed hover:opacity-85 transition-opacity"
                >
                  <span className="text-[12px] leading-none inline-flex items-center justify-center">
                    {group.emoji}
                  </span>
                  {group.count > 1 && (
                    <span
                      className={`text-[9px] font-bold ${
                        group.mine ? 'text-[#00a884] dark:text-[#25D366]' : 'text-slate-600 dark:text-slate-300'
                      } ml-0.5 select-none leading-none`}
                    >
                      {group.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Quick Reaction Button (outside bubble on hover) */}
          {canReact && !isSelectMode && (
            <div
              className={`absolute top-1 ${
                isInbound ? '-right-8' : '-left-8'
              } z-10 opacity-0 sm:group-hover:opacity-100 transition-opacity`}
            >
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
                className="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-40"
              >
                {reacting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <SmilePlus className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          )}

          {/* WhatsApp Web Message Chevron Down Trigger ("Ok Butonu") */}
          {!isSelectMode && (
            <div className="absolute top-1 right-1 z-20">
              <button
                ref={menuButtonRef}
                type="button"
                onClick={handleToggleMenu}
                data-testid={`msg-menu-btn-${message.id}`}
                title={t('common.actions')}
                aria-label={t('common.actions')}
                className={`w-5 h-5 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                  isMenuOpen
                    ? 'opacity-100 bg-black/15 dark:bg-white/15 text-slate-900 dark:text-white'
                    : 'opacity-70 sm:opacity-0 sm:group-hover:opacity-100 text-[#667781] dark:text-[#8696a0] hover:text-slate-900 dark:hover:text-white hover:bg-black/10 dark:hover:bg-white/10'
                }`}
              >
                <ChevronDown className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
            </div>
          )}

          {/* WhatsApp Web Authentic Context Dropdown Menu (Portaled & Compact) */}
          {isMenuOpen && !isSelectMode && menuCoords && typeof document !== 'undefined' && createPortal(
            <div
              ref={menuRef}
              data-testid={`msg-context-menu-${message.id}`}
              style={{
                position: 'fixed',
                top: `${menuCoords.top}px`,
                left: `${menuCoords.left}px`,
                width: '160px',
              }}
              className="z-[99999] py-1 bg-white dark:bg-[#233138] border border-black/5 dark:border-white/5 rounded-lg shadow-[0_2px_5px_0_rgba(11,20,26,.26),0_2px_10px_0_rgba(11,20,26,.16)] animate-in fade-in zoom-in-95 duration-100 flex flex-col text-[12.5px] select-none"
            >
              {/* 1. Cevapla */}
              {onReply && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(false);
                    onReply(message);
                  }}
                  data-testid={`menu-reply-${message.id}`}
                  className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
                >
                  {t('whatsapp.menuReply')}
                </button>
              )}

              {/* 2. İfade Bırak */}
              {canReact && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(false);
                    setIsReactionBarOpen(true);
                  }}
                  data-testid={`menu-react-${message.id}`}
                  className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
                >
                  {t('whatsapp.menuReact')}
                </button>
              )}

              {/* 3. Yıldız Ekle / Yıldızı Kaldır */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMenuOpen(false);
                  const nextStarred = toggleMessageStar(message.id, message.conversation_id);
                  setIsStarred(nextStarred);
                  toast.success(
                    nextStarred
                      ? t('whatsapp.messageStarred')
                      : t('whatsapp.messageUnstarred')
                  );
                }}
                data-testid={`menu-star-${message.id}`}
                className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
              >
                {isStarred ? t('whatsapp.menuUnstar') : t('whatsapp.menuStar')}
              </button>

              {/* 4. Sabitle / Sabitlemeyi Kaldır */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMenuOpen(false);
                  const nextPinned = toggleMessagePin(message.id, message.conversation_id);
                  setIsPinned(nextPinned);
                  toast.success(nextPinned ? t('whatsapp.messagePinned') : t('whatsapp.messageUnpinned'));
                }}
                data-testid={`menu-pin-${message.id}`}
                className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
              >
                {isPinned ? t('whatsapp.menuUnpin') : t('whatsapp.menuPin')}
              </button>

              {/* 5. İlet */}
              {onForward && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(false);
                    onForward(message);
                  }}
                  data-testid={`menu-forward-${message.id}`}
                  className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
                >
                  {t('whatsapp.menuForward')}
                </button>
              )}

              {/* 6. Kopyala */}
              {(message.body || message.media_caption) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(false);
                    handleCopy(e);
                    toast.success(t('common.copied'));
                  }}
                  data-testid={`menu-copy-${message.id}`}
                  className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
                >
                  {t('whatsapp.menuCopy')}
                </button>
              )}

              {/* Grup sohbetine ve karşı tarafa özel seçenekler */}
              {isGroup && isInbound && (
                <>
                  <div className="my-0.5 border-t border-slate-100 dark:border-white/[0.06]" />
                  {onPrivateReply && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsMenuOpen(false);
                        onPrivateReply(message);
                      }}
                      data-testid={`menu-reply-privately-${message.id}`}
                      className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
                    >
                      {t('whatsapp.menuReplyPrivately')}
                    </button>
                  )}
                  {onDirectMessageSender && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsMenuOpen(false);
                        onDirectMessageSender(message.sender_phone || '', participantName);
                      }}
                      data-testid={`menu-direct-message-${message.id}`}
                      className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
                    >
                      {t('whatsapp.menuMessageSender', { name: participantName })}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      setIsMenuOpen(false);
                      if (onReport) {
                        onReport(message);
                      } else {
                        const ok = await toast.confirm({
                          title: t('whatsapp.menuReport'),
                          message: t('whatsapp.reportConfirm'),
                          confirmText: t('whatsapp.menuReport'),
                          variant: 'danger',
                        });
                        if (ok) {
                          toast.success(t('whatsapp.messageReported'));
                        }
                      }
                    }}
                    data-testid={`menu-report-${message.id}`}
                    className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
                  >
                    {t('whatsapp.menuReport')}
                  </button>
                </>
              )}

              {/* Bireysel sohbette gelen mesaja şikayet */}
              {!isGroup && isInbound && (
                <>
                  <div className="my-0.5 border-t border-slate-100 dark:border-white/[0.06]" />
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      setIsMenuOpen(false);
                      if (onReport) {
                        onReport(message);
                      } else {
                        const ok = await toast.confirm({
                          title: t('whatsapp.menuReport'),
                          message: t('whatsapp.reportConfirm'),
                          confirmText: t('whatsapp.menuReport'),
                          variant: 'danger',
                        });
                        if (ok) {
                          toast.success(t('whatsapp.messageReported'));
                        }
                      }
                    }}
                    data-testid={`menu-report-${message.id}`}
                    className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
                  >
                    {t('whatsapp.menuReport')}
                  </button>
                </>
              )}

              {/* Medya dosyası ise İndir */}
              {(resolvedMediaUrl || message.media_url || message.media_id) && (
                <>
                  <div className="my-0.5 border-t border-slate-100 dark:border-white/[0.06]" />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsMenuOpen(false);
                      void handleDownloadMedia();
                    }}
                    data-testid={`menu-download-${message.id}`}
                    className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
                  >
                    {t('whatsapp.menuDownload')}
                  </button>
                </>
              )}

              {/* Sil seçeneği */}
              {onDelete && (
                <>
                  <div className="my-0.5 border-t border-slate-100 dark:border-white/[0.06]" />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsMenuOpen(false);
                      void onDelete(message);
                    }}
                    data-testid={`menu-delete-${message.id}`}
                    className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 active:bg-rose-100 dark:active:bg-rose-950/50 transition-colors cursor-pointer select-none font-normal"
                  >
                    {t('whatsapp.menuDelete')}
                  </button>
                </>
              )}

              {/* Mesajları seç */}
              <div className="my-0.5 border-t border-slate-100 dark:border-white/[0.06]" />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMenuOpen(false);
                  if (onEnterSelectMode) {
                    onEnterSelectMode(message.id);
                  } else {
                    onToggleSelect?.(message.id);
                  }
                }}
                data-testid={`menu-select-${message.id}`}
                className="w-full text-left px-3.5 py-1.5 text-[12.5px] text-[#3b4a54] dark:text-[#d1d7db] hover:bg-[#f5f6f6] dark:hover:bg-[#182229] active:bg-slate-200/50 dark:active:bg-white/[0.08] transition-colors cursor-pointer select-none font-normal"
              >
                {t('whatsapp.menuSelect')}
              </button>
            </div>,
            document.body
          )}

          {canReact && !isSelectMode && isReactionBarOpen && (
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
                  className="w-7 h-7 grid place-items-center text-base rounded-full hover:bg-slate-100 dark:hover:bg-white/10 transition-transform duration-100 hover:scale-125 cursor-pointer disabled:opacity-40 origin-bottom select-none"
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
                className="w-7 h-7 grid place-items-center rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-transform duration-100 hover:scale-115 cursor-pointer"
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
          <div className="flex justify-center -m-1">
            <EmojiPicker
              onPick={(char) => {
                setIsPickerOpen(false);
                void handleReact(char);
              }}
              onClose={() => setIsPickerOpen(false)}
              className="h-80 w-full border-none shadow-none dark:bg-transparent bg-transparent"
            />
          </div>
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
