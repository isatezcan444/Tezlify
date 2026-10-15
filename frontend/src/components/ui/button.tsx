import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-xs font-semibold ring-offset-background transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7367F0] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-[#7367F0] text-white hover:bg-[#685DD8] shadow-xs hover:shadow-md hover:shadow-[#7367F0]/30 font-bold",
        success:
          "bg-[#28C76F] text-white hover:bg-[#24B263] shadow-xs hover:shadow-md hover:shadow-[#28C76F]/30 font-bold",
        destructive:
          "bg-[#EA5455] text-white hover:bg-[#D43D3E] shadow-xs hover:shadow-md hover:shadow-[#EA5455]/30 font-bold",
        warning:
          "bg-[#FF9F43] text-white hover:bg-[#E58A32] shadow-xs hover:shadow-md hover:shadow-[#FF9F43]/30 font-bold",
        outline:
          "border border-slate-200 dark:border-white/[0.12] bg-white dark:bg-[#2F3349] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-[#363B53] hover:border-slate-300 dark:hover:border-white/[0.2]",
        secondary:
          "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700",
        ghost:
          "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05]",
        link: "text-[#7367F0] underline-offset-4 hover:underline",
        label:
          "bg-[#7367F0]/10 text-[#7367F0] hover:bg-[#7367F0]/20 font-bold",
      },
      size: {
        default: "h-9 px-3.5 py-1.5 rounded-lg",
        sm: "h-8 rounded-lg px-3 text-xs",
        md: "h-9.5 px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold",
        action: "h-9.5 px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold",
        lg: "h-10 rounded-xl px-4.5 py-2 text-sm font-bold",
        hero: "h-10.5 rounded-xl px-5 py-2.5 text-sm font-bold",
        touch: "min-h-[38px] px-3.5 py-2 rounded-lg text-xs font-semibold",
        icon: "h-9 w-9 rounded-lg p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
