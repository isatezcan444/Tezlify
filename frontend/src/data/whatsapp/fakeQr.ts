/**
 * Frontend-only WhatsApp data layer: deterministic fake QR code generator.
 *
 * The WhatsApp backend (Baileys QR gateway) has been removed, so the QR
 * connect modal is fed with a locally generated, deterministic QR-lookalike
 * SVG (data URI). It is purely visual: no real WhatsApp device can scan it,
 * and it contains no credentials.
 */

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isFinderPattern(x: number, y: number): boolean {
  // 7x7 finder patterns at top-left, top-right, bottom-left
  const inFinder = (fx: number, fy: number) =>
    x >= fx && x < fx + 7 && y >= fy && y < fy + 7;
  const finders: Array<[number, number]> = [
    [0, 0],
    [14, 0],
    [0, 14],
  ];
  for (const [ox, oy] of finders) {
    if (inFinder(ox, oy)) {
      const lx = x - ox;
      const ly = y - oy;
      // outer ring + inner 3x3 core filled; timing ring empty
      const ring = lx === 0 || lx === 6 || ly === 0 || ly === 6;
      const core = lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4;
      return ring || core;
    }
  }
  return false;
}

/**
 * Generates a deterministic QR-lookalike SVG data URI for a given seed string.
 * Always returns a `data:image/svg+xml` URI consumable by <img>.
 */
export function generateFakeQrDataUri(seed: string): string {
  const size = 21; // QR version-1 style module grid
  const rand = mulberry32(hashSeed(seed || 'tezlify-demo'));
  const modules: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) {
      row.push(isFinderPattern(x, y) || rand() > 0.52);
    }
    modules.push(row);
  }

  const scale = 10;
  const dim = size * scale;
  const rects: string[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) {
        rects.push(`<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}"/>`);
      }
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<g fill="#111111">${rects.join('')}</g>` +
    `</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}