import { AntiBanConfig } from '../types';
export type { AntiBanConfig };

export const ANTI_BAN_PRESETS: Record<'ultra_safe' | 'standard_balanced' | 'fast_warmed', Omit<AntiBanConfig, 'preset' | 'updated_at'>> = {
  // Ultra Safe: For newly registered WhatsApp accounts (< 1 month)
  ultra_safe: {
    min_delay_seconds: 60,
    max_delay_seconds: 150,
    typing_delay_seconds: 5,
    daily_message_limit: 35,
    working_hours_enabled: true,
    working_hours_start: '09:00',
    working_hours_end: '18:00',
  },
  // Standard Balanced (Recommended Default): Zero-ban algorithm compliance with corporate working hours
  standard_balanced: {
    min_delay_seconds: 45,
    max_delay_seconds: 120,
    typing_delay_seconds: 4,
    daily_message_limit: 50,
    working_hours_enabled: true,
    working_hours_start: '09:00',
    working_hours_end: '18:30',
  },
  // Fast: Only for heavily warmed-up and established WhatsApp Business numbers (> 6 months)
  fast_warmed: {
    min_delay_seconds: 20,
    max_delay_seconds: 60,
    typing_delay_seconds: 2,
    daily_message_limit: 100,
    working_hours_enabled: true,
    working_hours_start: '08:30',
    working_hours_end: '19:00',
  }
};

const STORAGE_KEY = 'tezlify_anti_ban_config';

export const DEFAULT_ANTI_BAN_CONFIG: AntiBanConfig = {
  preset: 'standard_balanced',
  ...ANTI_BAN_PRESETS.standard_balanced
};

/**
 * Resolves the preset name ('ultra_safe', 'standard_balanced', 'fast_warmed', or 'custom')
 * by comparing actual numerical values and working hours against known presets.
 */
export const resolvePresetFromConfig = (config: Partial<AntiBanConfig>): string => {
  for (const [key, presetObj] of Object.entries(ANTI_BAN_PRESETS)) {
    if (
      config.min_delay_seconds === presetObj.min_delay_seconds &&
      config.max_delay_seconds === presetObj.max_delay_seconds &&
      config.typing_delay_seconds === presetObj.typing_delay_seconds &&
      config.daily_message_limit === presetObj.daily_message_limit &&
      Boolean(config.working_hours_enabled) === Boolean(presetObj.working_hours_enabled) &&
      config.working_hours_start === presetObj.working_hours_start &&
      config.working_hours_end === presetObj.working_hours_end
    ) {
      return key;
    }
  }
  return config.preset || 'custom';
};

/**
 * Loads Anti-Ban configuration from localStorage cache with backward-compatible key normalization.
 */
export const getStoredAntiBanConfig = (): AntiBanConfig => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const normalized: AntiBanConfig = {
        preset: parsed.preset || DEFAULT_ANTI_BAN_CONFIG.preset,
        min_delay_seconds: parsed.min_delay_seconds ?? parsed.minDelaySeconds ?? DEFAULT_ANTI_BAN_CONFIG.min_delay_seconds,
        max_delay_seconds: parsed.max_delay_seconds ?? parsed.maxDelaySeconds ?? DEFAULT_ANTI_BAN_CONFIG.max_delay_seconds,
        typing_delay_seconds: parsed.typing_delay_seconds ?? parsed.typingDelaySeconds ?? DEFAULT_ANTI_BAN_CONFIG.typing_delay_seconds,
        daily_message_limit: parsed.daily_message_limit ?? parsed.dailyMessageLimit ?? DEFAULT_ANTI_BAN_CONFIG.daily_message_limit,
        working_hours_enabled: parsed.working_hours_enabled ?? parsed.workingHoursEnabled ?? DEFAULT_ANTI_BAN_CONFIG.working_hours_enabled,
        working_hours_start: parsed.working_hours_start || parsed.workingHoursStart || DEFAULT_ANTI_BAN_CONFIG.working_hours_start,
        working_hours_end: parsed.working_hours_end || parsed.workingHoursEnd || DEFAULT_ANTI_BAN_CONFIG.working_hours_end,
      };
      normalized.preset = resolvePresetFromConfig(normalized);
      return normalized;
    }
  } catch (e) {
    console.warn('Failed to load anti-ban config from storage:', e);
  }
  return DEFAULT_ANTI_BAN_CONFIG;
};

/**
 * Saves Anti-Ban configuration to local cache.
 */
export const saveAntiBanConfig = (config: AntiBanConfig): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (e) {
    console.warn('Failed to save anti-ban config to storage:', e);
  }
};

/**
 * Compares two AntiBanConfig instances to check if there are actual configuration changes.
 */
export const isConfigEqual = (a: AntiBanConfig, b: AntiBanConfig): boolean => {
  return (
    a.preset === b.preset &&
    a.min_delay_seconds === b.min_delay_seconds &&
    a.max_delay_seconds === b.max_delay_seconds &&
    a.typing_delay_seconds === b.typing_delay_seconds &&
    a.daily_message_limit === b.daily_message_limit &&
    Boolean(a.working_hours_enabled) === Boolean(b.working_hours_enabled) &&
    a.working_hours_start === b.working_hours_start &&
    a.working_hours_end === b.working_hours_end
  );
};

export interface RiskEvaluation {
  score: number;
  level: 'safe' | 'moderate' | 'high';
  title: string;
  desc: string;
  color: string;
  badgeBg: string;
  badgeText: string;
}

/**
 * Evaluates real-time risk index (0 to 100) based on jitter timing and volume limits.
 */
export const calculateRiskLevel = (minDelay: number, dailyLimit: number): RiskEvaluation => {
  // Score: 0 (Ultra Safe) to 100 (Maximum Risk)
  const delayRisk = Math.max(0, Math.min(100, ((60 - minDelay) / 50) * 100));
  const limitRisk = Math.max(0, Math.min(100, ((dailyLimit - 30) / 120) * 100));
  const score = Math.round((delayRisk * 0.55) + (limitRisk * 0.45));

  if (score >= 65 || minDelay < 20 || dailyLimit > 120) {
    return {
      score: Math.max(70, Math.min(95, score)),
      level: 'high',
      title: 'Yüksek Ban Riski',
      desc: 'Çok kısa gecikmeler veya yüksek günlük limitler WhatsApp spam filtrelerini ve kullanıcı şikayetlerini tetikleyebilir.',
      color: '#EA5455',
      badgeBg: 'bg-rose-50 dark:bg-rose-500/15 border-rose-200 dark:border-rose-500/30',
      badgeText: 'text-[#EA5455]'
    };
  }
  
  if (score >= 35 || minDelay < 40 || dailyLimit > 70) {
    return {
      score: Math.max(35, Math.min(64, score)),
      level: 'moderate',
      title: 'Orta Düzey Risk (Isınmış Hatlar)',
      desc: 'Bu ayar yalnızca en az 3-6 aydır düzenli kullanılan ve ısınmış WhatsApp Business hatları için tavsiye edilir.',
      color: '#FF9F43',
      badgeBg: 'bg-amber-50 dark:bg-amber-500/15 border-amber-200 dark:border-amber-500/30',
      badgeText: 'text-[#FF9F43]'
    };
  }

  return {
    score: Math.max(8, Math.min(34, score)),
    level: 'safe',
    title: 'Düşük Risk (Maksimum Güvenlik)',
    desc: 'Gaussian Jitter ve doğal insan bekleme süreleriyle WhatsApp algoritmalarına ve güvenlik kurallarına %100 uyumludur.',
    color: '#28C76F',
    badgeBg: 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-200 dark:border-emerald-500/30',
    badgeText: 'text-[#28C76F]'
  };
};
