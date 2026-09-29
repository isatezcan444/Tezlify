import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useI18n } from '../../context/I18nContext';
import { useDialogFocusTrap } from './Modal';

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: LucideIcon;
  position?: 'right' | 'left';
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export const Drawer: React.FC<DrawerProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  icon: Icon,
  position = 'right',
  size = 'md',
  children,
  footer,
  className,
}) => {
  // Accessible name for the icon-only close button. `title` is a mouse-only
  // hint and is not reliably announced by screen readers.
  const { t } = useI18n();
  // Trap escape key & disable body scroll
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleKeyDown);
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Shared with Modal: focus in on open, Tab trapped inside, focus restored to
  // the trigger on close.
  const panelRef = useDialogFocusTrap(isOpen);

  if (!isOpen || typeof document === 'undefined') return null;

  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    full: 'max-w-full',
  };

  return createPortal(
    <div className="fixed inset-0 z-[99999] flex justify-end animate-fade-in select-none">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity duration-300"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over Content Surface */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          'relative w-full h-full bg-white dark:bg-[#2F3349] shadow-2xl border-l border-slate-200/80 dark:border-white/[0.08] flex flex-col z-10 transition-transform duration-300 ease-out transform',
          position === 'right' ? 'translate-x-0' : 'translate-x-0',
          sizeClasses[size],
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-100 dark:border-white/[0.08]">
          <div className="flex items-center space-x-3 min-w-0">
            {Icon && (
              <div className="w-10 h-10 rounded-xl bg-[#7367F0]/10 dark:bg-[#7367F0]/20 text-[#7367F0] flex items-center justify-center shrink-0">
                <Icon className="w-5 h-5" />
              </div>
            )}
            <div className="min-w-0">
              <h3 className="text-base font-extrabold text-slate-800 dark:text-white truncate">
                {title}
              </h3>
              {subtitle && (
                <p className="text-xs text-slate-400 dark:text-[#7E7F96] mt-0.5 truncate font-medium">
                  {subtitle}
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer shrink-0 ml-2"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Drawer Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {children}
        </div>

        {/* Drawer Footer */}
        {footer && (
          <div className="p-4 border-t border-slate-100 dark:border-white/[0.08] bg-slate-50/50 dark:bg-black/10 flex items-center justify-end space-x-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
