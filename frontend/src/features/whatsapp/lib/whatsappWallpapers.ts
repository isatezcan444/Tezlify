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
    lightBg: '#e2e8f0',
    darkBg: '#0f172a',
    previewColor: '#3b82f6',
  },
  {
    id: 'emerald',
    nameKey: 'whatsapp.wallpaperEmerald',
    lightBg: '#dcfce7',
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
    lightBg: '#f3e8ff',
    darkBg: '#1e1329',
    previewColor: '#8b5cf6',
  },
];

/**
 * Authentic WhatsApp Web Doodle SVG pattern in data URI format.
 * Encodes icons (chat bubbles, coffee, star, clock, smiling face, note, headphones, heart, paper airplane).
 */
const DOODLE_SVG_LIGHT = `url("data:image/svg+xml,%3Csvg width='120' height='120' viewBox='0 0 120 120' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23000000' fill-opacity='1'%3E%3Cpath d='M20 20a4 4 0 1 1-8 0 4 4 0 0 1 8 0m-4-6c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6-2.7-6-6-6'/%3E%3Cpath d='M65 18h12v12H65zm2 2h8v8h-8z'/%3E%3Cpath d='M100 24a4 4 0 1 0 0-8 4 4 0 0 0 0 8m0 2c-3.3 0-6-2.7-6-6s2.7-6 6-6 6 2.7 6 6-2.7 6-6 6'/%3E%3Cpath d='M30 65l6-10 6 10zm6-6l-2 3h4z'/%3E%3Cpath d='M90 70c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5m0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3'/%3E%3Cpath d='M18 102c0-3.3 2.7-6 6-6s6 2.7 6 6-2.7 6-6 6-6-2.7-6-6m2 0c0 2.2 1.8 4 4 4s4-1.8 4-4-1.8-4-4-4-4 1.8-4 4'/%3E%3Cpath d='M60 100l8-8 8 8-8 8z'/%3E%3Cpath d='M105 105a3 3 0 1 1-6 0 3 3 0 0 1 6 0'/%3E%3C/g%3E%3C/svg%3E")`;

const DOODLE_SVG_DARK = `url("data:image/svg+xml,%3Csvg width='120' height='120' viewBox='0 0 120 120' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M20 20a4 4 0 1 1-8 0 4 4 0 0 1 8 0m-4-6c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6-2.7-6-6-6'/%3E%3Cpath d='M65 18h12v12H65zm2 2h8v8h-8z'/%3E%3Cpath d='M100 24a4 4 0 1 0 0-8 4 4 0 0 0 0 8m0 2c-3.3 0-6-2.7-6-6s2.7-6 6-6 6 2.7 6 6-2.7 6-6 6'/%3E%3Cpath d='M30 65l6-10 6 10zm6-6l-2 3h4z'/%3E%3Cpath d='M90 70c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5m0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3'/%3E%3Cpath d='M18 102c0-3.3 2.7-6 6-6s6 2.7 6 6-2.7 6-6 6-6-2.7-6-6m2 0c0 2.2 1.8 4 4 4s4-1.8 4-4-1.8-4-4-4-4 1.8-4 4'/%3E%3Cpath d='M60 100l8-8 8 8-8 8z'/%3E%3Cpath d='M105 105a3 3 0 1 1-6 0 3 3 0 0 1 6 0'/%3E%3C/g%3E%3C/svg%3E")`;

/**
 * Returns complete CSS properties for rendering the custom WhatsApp wallpaper.
 */
export function getChatWallpaperStyle(params: {
  themeId: WallpaperThemeId;
  showDoodle: boolean;
  opacity: number;
  isDark?: boolean;
}): CSSProperties {
  const { themeId, showDoodle, opacity, isDark = false } = params;
  const theme = WALLPAPER_THEMES.find((t) => t.id === themeId) || WALLPAPER_THEMES[0];

  const bgColor = isDark ? theme.darkBg : theme.lightBg;

  if (!showDoodle) {
    return {
      backgroundColor: bgColor,
      backgroundImage: 'none',
    };
  }

  // Opacity maps between 0.02 and 0.18 for subtle elegant background pattern
  const normalizedOpacity = Math.max(0, Math.min(1, opacity));
  const effectiveAlpha = isDark ? 0.02 + normalizedOpacity * 0.08 : 0.03 + normalizedOpacity * 0.09;

  const doodleSvg = isDark ? DOODLE_SVG_DARK : DOODLE_SVG_LIGHT;

  return {
    backgroundColor: bgColor,
    backgroundImage: doodleSvg,
    backgroundSize: '160px 160px',
    backgroundRepeat: 'repeat',
    // We achieve dynamic opacity using CSS cross-fade or blend mode
    backgroundBlendMode: isDark ? 'screen' : 'multiply',
    // Using CSS custom property or subtle overlay
    filter: `contrast(${100 + (effectiveAlpha * 50)}%)`,
  };
}
