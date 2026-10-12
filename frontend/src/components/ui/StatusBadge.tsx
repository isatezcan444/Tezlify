import * as React from "react";
import { cn } from "../../lib/utils";
import { useI18n } from "../../context/I18nContext";

export type StatusVariant = 
  | "active" 
  | "online" 
  | "offline" 
  | "pending" 
  | "completed" 
  | "failed" 
  | "danger" 
  | "warning" 
  | "info" 
  | "neutral";

export interface StatusBadgeProps {
  status: StatusVariant;
  label?: string;
  pulse?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  label,
  pulse = false,
  size = "md",
  className,
}) => {
  const { t } = useI18n();
  const styles: Record<StatusVariant, { badge: string; dot: string; labelKey: string }> = {
    active: {
      badge: "bg-[#28C76F]/15 text-[#28C76F] border-[#28C76F]/25 dark:bg-[#28C76F]/20 dark:text-[#28C76F]",
      dot: "bg-[#28C76F]",
      labelKey: "common.statusActive",
    },
    online: {
      badge: "bg-[#28C76F]/15 text-[#28C76F] border-[#28C76F]/25 dark:bg-[#28C76F]/20 dark:text-[#28C76F]",
      dot: "bg-[#28C76F]",
      labelKey: "common.statusOnline",
    },
    offline: {
      badge: "bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/[0.06] dark:text-slate-400 dark:border-white/[0.08]",
      dot: "bg-slate-400",
      labelKey: "common.statusOffline",
    },
    pending: {
      badge: "bg-[#FF9F43]/15 text-[#FF9F43] border-[#FF9F43]/25 dark:bg-[#FF9F43]/20 dark:text-[#FF9F43]",
      dot: "bg-[#FF9F43]",
      labelKey: "common.statusPending",
    },
    completed: {
      badge: "bg-[#7367F0]/15 text-[#7367F0] border-[#7367F0]/25 dark:bg-[#7367F0]/20 dark:text-[#A59DF8]",
      dot: "bg-[#7367F0]",
      labelKey: "common.statusCompleted",
    },
    failed: {
      badge: "bg-[#EA5455]/15 text-[#EA5455] border-[#EA5455]/25 dark:bg-[#EA5455]/20 dark:text-[#EA5455]",
      dot: "bg-[#EA5455]",
      labelKey: "common.statusFailed",
    },
    danger: {
      badge: "bg-[#EA5455]/15 text-[#EA5455] border-[#EA5455]/25 dark:bg-[#EA5455]/20 dark:text-[#EA5455]",
      dot: "bg-[#EA5455]",
      labelKey: "common.statusDanger",
    },
    warning: {
      badge: "bg-[#FF9F43]/15 text-[#FF9F43] border-[#FF9F43]/25 dark:bg-[#FF9F43]/20 dark:text-[#FF9F43]",
      dot: "bg-[#FF9F43]",
      labelKey: "common.statusWarning",
    },
    info: {
      badge: "bg-[#00CFE8]/15 text-[#00CFE8] border-[#00CFE8]/25 dark:bg-[#00CFE8]/20 dark:text-[#00CFE8]",
      dot: "bg-[#00CFE8]",
      labelKey: "common.statusInfo",
    },
    neutral: {
      badge: "bg-slate-100 text-slate-600 border-slate-200 dark:bg-white/[0.06] dark:text-slate-300 dark:border-white/[0.08]",
      dot: "bg-slate-400",
      labelKey: "common.statusNeutral",
    },
  };

  const current = styles[status] || styles.neutral;
  const displayText = label || t(current.labelKey);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-semibold tracking-normal rounded-full border transition-colors select-none",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-[11px]",
        current.badge,
        className
      )}
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        {pulse && (
          <span
            className={cn(
              "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
              current.dot
            )}
          />
        )}
        <span className={cn("relative inline-flex rounded-full h-1.5 w-1.5", current.dot)} />
      </span>
      <span className="truncate">{displayText}</span>
    </span>
  );
};
