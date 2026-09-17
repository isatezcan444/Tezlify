import * as React from "react";
import { cn } from "../../lib/utils";

export interface AvatarProps {
  name: string;
  image?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  shape?: "circle" | "rounded";
  status?: "online" | "offline" | "busy" | "away";
  className?: string;
}

// Generate consistent background color based on name string
const getAvatarColor = (name: string) => {
  const colors = [
    "bg-[#7367F0]/15 text-[#7367F0]",
    "bg-[#28C76F]/15 text-[#28C76F]",
    "bg-[#EA5455]/15 text-[#EA5455]",
    "bg-[#FF9F43]/15 text-[#FF9F43]",
    "bg-[#00CFE8]/15 text-[#00CFE8]",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

const getInitials = (name: string) => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// Global cache of failed/expired image URLs to prevent repeated network failure storms
export const failedAvatarUrls = new Set<string>();

export const clearFailedAvatarUrlsCache = () => {
  failedAvatarUrls.clear();
};

export const Avatar: React.FC<AvatarProps> = ({
  name,
  image,
  size = "md",
  shape = "rounded",
  status,
  className,
}) => {
  const [imageError, setImageError] = React.useState<boolean>(() => {
    return image ? failedAvatarUrls.has(image) : false;
  });

  React.useEffect(() => {
    setImageError(image ? failedAvatarUrls.has(image) : false);
  }, [image]);

  const sizeClasses = {
    xs: "w-6 h-6 text-[10px]",
    sm: "w-8 h-8 text-xs",
    md: "w-9 h-9 text-xs",
    lg: "w-11 h-11 text-sm font-bold",
    xl: "w-14 h-14 text-base font-extrabold",
  };

  const shapeClasses = {
    circle: "rounded-full",
    rounded: "rounded-xl",
  };

  const statusDotColors = {
    online: "bg-[#28C76F]",
    offline: "bg-slate-400",
    busy: "bg-[#EA5455]",
    away: "bg-[#FF9F43]",
  };

  const colorClass = getAvatarColor(name);
  const initials = getInitials(name);
  const shouldRenderImage = Boolean(image && !imageError && !failedAvatarUrls.has(image));

  return (
    <div className="relative inline-flex shrink-0">
      <div
        className={cn(
          "flex items-center justify-center font-bold tracking-wider select-none overflow-hidden aspect-square border border-black/5 dark:border-white/10 transition-transform",
          sizeClasses[size],
          shapeClasses[shape],
          colorClass,
          className
        )}
      >
        {shouldRenderImage ? (
          <img
            src={image}
            alt={name}
            loading="lazy"
            decoding="async"
            onError={() => {
              if (image) failedAvatarUrls.add(image);
              setImageError(true);
            }}
            className="w-full h-full object-cover aspect-square block"
          />
        ) : (
          <span>{initials}</span>
        )}
      </div>

      {status && (
        <span
          className={cn(
            "absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-[#2F3349]",
            statusDotColors[status]
          )}
        />
      )}
    </div>
  );
};
