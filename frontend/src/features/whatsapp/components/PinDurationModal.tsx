import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Message } from '../../../types';

export interface PinDurationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (durationSeconds: number) => Promise<void> | void;
  message?: Message | null;
  isSubmitting?: boolean;
}

export const PIN_DURATIONS = [
  { value: 86400, labelKey: 'whatsapp.pinDuration24Hours', hours: 24 },
  { value: 604800, labelKey: 'whatsapp.pinDuration7Days', hours: 168 },
  { value: 2592000, labelKey: 'whatsapp.pinDuration30Days', hours: 720 },
] as const;

export const PinDurationModal: React.FC<PinDurationModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  message,
  isSubmitting = false,
}) => {
  const { t } = useI18n();
  const [selectedDuration, setSelectedDuration] = useState<number>(86400);

  // Reset duration on open
  useEffect(() => {
    if (isOpen) {
      setSelectedDuration(86400);
    }
  }, [isOpen]);

  // Handle ESC key
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

  const handleConfirm = async () => {
    await onConfirm(selectedDuration);
  };

  const messageSnippet =
    message?.body || message?.media_caption || message?.media_filename || t('whatsapp.messagePreview');

  return createPortal(
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-150"
      data-testid="pin-duration-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <div
        className="relative w-full max-w-sm bg-white dark:bg-[#222e35] rounded-xl shadow-2xl border border-black/10 dark:border-white/10 overflow-hidden transform animate-in zoom-in-95 duration-150 p-6 space-y-4"
        data-testid="pin-duration-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-duration-title"
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h3
              id="pin-duration-title"
              className="text-base font-semibold text-slate-900 dark:text-[#e9edef] leading-snug"
            >
              {t('whatsapp.pinMessageTitle')}
            </h3>
            <p className="text-xs text-slate-500 dark:text-[#8696a0] mt-1">
              {t('whatsapp.pinMessageSubtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="pin-duration-close-btn"
            className="p-1 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-50 -mr-1 -mt-1"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Message snippet preview */}
        {message && (
          <div className="p-2.5 rounded-lg bg-slate-100 dark:bg-[#111b21] border-l-4 border-[#00a884] text-xs text-slate-600 dark:text-[#aebac1] line-clamp-2 italic select-none">
            {messageSnippet}
          </div>
        )}

        {/* WhatsApp Web Radio Selection */}
        <div className="space-y-1 pt-1">
          {PIN_DURATIONS.map((dur) => {
            const isSelected = selectedDuration === dur.value;
            return (
              <button
                key={dur.value}
                type="button"
                onClick={() => setSelectedDuration(dur.value)}
                disabled={isSubmitting}
                data-testid={`pin-duration-${dur.hours <= 24 ? '24h' : dur.hours <= 168 ? '7d' : '30d'}`}
                className="w-full flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors text-left cursor-pointer group"
              >
                <span
                  className={`text-sm ${
                    isSelected
                      ? 'font-medium text-slate-900 dark:text-[#e9edef]'
                      : 'text-slate-700 dark:text-[#d1d7db]'
                  }`}
                >
                  {t(dur.labelKey)}
                </span>
                <div
                  className={`w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center transition-colors ${
                    isSelected
                      ? 'border-[#00a884]'
                      : 'border-slate-400 dark:border-[#8696a0] group-hover:border-slate-500 dark:group-hover:border-slate-300'
                  }`}
                >
                  {isSelected && <div className="w-2.5 h-2.5 rounded-full bg-[#00a884]" />}
                </div>
              </button>
            );
          })}
        </div>

        {/* WhatsApp Web Footer Action Buttons */}
        <div className="flex items-center justify-end space-x-2 pt-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="pin-duration-cancel-btn"
            className="px-4 py-2 rounded-full text-sm font-medium text-[#00a884] hover:bg-[#00a884]/10 transition-colors cursor-pointer disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            data-testid="pin-duration-confirm-btn"
            className="px-5 py-2 rounded-full text-sm font-medium bg-[#00a884] hover:bg-[#008f72] active:bg-[#007a62] text-white shadow-sm transition-all cursor-pointer disabled:opacity-50"
          >
            {t('whatsapp.pinActionBtn')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
