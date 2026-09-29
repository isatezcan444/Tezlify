import * as React from 'react';
import { AlertCircle, CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useI18n } from '../../context/I18nContext';

export interface AlertProps {
  variant?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  onClose?: () => void;
  className?: string;
}

export const Alert: React.FC<AlertProps> = ({
  variant = 'info',
  title,
  children,
  icon,
  onClose,
  className,
}) => {
  // Used for the icon-only close button's accessible name; `title` alone is a
  // mouse-only hint and is not reliably announced by screen readers.
  const { t } = useI18n();
  const variantStyles = {
    info: {
      box: 'bg-[#00CFE8]/10 border-[#00CFE8]/25 text-[#00CFE8]',
      title: 'text-[#00CFE8]',
      text: 'text-slate-700 dark:text-slate-200',
      defaultIcon: <Info className="w-5 h-5 text-[#00CFE8] shrink-0" />,
    },
    success: {
      box: 'bg-[#28C76F]/10 border-[#28C76F]/25 text-[#28C76F]',
      title: 'text-[#28C76F]',
      text: 'text-slate-700 dark:text-slate-200',
      defaultIcon: <CheckCircle2 className="w-5 h-5 text-[#28C76F] shrink-0" />,
    },
    warning: {
      box: 'bg-[#FF9F43]/10 border-[#FF9F43]/25 text-[#FF9F43]',
      title: 'text-[#FF9F43]',
      text: 'text-slate-700 dark:text-slate-200',
      defaultIcon: <AlertTriangle className="w-5 h-5 text-[#FF9F43] shrink-0" />,
    },
    danger: {
      box: 'bg-[#EA5455]/10 border-[#EA5455]/25 text-[#EA5455]',
      title: 'text-[#EA5455]',
      text: 'text-slate-700 dark:text-slate-200',
      defaultIcon: <AlertCircle className="w-5 h-5 text-[#EA5455] shrink-0" />,
    },
  };

  const current = variantStyles[variant];

  return (
    <div
      className={cn(
        'p-4 rounded-xl border flex items-start space-x-3 text-xs leading-relaxed transition-all',
        current.box,
        className
      )}
      role="alert"
    >
      <div className="shrink-0 mt-0.5">
        {icon !== undefined ? icon : current.defaultIcon}
      </div>

      <div className="flex-1 min-w-0">
        {title && <h4 className={cn('font-bold text-xs mb-0.5', current.title)}>{title}</h4>}
        <div className={cn('font-medium text-xs', current.text)}>{children}</div>
      </div>

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
};
