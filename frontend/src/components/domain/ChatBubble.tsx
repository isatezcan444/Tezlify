import React, { useState } from 'react';
import { 
  Check, 
  CheckCheck, 
  AlertCircle, 
  FileText, 
  Image as ImageIcon, 
  Music, 
  Video, 
  MapPin, 
  Download,
  Eye,
  RotateCcw,
  Loader2
} from 'lucide-react';
import { Message } from '../../types';
import { Tooltip } from '../ui/Tooltip';
import { Modal } from '../ui/Modal';
import { useI18n } from '../../context/I18nContext';
import { parseServerTime, formatMessageTime } from '../../lib/utils';

export interface ChatBubbleProps {
  message: Message;
  onRetry?: (messageId: number) => Promise<void> | void;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({ message, onRetry }) => {
  const { t, language } = useI18n();
  const isInbound = message.direction === 'INBOUND';
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

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

  const renderStatusIcon = () => {
    if (isInbound) return null;
    switch (message.status) {
      case 'SENT':
        return (
          <Tooltip content={t('leads.msgSent') || 'Gönderildi'}>
            <Check className="w-3.5 h-3.5 text-white/70" />
          </Tooltip>
        );
      case 'DELIVERED':
        return (
          <Tooltip content={t('leads.msgDelivered') || 'Teslim edildi'}>
            <CheckCheck className="w-3.5 h-3.5 text-white/70" />
          </Tooltip>
        );
      case 'READ':
        return (
          <Tooltip content={t('leads.msgRead') || 'Okundu'}>
            <CheckCheck className="w-3.5 h-3.5 text-cyan-200" />
          </Tooltip>
        );
      case 'FAILED':
        return (
          <Tooltip content={t('whatsapp.msgFailed') || 'Mesaj gönderilemedi'}>
            <AlertCircle className="w-3.5 h-3.5 text-rose-300" />
          </Tooltip>
        );
      default:
        return null;
    }
  };

  const renderMediaContent = () => {
    switch (message.message_type) {
      case 'IMAGE':
        return (
          <div className="space-y-2">
            <div 
              onClick={() => setIsLightboxOpen(true)}
              className="relative group rounded-xl overflow-hidden bg-slate-950/10 dark:bg-black/20 border border-black/5 dark:border-white/10 max-w-[280px] cursor-pointer"
            >
              {message.media_url ? (
                <img 
                  src={message.media_url} 
                  alt={message.media_caption || t('leads.imageAltFallback')} 
                  className="w-full h-auto max-h-60 object-cover group-hover:scale-105 transition-transform duration-200"
                />
              ) : (
                <div className="flex flex-col items-center justify-center p-6 text-slate-500 dark:text-slate-400 bg-slate-200/50 dark:bg-white/[0.05]">
                  <ImageIcon className="w-10 h-10 mb-2 opacity-60" />
                  <span className="text-[11px] font-bold">{t('leads.imagePreview') || 'Görsel Eki'}</span>
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
          <div className="space-y-2 max-w-[280px]">
            <div className="flex items-center space-x-3 p-2.5 rounded-xl bg-slate-200/60 dark:bg-white/[0.06] border border-black/5 dark:border-white/10">
              <div className="w-9 h-9 rounded-lg bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center shrink-0">
                <FileText className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold truncate text-slate-800 dark:text-slate-100">
                  {message.media_filename || t('leads.documentFallbackName')}
                </p>
                <p className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate">
                  {message.media_mime_type || 'application/pdf'}
                </p>
              </div>
              <Tooltip content={t('leads.documentReady') || 'Belge hazır'}>
                <div className="p-1.5 rounded-lg bg-black/5 dark:bg-white/5 text-slate-500 dark:text-slate-400">
                  <Download className="w-4 h-4" />
                </div>
              </Tooltip>
            </div>
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
            <div className="flex items-center space-x-2 p-2 rounded-xl bg-slate-200/60 dark:bg-white/[0.06]">
              <div className="w-8 h-8 rounded-full bg-[#28C76F]/20 text-[#28C76F] flex items-center justify-center shrink-0">
                <Music className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <span className="text-[11px] font-bold block">{t('leads.voiceMessage') || 'Sesli Mesaj'}</span>
                <span className="text-[9px] font-mono text-slate-400">{message.media_mime_type || 'audio/ogg'}</span>
              </div>
            </div>
          </div>
        );

      case 'VIDEO':
        return (
          <div className="space-y-2 max-w-[280px]">
            <div className="rounded-xl overflow-hidden bg-slate-950/20 border border-black/5 dark:border-white/10 p-4 text-center">
              <Video className="w-8 h-8 mx-auto text-[#7367F0] mb-1.5" />
              <span className="text-xs font-bold block">{t('leads.videoMessage') || 'Video Eki'}</span>
              <span className="text-[10px] text-slate-400 font-mono">{message.media_mime_type || 'video/mp4'}</span>
            </div>
            {message.media_caption && (
              <p className="whitespace-pre-wrap break-words font-medium text-xs">
                {message.media_caption}
              </p>
            )}
          </div>
        );

      case 'OTHER':
        if (message.body && message.body.startsWith('Konum:')) {
          return (
            <div className="flex items-center space-x-2.5 p-2.5 rounded-xl bg-slate-200/60 dark:bg-white/[0.06] border border-black/5 dark:border-white/10">
              <MapPin className="w-5 h-5 text-rose-500 shrink-0" />
              <span className="text-xs font-bold">{message.body}</span>
            </div>
          );
        }
        return (
          <p className="whitespace-pre-wrap break-words">
            {message.body || t('leads.mediaFallback') || '[Medya içeriği]'}
          </p>
        );

      case 'TEXT':
      default:
        return (
          <p className="whitespace-pre-wrap break-words">
            {message.body || t('leads.mediaFallback') || '[Medya içeriği]'}
          </p>
        );
    }
  };

  return (
    <>
      <div className={`flex w-full mb-3 ${isInbound ? 'justify-start' : 'justify-end'}`}>
        <div
          className={`relative group max-w-[85%] sm:max-w-[75%] px-4 py-2.5 shadow-sm text-xs leading-relaxed transition-all duration-200 ${
            isInbound
              ? 'bg-slate-100 dark:bg-white/[0.08] text-slate-800 dark:text-slate-100 rounded-2xl rounded-tl-sm border border-slate-200/60 dark:border-white/[0.04]'
              : 'bg-[#7367F0] text-white rounded-2xl rounded-tr-sm shadow-[#7367F0]/20'
          }`}
        >
          {/* Sender name for inbound messages (especially in group chats) */}
          {isInbound && message.sender_name && (
            <div className="text-[11px] font-bold text-[#7367F0] dark:text-[#a59bf5] mb-1 select-none flex items-center gap-1">
              <span>{message.sender_name}</span>
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

          {/* Failed State Retry Action */}
          {!isInbound && message.status === 'FAILED' && onRetry && (
            <div className="flex items-center justify-between space-x-2 mt-1.5 pt-1.5 border-t border-white/20 select-none">
              <span className="text-[10px] text-rose-200 font-bold">
                {t('whatsapp.msgFailed') || 'Gönderilemedi'}
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
                <span>{t('whatsapp.retryBtn') || 'Tekrar Dene'}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Lightbox Modal for Image Preview */}
      {isLightboxOpen && (
        <Modal
          isOpen={isLightboxOpen}
          onClose={() => setIsLightboxOpen(false)}
          title={t('leads.imagePreview') || 'Görsel Önizleme'}
          subtitle={message.media_caption || undefined}
          icon={ImageIcon}
          maxWidth="lg"
        >
          <div className="flex flex-col items-center justify-center p-4 bg-slate-950/20 rounded-xl">
            {message.media_url ? (
              <img 
                src={message.media_url} 
                alt={t('leads.imageAltFallback')} 
                className="max-h-[60vh] object-contain rounded-lg shadow-md"
              />
            ) : (
              <div className="py-12 text-center text-slate-400">
                <ImageIcon className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm font-bold">{t('leads.imageReady') || 'Görsel içeriği'}</p>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
};
