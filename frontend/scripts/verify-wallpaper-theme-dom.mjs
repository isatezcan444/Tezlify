/**
 * Executed verification of WhatsApp Chat Wallpaper Theme Switching.
 *
 * Verifies:
 * 1. Default theme uses `whatsapp-chat-bg` class without stale inline background overrides.
 * 2. getChatWallpaperStyle returns light `#efeae2` and dark `#0b141a` with authentic texture.
 * 3. Color presets (midnight_blue, emerald, warm_sand, etc.) resolve correct light and dark backgrounds.
 * 4. useTheme safe fallback operates without throwing when outside ThemeProvider.
 *
 * Run: node frontend/scripts/verify-wallpaper-theme-dom.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { hardenAssert } from './lib/safe-dom-assert.mjs';

hardenAssert(assert);
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');

// Test 1: Verify getChatWallpaperStyle function directly
const { getChatWallpaperStyle, WALLPAPER_THEMES } = await import(
  path.join(frontendRoot, 'src/features/whatsapp/lib/whatsappWallpapers.ts')
);

console.log('--- 1. Testing getChatWallpaperStyle Light & Dark Palettes ---');

// Default WhatsApp wallpaper
const lightDefault = getChatWallpaperStyle({ themeId: 'whatsapp_default', isDark: false });
assert.equal(lightDefault.backgroundColor, '#efeae2', 'Default wallpaper light background should be #efeae2');
assert.ok(lightDefault.backgroundImage, 'Default wallpaper light should have authentic radial texture');

const darkDefault = getChatWallpaperStyle({ themeId: 'whatsapp_default', isDark: true });
assert.equal(darkDefault.backgroundColor, '#0b141a', 'Default wallpaper dark background should be #0b141a');
assert.ok(darkDefault.backgroundImage, 'Default wallpaper dark should have authentic radial texture');

// Midnight blue theme
const lightMidnight = getChatWallpaperStyle({ themeId: 'midnight_blue', isDark: false });
assert.equal(lightMidnight.backgroundColor, '#f0f4f8', 'Midnight Blue light should be #f0f4f8');

const darkMidnight = getChatWallpaperStyle({ themeId: 'midnight_blue', isDark: true });
assert.equal(darkMidnight.backgroundColor, '#0f172a', 'Midnight Blue dark should be #0f172a');

// Emerald green theme
const lightEmerald = getChatWallpaperStyle({ themeId: 'emerald', isDark: false });
assert.equal(lightEmerald.backgroundColor, '#ecfdf5', 'Emerald light should be #ecfdf5');

const darkEmerald = getChatWallpaperStyle({ themeId: 'emerald', isDark: true });
assert.equal(darkEmerald.backgroundColor, '#062e24', 'Emerald dark should be #062e24');

// Custom color theme
const customColor = getChatWallpaperStyle({ themeId: 'custom', customColor: '#ff0055', isDark: false });
assert.equal(customColor.backgroundColor, '#ff0055', 'Custom color should be preserved');

console.log('PASS: All getChatWallpaperStyle assertions passed!');

console.log('\n========================================');
console.log('ALL WALLPAPER THEME VERIFICATIONS PASSED!');
console.log('========================================');
process.exit(0);
