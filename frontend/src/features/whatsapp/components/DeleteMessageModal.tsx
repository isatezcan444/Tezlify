import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, Users, User } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import type { Message } from '../../../types';
import { normalizePreviewText } from '../lib/whatsappPreview';

export interface DeleteMessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (deleteType: 'everyone' | 'for_me') => Promise<void> | void;
  message?: Message | null;
  isSubmitting?: boolean;
}

export const DeleteMessageModal: React.FC<DeleteMessageModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  message,
  isSubmitting = false,
}) => {
  const { t } = useI18n();

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  if (!isOpen || typeof document === 'undefined') return null;

  const isOutbound = message?.direction === 'OUTBOUND';
  const rawBody = message?.body || message?.media_caption || message?.media_filename || (message?.is_view_once ? '[VIEW_ONCE_MEDIA]' : '');
  const messageSnippet = normalizePreviewText(message?.message_type, rawBody, t) || rawBody || t('whatsapp.messagePreview');

  return createPortal(
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-150"
      data-testid="delete-message-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <div
        className="relative w-full max-w-sm bg-white dark:bg-[#222e35] rounded-xl shadow-2xl border border-black/10 dark:border-white/10 overflow-hidden transform animate-in zoom-in-95 duration-150 p-6 space-y-4"
        data-testid="delete-message-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-message-title"
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
              <Trash2 className="w-4 h-4" />
            </div>
            <div>
              <h3
                id="delete-message-title"
                className="text-base font-semibold text-slate-900 dark:text-[#e9edef] leading-snug"
              >
                {t('whatsapp.deleteChoiceTitle')}
              </h3>
              <p className="text-xs text-slate-500 dark:text-[#8696a0] mt-0.5">
                {isOutbound
                  ? t('whatsapp.deleteChoicePrompt')
                  : t('whatsapp.deleteForMeConfirm')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="delete-message-close-btn"
            className="p-1 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-50 -mr-1 -mt-1"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Message snippet preview */}
        {message && (
          <div className="p-2.5 rounded-lg bg-slate-100 dark:bg-[#111b21] border-l-4 border-rose-500 text-xs text-slate-600 dark:text-[#aebac1] line-clamp-2 italic select-none">
            {messageSnippet}
          </div>
        )}

        {/* Action Buttons */}
        <div className="space-y-2 pt-2">
          {isOutbound && (
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => onConfirm('everyone')}
              data-testid="delete-everyone-btn"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-medium text-xs shadow transition-colors cursor-pointer disabled:opacity-50"
            >
              <Users className="w-4 h-4" />
              <span>{t('whatsapp.deleteForEveryone')}</span>
            </button>
          )}

          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => onConfirm('for_me')}
            data-testid="delete-forme-btn"
            className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-xs transition-colors cursor-pointer disabled:opacity-50 ${
              isOutbound
                ? 'bg-slate-100 hover:bg-slate-200 dark:bg-white/10 dark:hover:bg-white/15 text-slate-800 dark:text-slate-200'
                : 'bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white shadow'
            }`}
          >
            <User className="w-4 h-4" />
            <span>{t('whatsapp.deleteForMe')}</span>
          </button>

          <button
            type="button"
            disabled={isSubmitting}
            onClick={onClose}
            data-testid="delete-cancel-btn"
            className="w-full py-2 text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors cursor-pointer disabled:opacity-50"
          >
            {t('whatsapp.editMessageCancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
