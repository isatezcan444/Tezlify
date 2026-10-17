import * as React from 'react';
import { RotateCcw } from 'lucide-react';
import { Chip } from '../ui/Chip';
import { cn } from '../../lib/utils';
import { useI18n } from '../../context/I18nContext';

export interface ActiveFilterChip {
  id: string;
  label: string;
  onRemove: () => void;
  variant?: 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'default';
}

export interface TableToolbarProps {
  searchSlot?: React.ReactNode;
  filtersSlot?: React.ReactNode;
  actionsSlot?: React.ReactNode;
  activeChips?: ActiveFilterChip[];
  onResetFilters?: () => void;
  resetLabel?: string;
  className?: string;
}

export const TableToolbar: React.FC<TableToolbarProps> = ({
  searchSlot,
  filtersSlot,
  actionsSlot,
  activeChips = [],
  onResetFilters,
  resetLabel,
  className,
}) => {
  const { t } = useI18n();
  const resolvedResetLabel = resetLabel ?? t('common.resetFilters');
  const hasChips = activeChips.length > 0;

  return (
    <div className={cn('space-y-3.5', className)}>
      {/* Primary Row: Search, Filters, and Action Triggers */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          {searchSlot && <div className="w-full sm:w-72 lg:w-80 shrink-0">{searchSlot}</div>}
          {filtersSlot && <div className="flex-1 flex items-center gap-2 flex-wrap">{filtersSlot}</div>}
        </div>

        {actionsSlot && (
          <div className="flex items-center space-x-2 shrink-0 self-start sm:self-auto flex-wrap gap-2">
            {actionsSlot}
          </div>
        )}
      </div>

      {/* Active Filter Chips Secondary Bar */}
      {hasChips && (
        <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-slate-100 dark:border-white/[0.05] animate-fade-in">
          <div className="flex items-center gap-1.5 flex-wrap">
            {activeChips.map((chip) => (
              <Chip
                key={chip.id}
                label={chip.label}
                onRemove={chip.onRemove}
                variant={chip.variant || 'primary'}
                size="sm"
              />
            ))}
          </div>

          {onResetFilters && (
            <button
              type="button"
              onClick={onResetFilters}
              className="text-xs font-bold text-slate-400 hover:text-[#EA5455] flex items-center gap-1 shrink-0 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>{resolvedResetLabel}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
