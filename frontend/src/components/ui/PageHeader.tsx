import React from 'react';
import { LucideIcon } from 'lucide-react';
import { IconTile } from './IconTile';
import { cn } from '../../lib/utils';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  icon: Icon,
  badge,
  actions,
  className,
}) => {
  return (
    <div className={cn('flex flex-col lg:flex-row lg:items-center justify-between gap-4 select-none', className)}>
      <div className="space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          {Icon && <IconTile icon={Icon} size="sm" tone="primary" />}
          <h2 className="text-lg sm:text-xl font-bold text-slate-800 dark:text-white tracking-tight">
            {title}
          </h2>
          {badge}
        </div>
        {subtitle && (
          <p className="text-xs text-slate-500 dark:text-vuexy-dark-muted font-medium leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>

      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {actions}
        </div>
      )}
    </div>
  );
};
