import type { CSSProperties } from 'react';

export type WallpaperThemeId =
  | 'whatsapp_default'
  | 'midnight_blue'
  | 'emerald'
  | 'warm_sand'
  | 'charcoal'
  | 'soft_lilac'
  | 'custom';

export interface WallpaperThemeMeta {
  id: WallpaperThemeId;
  nameKey: string;
  lightBg: string;
  darkBg: string;
  previewColor: string;
}

export const WALLPAPER_THEMES: WallpaperThemeMeta[] = [
  {
    id: 'whatsapp_default',
    nameKey: 'whatsapp.wallpaperDefault',
    lightBg: '#efeae2',
    darkBg: '#0b141a',
    previewColor: '#00a884',
  },
  {
    id: 'midnight_blue',
    nameKey: 'whatsapp.wallpaperMidnight',
    lightBg: '#f0f4f8',
    darkBg: '#0f172a',
    previewColor: '#3b82f6',
  },
  {
    id: 'emerald',
    nameKey: 'whatsapp.wallpaperEmerald',
    lightBg: '#ecfdf5',
    darkBg: '#062e24',
    previewColor: '#10b981',
  },
  {
    id: 'warm_sand',
    nameKey: 'whatsapp.wallpaperSand',
    lightBg: '#fbf7ee',
    darkBg: '#1c1917',
    previewColor: '#f59e0b',
  },
  {
    id: 'charcoal',
    nameKey: 'whatsapp.wallpaperCharcoal',
    lightBg: '#f1f5f9',
    darkBg: '#181b20',
    previewColor: '#64748b',
  },
  {
    id: 'soft_lilac',
    nameKey: 'whatsapp.wallpaperLilac',
    lightBg: '#f5f3ff',
    darkBg: '#1e1329',
    previewColor: '#8b5cf6',
  },
];

/**
 * Curated quick-select color swatches for the custom palette picker.
 */
export const QUICK_PALETTE_COLORS = [
  '#0b141a', // WhatsApp Dark
  '#111b21', // WhatsApp Panel Dark
  '#0f172a', // Slate 900
  '#1e293b', // Slate 800
  '#18181b', // Zinc 900
  '#052e16', // Deep Forest Green
  '#172554', // Deep Blue
  '#2e1065', // Deep Purple
  '#efeae2', // WhatsApp Classic Light
  '#f8fafc', // Slate 50
  '#ecfdf5', // Emerald 50
  '#fef3c7', // Warm Amber 100
];

/**
 * Returns complete CSS properties for rendering the clean WhatsApp wallpaper background.
 */
export function getChatWallpaperStyle(params: {
  themeId: WallpaperThemeId;
  customColor?: string;
  isDark?: boolean;
}): CSSProperties {
  const { themeId, customColor, isDark = false } = params;

  if (themeId === 'custom' && customColor) {
    return {
      backgroundColor: customColor,
    };
  }

  const theme = WALLPAPER_THEMES.find((t) => t.id === themeId) || WALLPAPER_THEMES[0];
  const bgColor = isDark ? theme.darkBg : theme.lightBg;

  if (themeId === 'whatsapp_default') {
    return {
      backgroundColor: bgColor,
      backgroundImage: isDark
        ? 'radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.035) 1px, transparent 1px), radial-gradient(circle at 0% 0%, rgba(255, 255, 255, 0.02) 1.5px, transparent 1.5px)'
        : 'radial-gradient(circle at 50% 50%, rgba(0, 0, 0, 0.04) 1px, transparent 1px), radial-gradient(circle at 0% 0%, rgba(0, 0, 0, 0.02) 1.5px, transparent 1.5px)',
      backgroundSize: '24px 24px, 48px 48px',
    };
  }

  return {
    backgroundColor: bgColor,
  };
}
