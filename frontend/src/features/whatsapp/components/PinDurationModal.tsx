import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Pin, X, Clock, Check } from 'lucide-react';
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

  const messageSnippet = message?.body || message?.media_caption || message?.media_filename || t('whatsapp.messagePreview');

  return createPortal(
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      data-testid="pin-duration-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <div
        className="relative w-full max-w-md bg-white dark:bg-[#1f2c34] rounded-2xl shadow-2xl border border-slate-200/80 dark:border-white/10 overflow-hidden transform animate-in zoom-in-95 duration-200"
        data-testid="pin-duration-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-duration-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.02]">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 dark:bg-amber-400/15 flex items-center justify-center text-amber-600 dark:text-amber-400">
              <Pin className="w-5 h-5 -rotate-45" />
            </div>
            <div>
              <h3
                id="pin-duration-title"
                className="text-base font-semibold text-slate-900 dark:text-white leading-snug"
              >
                {t('whatsapp.pinMessageTitle')}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('whatsapp.pinMessageSubtitle')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="pin-duration-close-btn"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-50"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Message snippet preview */}
          {message && (
            <div className="p-3 rounded-xl bg-slate-100/70 dark:bg-black/20 border-l-4 border-amber-500 text-xs text-slate-700 dark:text-slate-300 line-clamp-2 italic">
              {messageSnippet}
            </div>
          )}

          {/* Duration selection radio options */}
          <div className="space-y-2.5">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('whatsapp.pinDurationPrompt')}
            </label>
            <div className="space-y-2">
              {PIN_DURATIONS.map((dur) => {
                const isSelected = selectedDuration === dur.value;
                return (
                  <button
                    key={dur.value}
                    type="button"
                    onClick={() => setSelectedDuration(dur.value)}
                    disabled={isSubmitting}
                    data-testid={`pin-duration-${dur.hours <= 24 ? '24h' : dur.hours <= 168 ? '7d' : '30d'}`}
                    className={`w-full flex items-center justify-between p-3.5 rounded-xl border transition-all text-left cursor-pointer ${
                      isSelected
                        ? 'border-amber-500 bg-amber-500/10 text-amber-900 dark:text-amber-200 font-medium shadow-sm'
                        : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20 text-slate-700 dark:text-slate-300 bg-transparent'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <Clock className={`w-4 h-4 ${isSelected ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`} />
                      <span className="text-sm">{t(dur.labelKey)}</span>
                    </div>
                    <div
                      className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${
                        isSelected
                          ? 'border-amber-500 bg-amber-500 text-white'
                          : 'border-slate-300 dark:border-white/20'
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end space-x-3 px-6 py-4 border-t border-slate-100 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.02]">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="pin-duration-cancel-btn"
            className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            data-testid="pin-duration-confirm-btn"
            className="px-5 py-2 rounded-xl text-sm font-medium bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white shadow-md shadow-amber-500/20 transition-all flex items-center space-x-2 cursor-pointer disabled:opacity-50"
          >
            <Pin className="w-4 h-4 -rotate-45" />
            <span>{t('whatsapp.pinActionBtn')}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
