import React from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../context/I18nContext';
import { cn } from '../../lib/utils';

export interface BulkActionToolbarProps {
  selectedCount: number;
  totalCount: number;
  selectAllMatching: boolean;
  onSelectAllMatching?: () => void;
  onClearSelection: () => void;
  actions: React.ReactNode;
  className?: string;
}

type ActionTone = 'glass' | 'danger';

const actionToneClasses: Record<ActionTone, string> = {
  // Translucent button that sits on the gradient surface.
  glass:
    'bg-white/15 hover:bg-white/25 text-white shadow-sm',
  // Destructive action — Vuexy danger, identical on both CRM and Blacklist.
  danger:
    'bg-[#EA5455] hover:bg-[#D43D3E] text-white shadow-md shadow-[#EA5455]/40',
};

export interface ToolbarActionButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ActionTone;
}

/**
 * Compound component so every page renders toolbar actions identically
 * instead of hand-rolling one-off translucent/rose buttons.
 */
export const ToolbarActionButton: React.FC<ToolbarActionButtonProps> = ({
  tone = 'glass',
  className,
  children,
  ...props
}) => (
  <button
    type="button"
    className={cn(
      'px-3 py-1.5 rounded-lg font-bold text-xs flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer disabled:opacity-50 disabled:pointer-events-none',
      actionToneClasses[tone],
      className
    )}
    {...props}
  >
    {children}
  </button>
);

export const BulkActionToolbar: React.FC<BulkActionToolbarProps> = ({
  selectedCount,
  totalCount,
  selectAllMatching,
  onSelectAllMatching,
  onClearSelection,
  actions,
  className,
}) => {
  const { t } = useI18n();

  if (selectedCount <= 0) return null;

  return (
    <div
      className={cn(
        'sticky bottom-4 z-30 p-3.5 rounded-xl bg-gradient-to-r from-vuexy-primary to-[#867BFF] text-white shadow-lg shadow-vuexy-primary/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-fade-in select-none',
        className
      )}
    >
      <div className="flex items-center space-x-2.5 flex-wrap">
        <span className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center font-bold text-xs shadow-inner">
          {selectedCount}
        </span>
        <span className="text-xs font-extrabold tracking-wide">
          {selectAllMatching
            ? t('leads.allMatchingSelected', { total: totalCount })
            : t('leads.bulkToolbarCount', { count: selectedCount })}
        </span>

        {/* Quick Link to Select All across all pages if available */}
        {!selectAllMatching && onSelectAllMatching && totalCount > selectedCount && (
          <button
            type="button"
            onClick={onSelectAllMatching}
            className="px-2.5 py-1 rounded-lg bg-white/20 hover:bg-white/30 text-white font-bold text-[11px] underline underline-offset-2 transition-all cursor-pointer"
          >
            {t('leads.selectAllTotal', { total: totalCount })}
          </button>
        )}
      </div>

      <div className="flex items-center space-x-2 flex-wrap sm:flex-nowrap">
        {actions}

        <button
          type="button"
          onClick={onClearSelection}
          className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/80 hover:text-white transition-colors cursor-pointer"
          title={t('common.clearSelection')}
        
          aria-label={t('common.clearSelection')}>
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
