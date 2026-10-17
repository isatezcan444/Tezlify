import type { CSSProperties } from 'react';

export type WallpaperThemeId =
  | 'whatsapp_default'
  | 'midnight_blue'
  | 'emerald'
  | 'warm_sand'
  | 'charcoal'
  | 'soft_lilac';

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
 * Returns complete CSS properties for rendering the clean WhatsApp wallpaper background.
 */
export function getChatWallpaperStyle(params: {
  themeId: WallpaperThemeId;
  isDark?: boolean;
}): CSSProperties {
  const { themeId, isDark = false } = params;
  const theme = WALLPAPER_THEMES.find((t) => t.id === themeId) || WALLPAPER_THEMES[0];
  const bgColor = isDark ? theme.darkBg : theme.lightBg;

  return {
    backgroundColor: bgColor,
  };
}
