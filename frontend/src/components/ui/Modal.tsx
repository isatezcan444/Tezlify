import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { IconTile } from './IconTile';
import { useI18n } from '../../context/I18nContext';

export type ModalVariant = 'primary' | 'danger' | 'warning' | 'success' | 'info';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  variant?: ModalVariant;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  closeOnOutsideClick?: boolean;
}

const maxWidthClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
};

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Confine Tab navigation to a dialog and move focus into it on open.
 *
 * The overlay is `aria-modal`, which tells assistive tech to treat the rest of
 * the page as inert, but it does nothing to the actual Tab key. Without this,
 * a keyboard user tabs straight out of the open dialog and into the page it is
 * covering, losing the dialog entirely.
 *
 * Wrapping is done by listening for Tab and cycling at both ends rather than by
 * sentinel nodes, so it stays correct when the dialog's contents change.
 * Elements made invisible are filtered out, otherwise a hidden close button
 * would swallow the focus.
 *
 * Returns a ref for the panel and a restore function, so the caller only has
 * to wire up the ref.
 */
export function useDialogFocusTrap(
  isOpen: boolean,
): React.RefObject<HTMLDivElement> {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;

    restoreFocusRef.current = (document.activeElement as HTMLElement) || null;

    const getFocusable = (): HTMLElement[] => {
      const panel = panelRef.current;
      if (!panel) return [];
      return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    };

    const initial = getFocusable()[0] || panelRef.current;
    initial?.focus?.();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      // A dialog with nothing focusable still has the panel itself (tabIndex
      // -1); let the browser handle it rather than trapping on nothing.
      if (focusable.length === 0) {
        e.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      try { restoreFocusRef.current?.focus?.(); } catch { /* element gone */ }
    };
  }, [isOpen]);

  return panelRef;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  icon: Icon,
  variant = 'primary',
  maxWidth = 'md',
  children,
  footer,
  className,
  closeOnOutsideClick = true,
}) => {
  const { t } = useI18n();
  // Close on Escape key + lock background scroll
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  // Moves focus into the panel on open, traps Tab inside it, and restores focus
  // to the trigger on close. Shared with Drawer so the behaviour cannot drift
  // between the two.
  const panelRef = useDialogFocusTrap(isOpen);

  if (!isOpen || typeof document === 'undefined') return null;

  // ModalVariant values map 1:1 onto IconTile semantic tones.
  const iconTone = variant as 'primary' | 'danger' | 'warning' | 'success' | 'info';

  return createPortal(
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in select-none"
      onClick={() => closeOnOutsideClick && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          'w-full bg-white dark:bg-vuexy-dark-card rounded-2xl shadow-2xl border border-slate-200/80 dark:border-white/[0.08] p-6 animate-scale-up',
          maxWidthClasses[maxWidth] || maxWidthClasses.md,
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center space-x-3">
            {Icon && (
              <IconTile icon={Icon} size="md" tone={iconTone} />
            )}
            <div>
              <h3 className="text-base font-extrabold text-slate-800 dark:text-white tracking-tight">
                {title}
              </h3>
              {subtitle && (
                <p className="text-[11px] text-slate-400 dark:text-vuexy-dark-muted font-medium mt-0.5">
                  {subtitle}
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body — typography is owned by the caller */}
        <div>{children}</div>

        {/* Optional Footer */}
        {footer && (
          <div className="mt-5 pt-4 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-end space-x-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
