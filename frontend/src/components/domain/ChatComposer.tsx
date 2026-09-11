import React, { useState, useRef, useEffect } from 'react';
import { 
  Send, 
  Lock, 
  Plus, 
  Paperclip, 
  Loader2, 
  LayoutTemplate, 
  Image as ImageIcon, 
  FileText, 
  RotateCcw,
  Sparkles
} from 'lucide-react';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/Tooltip';
import { Modal } from '../ui/Modal';
import { useI18n } from '../../context/I18nContext';

export interface ChatComposerProps {
  onSend?: (text: string) => Promise<void> | void;
  onSendTemplate?: () => void;
  onSendMedia?: (mediaType: 'IMAGE' | 'DOCUMENT', mediaUrl: string, caption?: string, filename?: string) => Promise<void>;
  onSendMediaFile?: (file: File, caption?: string) => Promise<void>;
  onTyping?: (typing: boolean) => void;
  onReopenConversation?: () => void;
  disabled?: boolean;
  isClosed?: boolean;
  isWindowOpen?: boolean;
  placeholder?: string;
}

export const ChatComposer: React.FC<ChatComposerProps> = ({
  onSend,
  onSendTemplate,
  onSendMedia,
  onSendMediaFile,
  onTyping,
  onReopenConversation,
  disabled = false,
  isClosed = false,
  isWindowOpen = true,
  placeholder,
}) => {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [mediaModalType, setMediaModalType] = useState<'IMAGE' | 'DOCUMENT' | null>(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaCaption, setMediaCaption] = useState('');
  const [mediaFilename, setMediaFilename] = useState('');
  const [sendingMedia, setSendingMedia] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [fileCaption, setFileCaption] = useState('');
  const [sendingFile, setSendingFile] = useState(false);
  const [isFileModalOpen, setIsFileModalOpen] = useState(false);

  const attachMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingSignalRef = useRef<number>(0);
  const typingActiveRef = useRef<boolean>(false);
  const onTypingRef = useRef<((typing: boolean) => void) | undefined>(onTyping);
  onTypingRef.current = onTyping;

  // WhatsApp Web benzeri 'yazıyor...' sinyali: en fazla her 4 sn'de bir
  // composing gonderir; duraklama veya gönderim sonrası paused sinyaller.
  const notifyTypingActivity = () => {
    if (!onTyping || isInputDisabledSafe()) return;
    const now = Date.now();
    if (!typingActiveRef.current || now - lastTypingSignalRef.current > 4000) {
      typingActiveRef.current = true;
      lastTypingSignalRef.current = now;
      onTyping(true);
    } else {
      lastTypingSignalRef.current = now;
    }
  };

  const stopTypingSignal = () => {
    if (!onTyping) return;
    if (typingActiveRef.current) {
      typingActiveRef.current = false;
      onTyping(false);
    }
  };

  const isInputDisabledSafe = () => disabled || isClosed || !isWindowOpen;

  // Yazmayı bırakınca (duraklama) karşı tarafa paused gönder
  useEffect(() => {
    if (!text) return;
    const timer = setTimeout(() => {
      if (typingActiveRef.current && Date.now() - lastTypingSignalRef.current >= 3500) {
        stopTypingSignal();
      }
    }, 4000);
    return () => clearTimeout(timer);
  }, [text]);

  // Unmount / konuşma değişimi durumunda 'yazıyor' sinyali askıda kalmasın
  useEffect(() => {
    return () => {
      if (typingActiveRef.current && onTypingRef.current) {
        onTypingRef.current(false);
      }
    };
  }, []);

  const openFilePicker = (accept: string) => {
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept;
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!onSendMediaFile) return;
    setPendingFile(file);
    setFileCaption('');
    setIsFileModalOpen(true);
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = text.trim();
    if (!clean || disabled || isClosed || sending || !onSend) return;

    setSending(true);
    try {
      await onSend(clean);
      setText('');
      stopTypingSignal();
    } catch (err) {
      console.error('[ChatComposer] Send error:', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleMediaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mediaUrl.trim() || !mediaModalType || !onSendMedia || sendingMedia) return;

    setSendingMedia(true);
    try {
      await onSendMedia(
        mediaModalType,
        mediaUrl.trim(),
        mediaCaption.trim() || undefined,
        mediaFilename.trim() || undefined
      );
      setMediaModalType(null);
      setMediaUrl('');
      setMediaCaption('');
      setMediaFilename('');
      stopTypingSignal();
    } catch (err) {
      console.error('[ChatComposer] Media send error:', err);
    } finally {
      setSendingMedia(false);
    }
  };

  const handleFileSend = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!pendingFile || !onSendMediaFile || sendingFile) return;
    setSendingFile(true);
    try {
      await onSendMediaFile(pendingFile, fileCaption.trim() || undefined);
      stopTypingSignal();
      setIsFileModalOpen(false);
      setPendingFile(null);
      setFileCaption('');
    } catch (err) {
      console.error('[ChatComposer] File send error:', err);
    } finally {
      setSendingFile(false);
    }
  };

  const isActionDisabled = disabled || isClosed || sending;
  const isInputDisabled = isActionDisabled || !isWindowOpen;

  return (
    <div className="p-3 border-t border-slate-200/80 dark:border-white/[0.08] bg-slate-50/50 dark:bg-black/20">
      {/* 1. Closed Conversation Notice */}
      {isClosed && (
        <div className="flex items-center justify-between mb-2.5 px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs">
          <div className="flex items-center space-x-2">
            <Lock className="w-3.5 h-3.5 shrink-0" />
            <span className="font-bold">{t('whatsapp.closedComposerNotice') || 'Bu diyalog kapatılmıştır.'}</span>
          </div>
          {onReopenConversation && (
            <button
              type="button"
              onClick={onReopenConversation}
              className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-700 dark:text-rose-300 font-extrabold text-[11px] transition-all cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>{t('whatsapp.reopen') || 'Diyaloğu Yeniden Aç'}</span>
            </button>
          )}
        </div>
      )}

      {/* 2. Window Expired / Template Prompt Banner */}
      {!isClosed && !isWindowOpen && (
        <div className="flex items-center justify-between mb-2.5 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-xs">
          <div className="flex items-center space-x-2">
            <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            <span className="font-medium">
              {t('whatsapp.windowExpiredNotice') || 'Bu konuşmaya devam etmek için bir WhatsApp şablonu kullanın.'}
            </span>
          </div>
          {onSendTemplate && (
            <Button
              type="button"
              size="sm"
              onClick={onSendTemplate}
              className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-[11px] py-1 px-2.5 h-auto space-x-1 shadow-xs cursor-pointer"
            >
              <LayoutTemplate className="w-3 h-3" />
              <span>{t('whatsapp.useTemplateBtn') || 'Şablon Kullan'}</span>
            </Button>
          )}
        </div>
      )}

      {/* 3. Main Composer Row */}
      <form onSubmit={handleSubmit} className="flex items-center space-x-2">
        {/* Attachment '+' Button with Popover */}
        <div className="relative" ref={attachMenuRef}>
          <Tooltip content={t('whatsapp.addAttachment') || 'Fotoğraf veya Belge Ekle'}>
            <button
              type="button"
              aria-label={t('whatsapp.addAttachment') || 'Fotoğraf veya Belge Ekle'}
              disabled={isActionDisabled}
              onClick={() => setIsAttachMenuOpen(!isAttachMenuOpen)}
              className="p-2 rounded-xl text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-white/[0.08] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-4 h-4" />
            </button>
          </Tooltip>

          {isAttachMenuOpen && (
            <div className="absolute bottom-12 left-0 z-30 w-44 p-1.5 rounded-2xl bg-white dark:bg-[#1E2333] shadow-xl border border-slate-200 dark:border-white/[0.1] space-y-1 animate-in fade-in slide-in-from-bottom-2 duration-150">
              <button
                type="button"
                onClick={() => {
                  setIsAttachMenuOpen(false);
                  openFilePicker('image/*,video/*');
                }}
                className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-all cursor-pointer text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-[#28C76F]/15 text-[#28C76F] flex items-center justify-center shrink-0">
                  <ImageIcon className="w-4 h-4" />
                </div>
                <span>{t('whatsapp.choosePhotoFile') || 'Fotoğraf / Video (Dosya)'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsAttachMenuOpen(false);
                  openFilePicker('.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,application/pdf,application/msword');
                }}
                className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-all cursor-pointer text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4" />
                </div>
                <span>{t('whatsapp.chooseDocFile') || 'Belge (Dosya Seç)'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsAttachMenuOpen(false);
                  setMediaModalType('IMAGE');
                }}
                className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-all cursor-pointer text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-slate-500/15 text-slate-500 flex items-center justify-center shrink-0">
                  <ImageIcon className="w-4 h-4" />
                </div>
                <span>{t('whatsapp.sendPhotoUrl') || 'Fotoğraf (URL)'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsAttachMenuOpen(false);
                  setMediaModalType('DOCUMENT');
                }}
                className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-all cursor-pointer text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-slate-500/15 text-slate-500 flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4" />
                </div>
                <span>{t('whatsapp.sendDocUrl') || 'Belge (URL)'}</span>
              </button>
            </div>
          )}
        </div>

        {/* Hidden native file picker (WhatsApp Web tarzı anlık dosya gönderimi) */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileChosen}
          aria-hidden="true"
          tabIndex={-1}
        />

        {/* Text Input */}
        <div className="relative flex-1">
          <input
            type="text"
            value={text}
            disabled={isInputDisabled}
            onChange={(e) => {
              setText(e.target.value);
              notifyTypingActivity();
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              isClosed
                ? (t('whatsapp.closedPlaceholder') || 'Diyalog kapalı...')
                : !isWindowOpen
                ? (t('whatsapp.windowExpiredPlaceholder') || 'Devam etmek için bir şablon seçin...')
                : (placeholder || t('leads.typeMessagePlaceholder') || 'Mesaj yaz...')
            }
            className={`w-full px-3.5 py-2.5 pr-20 text-xs rounded-xl vuexy-input transition-all ${
              isInputDisabled
                ? 'opacity-60 cursor-not-allowed bg-slate-100 dark:bg-white/[0.04]'
                : ''
            }`}
          />

          {/* Quick Template Button inside Input */}
          {onSendTemplate && !isClosed && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
              <Tooltip content={t('whatsapp.useTemplateBtn') || 'Şablon Kullan'}>
                <button
                  type="button"
                  aria-label={t('whatsapp.useTemplateBtn') || 'Şablon Kullan'}
                  onClick={onSendTemplate}
                  disabled={isActionDisabled}
                  className="flex items-center space-x-1 px-2 py-1 rounded-lg bg-[#7367F0]/10 hover:bg-[#7367F0]/20 text-[#7367F0] text-[10px] font-bold transition-all cursor-pointer disabled:opacity-40"
                >
                  <LayoutTemplate className="w-3 h-3" />
                  <span className="hidden sm:inline">{t('whatsapp.templateShort') || 'Şablon'}</span>
                </button>
              </Tooltip>
            </div>
          )}
        </div>

        {/* Send Button */}
        <Tooltip content={isClosed ? t('whatsapp.closedComposerNotice') : !isWindowOpen ? t('whatsapp.windowExpiredNotice') : t('leads.sendNow') || 'Mesajı Gönder'}>
          <div>
            <Button
              type="submit"
              size="sm"
              aria-label={t('leads.sendNow') || 'Mesajı Gönder'}
              disabled={isInputDisabled || !text.trim()}
              className="bg-[#25D366] hover:bg-[#1EBE5D] text-white px-4 py-2.5 font-bold shadow-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 h-auto"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
        </Tooltip>
      </form>

      {/* 4. Media Send Modal */}
      {mediaModalType && (
        <Modal
          isOpen={!!mediaModalType}
          onClose={() => setMediaModalType(null)}
          title={mediaModalType === 'IMAGE' ? (t('whatsapp.sendPhotoTitle') || 'Fotoğraf Gönder') : (t('whatsapp.sendDocTitle') || 'Belge / PDF Gönder')}
          subtitle={t('whatsapp.mediaUrlPrompt') || 'Göndermek istediğiniz medyanın doğrudan erişilebilir bağlantısını girin.'}
          icon={mediaModalType === 'IMAGE' ? ImageIcon : FileText}
          maxWidth="md"
        >
          <form onSubmit={handleMediaSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                {t('whatsapp.mediaUrlLabel') || 'Medya Bağlantısı (URL)'}
              </label>
              <input
                type="url"
                required
                value={mediaUrl}
                onChange={(e) => setMediaUrl(e.target.value)}
                placeholder={mediaModalType === 'IMAGE' ? 'https://example.com/gorsel.jpg' : 'https://example.com/katalog.pdf'}
                className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium"
              />
            </div>

            {mediaModalType === 'DOCUMENT' && (
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                  {t('whatsapp.filenameLabel') || 'Dosya Adı (İsteğe bağlı)'}
                </label>
                <input
                  type="text"
                  value={mediaFilename}
                  onChange={(e) => setMediaFilename(e.target.value)}
                  placeholder="Fiyat_Teklifi_2026.pdf"
                  className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                {t('whatsapp.captionLabel') || 'Açıklama / Başlık (İsteğe bağlı)'}
              </label>
              <input
                type="text"
                value={mediaCaption}
                onChange={(e) => setMediaCaption(e.target.value)}
                placeholder={t('whatsapp.captionPlaceholder') || 'Görsel hakkında kısa bilgi...'}
                className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium"
              />
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200/80 dark:border-white/[0.08]">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMediaModalType(null)}
                disabled={sendingMedia}
                className="text-xs font-bold"
              >
                {t('common.cancel') || 'İptal'}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={sendingMedia || !mediaUrl.trim()}
                className="bg-[#25D366] hover:bg-[#1EBE5D] text-white text-xs font-bold space-x-1.5 shadow-sm cursor-pointer"
              >
                {sendingMedia ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                <span>{t('whatsapp.sendMediaBtn') || 'Medyayı Gönder'}</span>
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* 5. Picked-File Caption Modal (WhatsApp Web: dosya sec -> aciklama -> gonder) */}
      {isFileModalOpen && pendingFile && (
        <Modal
          isOpen={isFileModalOpen}
          onClose={() => {
            if (!sendingFile) setIsFileModalOpen(false);
          }}
          title={t('whatsapp.sendFileTitle') || 'Dosya Gönder'}
          subtitle={pendingFile.name}
          icon={pendingFile.type.startsWith('image/') ? ImageIcon : FileText}
          maxWidth="md"
        >
          <form onSubmit={handleFileSend} className="space-y-4">
            {pendingFile.type.startsWith('image/') && (
              <div className="rounded-xl overflow-hidden border border-black/5 dark:border-white/10 bg-slate-950/5 dark:bg-black/20 flex items-center justify-center p-2">
                <img
                  src={URL.createObjectURL(pendingFile)}
                  alt={pendingFile.name}
                  className="max-h-52 w-auto object-contain"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                {t('whatsapp.captionLabel') || 'Açıklama / Başlık (İsteğe bağlı)'}
              </label>
              <input
                type="text"
                value={fileCaption}
                onChange={(e) => setFileCaption(e.target.value)}
                placeholder={t('whatsapp.captionPlaceholder') || 'Görsel hakkında kısa bilgi...'}
                className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium"
              />
            </div>
            <p className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
              {pendingFile.type || 'application/octet-stream'} · {(pendingFile.size / 1024).toFixed(1)} KB
            </p>
            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200/80 dark:border-white/[0.08]">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsFileModalOpen(false)}
                disabled={sendingFile}
                className="text-xs font-bold"
              >
                {t('common.cancel') || 'İptal'}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={sendingFile}
                className="bg-[#25D366] hover:bg-[#1EBE5D] text-white text-xs font-bold space-x-1.5 shadow-sm cursor-pointer"
              >
                {sendingFile ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                <span>{t('whatsapp.sendFileBtn') || 'Dosyayı Gönder'}</span>
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};
