import * as React from "react";
import { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon | React.ComponentType<{ className?: string }>;
  variant?: "default" | "outline" | "ghost" | "danger" | "warning" | "success" | "primary";
  size?: "xs" | "sm" | "md" | "lg";
  tooltip?: string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, icon: Icon, variant = "ghost", size = "sm", tooltip, title, ...props }, ref) => {
    const sizeClasses = {
      xs: "w-7 h-7 p-1 text-xs",
      sm: "w-8 h-8 p-1.5 text-xs",
      md: "w-9 h-9 p-2 text-sm",
      lg: "w-10 h-10 p-2.5 text-base",
    };

    const variantClasses = {
      default: "bg-slate-100 dark:bg-white/[0.06] text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-white/[0.1]",
      outline: "border border-slate-200 dark:border-white/[0.1] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04]",
      ghost: "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06]",
      primary: "text-[#7367F0] hover:bg-[#7367F0]/10 dark:hover:bg-[#7367F0]/20",
      danger: "text-[#EA5455] hover:bg-[#EA5455]/10 dark:hover:bg-[#EA5455]/20",
      warning: "text-[#FF9F43] hover:bg-[#FF9F43]/10 dark:hover:bg-[#FF9F43]/20",
      success: "text-[#28C76F] hover:bg-[#28C76F]/10 dark:hover:bg-[#28C76F]/20",
    };

    return (
      <button
        ref={ref}
        type="button"
        title={tooltip || title}
        className={cn(
          "inline-flex items-center justify-center rounded-lg transition-all duration-150 active:scale-95 disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
          sizeClasses[size],
          variantClasses[variant],
          className
        )}
        {...props}
      
        aria-label={tooltip || title}>
        <Icon className="w-full h-full stroke-[2.2]" />
      </button>
    );
  }
);

IconButton.displayName = "IconButton";
