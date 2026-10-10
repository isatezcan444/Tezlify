import * as React from "react";
import { cn } from "../../lib/utils";
import { WhatsAppRepository } from "../../features/whatsapp/data/whatsappRepository";
import { resolveMediaUrl } from "../../lib/mediaUrl";

export interface AvatarProps {
  name: string;
  image?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  shape?: "circle" | "rounded";
  status?: "online" | "offline" | "busy" | "away";
  className?: string;
  phone?: string;
  priority?: "high" | "normal" | "low";
  onRefresh?: (newUrl: string) => void;
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
export const inFlightAvatarRefreshes = new Set<string>();
export const negativeAvatarPhones = new Map<string, number>();

// Phase 22 (Rule 4) & Phase 24: Global cache of successfully resolved/active avatar URLs by phone/JID
export const resolvedAvatarCache = new Map<string, string>();

const AVATAR_SESSION_CACHE_KEY = 'tezlify_avatar_cache';

export function loadAvatarSessionCache(): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    const raw = window.sessionStorage.getItem(AVATAR_SESSION_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v) {
          resolvedAvatarCache.set(k, v);
        }
      }
    }
  } catch {
    /* sessionStorage disabled or unparseable */
  }
}

export function saveAvatarToSessionCache(phoneKey: string, url: string): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    const raw = window.sessionStorage.getItem(AVATAR_SESSION_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    parsed[phoneKey] = url;
    window.sessionStorage.setItem(AVATAR_SESSION_CACHE_KEY, JSON.stringify(parsed));
  } catch {
    /* sessionStorage quota or disabled */
  }
}

loadAvatarSessionCache();

// Phase 22: Observability metrics for avatar lifecycle
export const avatarMetrics = {
  avatar_request_started: 0,
  avatar_request_succeeded: 0,
  avatar_request_failed: 0,
  avatar_cache_hit: 0,
  avatar_url_preserved_after_empty_update: 0,
  avatar_duplicate_request_suppressed: 0,
  avatar_retry_scheduled: 0,
  reset() {
    this.avatar_request_started = 0;
    this.avatar_request_succeeded = 0;
    this.avatar_request_failed = 0;
    this.avatar_cache_hit = 0;
    this.avatar_url_preserved_after_empty_update = 0;
    this.avatar_duplicate_request_suppressed = 0;
    this.avatar_retry_scheduled = 0;
  },
};

// Bounded concurrency queue for avatar refresh requests (max 2 in-flight)
const MAX_CONCURRENT_AVATAR_REFRESHES = 2;
let activeAvatarRefreshes = 0;
const avatarRefreshQueue: Array<() => void> = [];

function pumpAvatarRefreshQueue() {
  while (activeAvatarRefreshes < MAX_CONCURRENT_AVATAR_REFRESHES && avatarRefreshQueue.length > 0) {
    const task = avatarRefreshQueue.shift();
    if (task) {
      activeAvatarRefreshes++;
      task();
    }
  }
}

export function queueAvatarRefresh(task: () => Promise<void>, priority: 'high' | 'normal' | 'low' = 'normal') {
  const run = () => {
    task().finally(() => {
      activeAvatarRefreshes = Math.max(0, activeAvatarRefreshes - 1);
      pumpAvatarRefreshQueue();
    });
  };
  if (priority === 'high') {
    avatarRefreshQueue.unshift(run);
  } else {
    avatarRefreshQueue.push(run);
  }
  pumpAvatarRefreshQueue();
}

export const clearFailedAvatarUrlsCache = () => {
  failedAvatarUrls.clear();
  inFlightAvatarRefreshes.clear();
  negativeAvatarPhones.clear();
  resolvedAvatarCache.clear();
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.removeItem(AVATAR_SESSION_CACHE_KEY);
    }
  } catch {
    /* ignore */
  }
  avatarMetrics.reset();
  avatarRefreshQueue.length = 0;
  activeAvatarRefreshes = 0;
};

export const Avatar: React.FC<AvatarProps> = ({
  name,
  image,
  size = "md",
  shape = "rounded",
  status,
  className,
  phone,
  priority = "normal",
  onRefresh,
}) => {
  const resolved = React.useMemo(() => resolveMediaUrl(image), [image]);
  const cached = phone ? resolvedAvatarCache.get(phone) : undefined;
  const initialEffective = resolved || cached;

  const [currentImage, setCurrentImage] = React.useState<string | undefined>(() => {
    if (initialEffective && !failedAvatarUrls.has(initialEffective)) {
      if (!resolved && cached) avatarMetrics.avatar_cache_hit++;
      return initialEffective;
    }
    return undefined;
  });

  const [imageError, setImageError] = React.useState<boolean>(() => {
    return initialEffective ? failedAvatarUrls.has(initialEffective) : false;
  });

  const [isImageLoaded, setIsImageLoaded] = React.useState<boolean>(() => {
    return Boolean(initialEffective && !failedAvatarUrls.has(initialEffective));
  });

  React.useEffect(() => {
    if (resolved) {
      if (phone) {
        resolvedAvatarCache.set(phone, resolved);
        saveAvatarToSessionCache(phone, resolved);
      }
      setCurrentImage((prev) => {
        if (prev !== resolved) {
          setIsImageLoaded(false);
          setImageError(failedAvatarUrls.has(resolved));
          return resolved;
        }
        return prev;
      });
    } else if (phone && resolvedAvatarCache.has(phone)) {
      // Phase 22 (Rule 1 & 2): Incoming prop is empty/undefined, but we already have
      // a verified avatar URL in the client cache — preserve it!
      avatarMetrics.avatar_url_preserved_after_empty_update++;
      const cachedUrl = resolvedAvatarCache.get(phone);
      setCurrentImage((prev) => {
        if (prev !== cachedUrl) {
          setIsImageLoaded(Boolean(cachedUrl));
          setImageError(cachedUrl ? failedAvatarUrls.has(cachedUrl) : false);
          return cachedUrl;
        }
        return prev;
      });
    } else {
      setCurrentImage(undefined);
      setIsImageLoaded(false);
      setImageError(false);
    }
  }, [resolved, phone]);

  const fetchAvatar = React.useCallback((force: boolean = false) => {
    if (!phone) return;
    if (inFlightAvatarRefreshes.has(phone)) {
      avatarMetrics.avatar_duplicate_request_suppressed++;
      return;
    }
    const negativeExpiry = negativeAvatarPhones.get(phone) || 0;
    if (!force && Date.now() < negativeExpiry) return;

    avatarMetrics.avatar_request_started++;
    inFlightAvatarRefreshes.add(phone);
    queueAvatarRefresh(async () => {
      try {
        const res = await WhatsAppRepository.refreshAvatar(phone, priority);
        if (res.success && res.avatar_url) {
          avatarMetrics.avatar_request_succeeded++;
          const nextResolved = resolveMediaUrl(res.avatar_url) || res.avatar_url;
          if (phone) {
            resolvedAvatarCache.set(phone, nextResolved);
            saveAvatarToSessionCache(phone, nextResolved);
          }
          failedAvatarUrls.delete(nextResolved);
          negativeAvatarPhones.delete(phone);
          setCurrentImage(nextResolved);
          setIsImageLoaded(true);
          setImageError(false);
          onRefresh?.(res.avatar_url);
        } else {
          avatarMetrics.avatar_request_failed++;
          negativeAvatarPhones.set(phone, Date.now() + 10 * 60 * 1000);
        }
      } catch (err) {
        avatarMetrics.avatar_request_failed++;
        negativeAvatarPhones.set(phone, Date.now() + 2 * 60 * 1000);
        console.debug("[Avatar] Refresh attempt failed:", err);
      } finally {
        inFlightAvatarRefreshes.delete(phone);
      }
    }, priority);
  }, [phone, priority, onRefresh]);

  const handleImageError = React.useCallback(() => {
    avatarMetrics.avatar_retry_scheduled++;
    if (currentImage) failedAvatarUrls.add(currentImage);
    setImageError(true);
    setIsImageLoaded(false);
    fetchAvatar(true);
  }, [currentImage, fetchAvatar]);

  // Proactive hydration: when priority === 'high' and avatar URL is missing, request immediately
  React.useEffect(() => {
    if (!currentImage && phone && priority === 'high') {
      fetchAvatar(false);
    }
  }, [currentImage, phone, priority, fetchAvatar]);

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
  const shouldRenderImage = Boolean(currentImage && !imageError && !failedAvatarUrls.has(currentImage));

  return (
    <div className="relative inline-flex shrink-0">
      <div
        className={cn(
          "relative flex items-center justify-center font-bold tracking-wider select-none overflow-hidden aspect-square border border-black/5 dark:border-white/10 transition-transform",
          sizeClasses[size],
          shapeClasses[shape],
          colorClass,
          className
        )}
      >
        <span
          className={cn(
            "transition-opacity duration-300 ease-in-out select-none",
            shouldRenderImage && isImageLoaded ? "opacity-0" : "opacity-100"
          )}
        >
          {initials}
        </span>
        {shouldRenderImage && (
          <img
            key={currentImage}
            src={currentImage}
            alt={name}
            loading={priority === 'high' ? 'eager' : 'lazy'}
            decoding="async"
            onLoad={() => setIsImageLoaded(true)}
            onError={handleImageError}
            className={cn(
              "absolute inset-0 w-full h-full object-cover aspect-square block transition-opacity duration-300 ease-in-out",
              isImageLoaded ? "opacity-100" : "opacity-0"
            )}
          />
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
