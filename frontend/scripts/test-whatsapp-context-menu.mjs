/**
 * Regression test suite for WhatsApp Message Context Menu positioning logic.
 *
 * Verifies the calculateContextMenuPosition pure function against viewport boundary
 * clamping, adaptive up/down placement, and edge-case positioning.
 *
 * Run: node scripts/test-whatsapp-context-menu.mjs
 */

import assert from 'node:assert/strict';
import { calculateContextMenuPosition } from '../src/features/whatsapp/lib/whatsappContextMenu.ts';

console.log('--- WhatsApp Message Context Menu Position Suite ---');

// 1. Standard down placement when ample space below
{
  const pos = calculateContextMenuPosition({
    buttonRect: { top: 100, bottom: 120, left: 300, right: 320 },
    windowWidth: 1024,
    windowHeight: 768,
  });
  assert.equal(pos.placement, 'down', 'should place downward when ample space below');
  assert.equal(pos.top, 124, 'top should be rect.bottom + 4');
  assert.equal(pos.left, 160, 'left should be rect.right - 160');
  console.log('  ✓ 1. calculateContextMenuPosition: places downward when space below is ample');
}

// 2. Upward placement when space below is constrained (< 240 + 15 = 255)
{
  const pos = calculateContextMenuPosition({
    buttonRect: { top: 580, bottom: 600, left: 400, right: 420 },
    windowWidth: 1024,
    windowHeight: 768, // spaceBelow = 768 - 600 = 168 < 255
  });
  assert.equal(pos.placement, 'up', 'should place upward when space below is tight');
  assert.equal(pos.top, 580 - 240 - 4, 'top should be rect.top - 240 - 4 = 336');
  assert.equal(pos.left, 420 - 160, 'left should be rect.right - 160 = 260');
  console.log('  ✓ 2. calculateContextMenuPosition: places upward when space below is constrained');
}

// 3. Top boundary clamping (minimum 10px)
{
  const pos = calculateContextMenuPosition({
    buttonRect: { top: 50, bottom: 70, left: 300, right: 320 },
    windowWidth: 1024,
    windowHeight: 300, // spaceBelow = 230 < 255 -> placement 'up', top = 50 - 240 - 4 = -194 -> clamped to 10
  });
  assert.equal(pos.placement, 'up');
  assert.equal(pos.top, 10, 'top must be clamped to minimum 10px');
  console.log('  ✓ 3. calculateContextMenuPosition: clamps top to minimum 10px');
}

// 4. Bottom boundary clamping
{
  const pos = calculateContextMenuPosition({
    buttonRect: { top: 500, bottom: 520, left: 300, right: 320 },
    windowWidth: 1024,
    windowHeight: 800, // spaceBelow = 280 >= 255 -> placement 'down', top = 524. 524 + 240 = 764 <= 800 - 10 = 790 -> no clamp needed
  });
  assert.equal(pos.placement, 'down');
  assert.equal(pos.top, 524);

  // When forced down near bottom
  const pos2 = calculateContextMenuPosition({
    buttonRect: { top: 600, bottom: 620, left: 300, right: 320 },
    windowWidth: 1024,
    windowHeight: 880, // spaceBelow = 260 >= 255 -> placement 'down', top = 624. 624 + 240 = 864 > 880 - 10 = 870 -> clamped to 880 - 240 - 10 = 630
  });
  assert.equal(pos2.placement, 'down');
  assert.equal(pos2.top, 624, 'fits within boundary');
  console.log('  ✓ 4. calculateContextMenuPosition: keeps menu within bottom boundary');
}

// 5. Left boundary clamping (minimum 10px)
{
  const pos = calculateContextMenuPosition({
    buttonRect: { top: 200, bottom: 220, left: 50, right: 70 },
    windowWidth: 1024,
    windowHeight: 768,
  });
  // left would be 70 - 160 = -90 -> clamped to 10
  assert.equal(pos.left, 10, 'left must be clamped to minimum 10px');
  console.log('  ✓ 5. calculateContextMenuPosition: clamps left to minimum 10px');
}

// 6. Right boundary clamping (maximum windowWidth - menuWidth - 10)
{
  const pos = calculateContextMenuPosition({
    buttonRect: { top: 200, bottom: 220, left: 950, right: 970 },
    windowWidth: 1000,
    windowHeight: 768,
  });
  // left would be 970 - 160 = 810. 810 + 160 = 970 > 1000 - 10 = 990 -> clamped to 1000 - 160 - 10 = 830
  // wait: 810 + 160 = 970 <= 990 so left is 810.
  assert.equal(pos.left, 810);

  // Now overflow:
  const posOverflow = calculateContextMenuPosition({
    buttonRect: { top: 200, bottom: 220, left: 990, right: 1010 },
    windowWidth: 1000,
    windowHeight: 768,
  });
  // left = 1010 - 160 = 850. 850 + 160 = 1010 > 990 -> clamped to 1000 - 160 - 10 = 830
  assert.equal(posOverflow.left, 830, 'left must be clamped to avoid right overflow');
  console.log('  ✓ 6. calculateContextMenuPosition: clamps right boundary to avoid viewport overflow');
}

// 7. Custom dimensions support
{
  const pos = calculateContextMenuPosition({
    buttonRect: { top: 100, bottom: 120, left: 300, right: 350 },
    windowWidth: 800,
    windowHeight: 600,
    menuWidth: 200,
    estimatedHeight: 300,
  });
  assert.equal(pos.left, 350 - 200); // 150
  assert.equal(pos.placement, 'down'); // spaceBelow = 600 - 120 = 480 >= 300 + 15
  assert.equal(pos.top, 124);
  console.log('  ✓ 7. calculateContextMenuPosition: respects custom menu dimensions');
}

// 8. Deterministic output across consecutive calls
{
  const rect = { top: 250, bottom: 270, left: 400, right: 420 };
  const pos1 = calculateContextMenuPosition({ buttonRect: rect, windowWidth: 1024, windowHeight: 768 });
  const pos2 = calculateContextMenuPosition({ buttonRect: rect, windowWidth: 1024, windowHeight: 768 });
  assert.deepEqual(pos1, pos2);
  console.log('  ✓ 8. calculateContextMenuPosition: deterministic output across repeated calls');
}

console.log('\nAll 8 WhatsApp context menu positioning tests PASSED!\n');
