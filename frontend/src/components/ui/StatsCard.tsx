import React from 'react';
import { LucideIcon } from 'lucide-react';
import { Card, CardContent } from './card';
import { Badge } from './badge';
import { IconTile } from './IconTile';
import { cn } from '../../lib/utils';

export type StatIconVariant = 'primary' | 'success' | 'danger' | 'warning' | 'info' | 'secondary';

export interface StatsCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  iconVariant?: StatIconVariant;
  badge?: {
    text: string;
    variant?: 'primary' | 'success' | 'danger' | 'warning' | 'info' | 'default';
  };
  subText?: string;
  className?: string;
  onClick?: () => void;
}

export const StatsCard: React.FC<StatsCardProps> = ({
  title,
  value,
  icon: Icon,
  iconVariant = 'primary',
  badge,
  subText,
  className,
  onClick,
}) => {
  const strVal = String(value ?? '');
  const isLongVal = strVal.length > 13;

  return (
    <Card
      onClick={onClick}
      className={cn(
        'h-full flex flex-col justify-between transition-all duration-200 select-none group border-slate-200/80 dark:border-white/[0.06] bg-white dark:bg-[#2F3349]',
        onClick ? 'cursor-pointer hover:shadow-md hover:border-vuexy-primary/30' : 'hover:shadow-xs',
        className
      )}
    >
      <CardContent className="p-4 sm:p-5 flex flex-col justify-between h-full flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span
              className="text-[10px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block leading-snug truncate"
              title={title}
            >
              {title}
            </span>
            <div
              className={cn(
                'font-bold text-slate-800 dark:text-white tracking-tight mt-1.5',
                isLongVal ? 'text-base sm:text-lg leading-snug' : 'text-xl sm:text-2xl'
              )}
            >
              {value}
            </div>
          </div>
          <IconTile
            icon={Icon}
            size="md"
            tone={iconVariant}
            className="transition-transform group-hover:scale-105 shrink-0 mt-0.5"
          />
        </div>

        {(badge || subText) && (
          <div className="mt-3.5 pt-2.5 border-t border-slate-100 dark:border-white/[0.04] flex flex-col justify-end gap-1.5">
            {badge && (
              <div className="min-h-[20px] flex items-center">
                <Badge
                  variant={badge.variant || 'success'}
                  className="text-[10px] font-semibold px-2 py-0.5 whitespace-nowrap inline-flex"
                >
                  {badge.text}
                </Badge>
              </div>
            )}
            {subText && (
              <p
                className="text-slate-400 dark:text-[#7E7F96] text-[11px] font-normal leading-relaxed line-clamp-2"
                title={subText}
              >
                {subText}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
