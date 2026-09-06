import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { 
  CheckCircle2, 
  AlertOctagon, 
  AlertTriangle, 
  Info, 
  MessageCircle, 
  X, 
  HelpCircle,
  Loader2
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { translations, Language } from '../locales';
import { useI18n } from './I18nContext';

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'reply';

export interface ToastItem {
  id: string;
  title: string;
  desc?: string;
  type: ToastType;
  duration?: number;
}


export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'primary';
}

interface ToastContextType {
  showToast: (toast: Omit<ToastItem, 'id'>) => string;
  removeToast: (id: string) => void;
  success: (desc: string, title?: string) => string;
  error: (desc: string, title?: string) => string;
  warning: (desc: string, title?: string) => string;
  info: (desc: string, title?: string) => string;
  reply: (desc: string, title?: string) => string;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

// Event emitter fallback for outside-react usage
type ToastListener = (toast: ToastItem) => void;
const listeners: ToastListener[] = [];

// Resolve default toast titles from dictionaries (usable outside React, no hardcoded strings)
function getStoredLanguage(): Language {
  if (typeof window !== 'undefined') {
    const saved = window.localStorage.getItem('tezlify_lang');
    if (saved === 'en' || saved === 'tr') return saved;
  }
  return 'en';
}

function defaultToastTitle(type: ToastType): string {
  const lang = getStoredLanguage();
  const key =
    type === 'success'
      ? 'successTitle'
      : type === 'error'
        ? 'errorTitle'
        : type === 'warning'
          ? 'warningTitle'
          : type === 'reply'
            ? 'replyTitle'
            : 'infoTitle';
  const dict = translations[lang].common as Record<string, string>;
  const fallback = translations.en.common as Record<string, string>;
  return dict[key] ?? fallback[key] ?? type;
}

export const toast = {
  show: (type: ToastType, desc: string, title?: string) => {
    const item: ToastItem = {
      id: Math.random().toString(36).substring(2, 9),
      type,
      desc,
      title: title || defaultToastTitle(type),
      duration: 4500,
    };
    listeners.forEach((fn) => fn(item));
    return item.id;
  },
  success: (desc: string, title?: string) => toast.show('success', desc, title || defaultToastTitle('success')),
  error: (desc: string, title?: string) => toast.show('error', desc, title || defaultToastTitle('error')),
  warning: (desc: string, title?: string) => toast.show('warning', desc, title || defaultToastTitle('warning')),
  info: (desc: string, title?: string) => toast.show('info', desc, title || defaultToastTitle('info')),
  reply: (desc: string, title?: string) => toast.show('reply', desc, title || defaultToastTitle('reply')),
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean;
    options: ConfirmDialogOptions;
    resolve: (val: boolean) => void;
  } | null>(null);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    ({ title, desc, type, duration = 4500 }: Omit<ToastItem, 'id'>) => {
      const id = Math.random().toString(36).substring(2, 9);
      const newItem: ToastItem = { id, title, desc, type, duration };

      setToasts((prev) => [newItem, ...prev.slice(0, 4)]);

      if (duration > 0) {
        setTimeout(() => {
          removeToast(id);
        }, duration);
      }
      return id;
    },
    [removeToast]
  );

  // Hook global toast emitter into this provider
  React.useEffect(() => {
    const handleGlobalToast = (item: ToastItem) => {
      setToasts((prev) => [item, ...prev.slice(0, 4)]);
      if (item.duration && item.duration > 0) {
        setTimeout(() => {
          removeToast(item.id);
        }, item.duration);
      }
    };
    listeners.push(handleGlobalToast);
    return () => {
      const idx = listeners.indexOf(handleGlobalToast);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  }, [removeToast]);

  const success = useCallback((desc: string, title?: string) => showToast({ type: 'success', title: title ?? t('common.successTitle'), desc }), [showToast, t]);
  const error = useCallback((desc: string, title?: string) => showToast({ type: 'error', title: title ?? t('common.errorTitle'), desc }), [showToast, t]);
  const warning = useCallback((desc: string, title?: string) => showToast({ type: 'warning', title: title ?? t('common.warningTitle'), desc }), [showToast, t]);
  const info = useCallback((desc: string, title?: string) => showToast({ type: 'info', title: title ?? t('common.infoTitle'), desc }), [showToast, t]);
  const reply = useCallback((desc: string, title?: string) => showToast({ type: 'reply', title: title ?? t('common.replyTitle'), desc }), [showToast, t]);

  const confirm = useCallback((options: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmState({
        isOpen: true,
        options,
        resolve,
      });
    });
  }, []);

  const handleConfirmClose = (result: boolean) => {
    if (confirmState) {
      confirmState.resolve(result);
      setConfirmState(null);
    }
  };

  const contextValue = useMemo(
    () => ({
      showToast,
      removeToast,
      success,
      error,
      warning,
      info,
      reply,
      confirm,
    }),
    [showToast, removeToast, success, error, warning, info, reply, confirm]
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}


      {/* Floating Toast Notification Container */}
      {typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-[999999] space-y-2.5 max-w-[calc(100vw-2rem)] sm:max-w-sm w-full pointer-events-none select-none">
            {toasts.map((toastItem) => {
              const borderStyles = {
                success: 'border-[#28C76F]/40 shadow-[#28C76F]/10',
                error: 'border-[#EA5455]/40 shadow-[#EA5455]/10',
                warning: 'border-[#FF9F43]/40 shadow-[#FF9F43]/10',
                info: 'border-[#00CFE8]/40 shadow-[#00CFE8]/10',
                reply: 'border-[#7367F0]/40 shadow-[#7367F0]/10',
              }[toastItem.type];

              const iconStyles = {
                success: <CheckCircle2 className="w-5 h-5 text-[#28C76F] shrink-0" />,
                error: <AlertOctagon className="w-5 h-5 text-[#EA5455] shrink-0" />,
                warning: <AlertTriangle className="w-5 h-5 text-[#FF9F43] shrink-0" />,
                info: <Info className="w-5 h-5 text-[#00CFE8] shrink-0" />,
                reply: <MessageCircle className="w-5 h-5 text-[#7367F0] shrink-0" />,
              }[toastItem.type];

              return (
                <div
                  key={toastItem.id}
                  className={`pointer-events-auto p-4 rounded-xl shadow-xl border bg-white dark:bg-[#2F3349] flex items-start space-x-3 animate-slide-left transition-all duration-200 ${borderStyles}`}
                >
                  <div className="mt-0.5">{iconStyles}</div>
                  <div className="flex-1 text-xs min-w-0">
                    <h4 className="font-bold text-slate-900 dark:text-white mb-0.5 tracking-tight">
                      {toastItem.title}
                    </h4>
                    {toastItem.desc && (
                      <p className="text-slate-600 dark:text-[#DBD7EC] font-medium leading-relaxed break-words">
                        {toastItem.desc}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeToast(toastItem.id)}
                    className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors shrink-0 cursor-pointer"
                    title={t('common.close')}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>,
          document.body
        )}

      {/* Unified Custom Confirm Dialog */}
      {confirmState &&
        confirmState.isOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[999999] bg-slate-900/60 flex items-center justify-center p-4 animate-fade-in select-none"
            onClick={() => handleConfirmClose(false)}
          >
            <div
              className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#2F3349] p-6 space-y-4 shadow-2xl border border-slate-200/80 dark:border-white/[0.1] animate-scale-in"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header with Icon */}
              <div className="flex items-center space-x-3">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                    confirmState.options.variant === 'danger'
                      ? 'bg-[#EA5455]/15 text-[#EA5455]'
                      : confirmState.options.variant === 'warning'
                      ? 'bg-[#FF9F43]/15 text-[#FF9F43]'
                      : 'bg-[#7367F0]/15 text-[#7367F0]'
                  }`}
                >
                  {confirmState.options.variant === 'danger' ? (
                    <AlertOctagon className="w-5 h-5 stroke-[2.2]" />
                  ) : confirmState.options.variant === 'warning' ? (
                    <AlertTriangle className="w-5 h-5 stroke-[2.2]" />
                  ) : (
                    <HelpCircle className="w-5 h-5 stroke-[2.2]" />
                  )}
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-slate-800 dark:text-white">
                    {confirmState.options.title}
                  </h3>
                  <p className="text-[11px] text-slate-400 font-medium">{t('common.confirmTitle')}</p>
                </div>
              </div>

              {/* Message */}
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
                {confirmState.options.message}
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end space-x-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleConfirmClose(false)}
                  className="font-bold cursor-pointer"
                >
                  {confirmState.options.cancelText || t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleConfirmClose(true)}
                  className={`font-bold shadow-md cursor-pointer ${
                    confirmState.options.variant === 'danger'
                      ? 'bg-[#EA5455] hover:bg-[#D43B3C] text-white shadow-[#EA5455]/30'
                      : confirmState.options.variant === 'warning'
                      ? 'bg-[#FF9F43] hover:bg-[#E58A32] text-white shadow-[#FF9F43]/30'
                      : 'bg-[#7367F0] hover:bg-[#6254EB] text-white shadow-[#7367F0]/30'
                  }`}
                >
                  {confirmState.options.confirmText || t('common.confirm')}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};
