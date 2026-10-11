export interface ContextMenuPositionOptions {
  buttonRect: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  windowWidth?: number;
  windowHeight?: number;
  menuWidth?: number;
  estimatedHeight?: number;
}

export interface ContextMenuPositionResult {
  top: number;
  left: number;
  placement: 'up' | 'down';
}

/**
 * Calculates clamped coordinates and up/down placement for the message context menu.
 * Strictly guarantees that the menu stays within viewport boundaries.
 */
export function calculateContextMenuPosition(
  options: ContextMenuPositionOptions
): ContextMenuPositionResult {
  const {
    buttonRect,
    windowWidth = typeof window !== 'undefined' ? window.innerWidth : 1024,
    windowHeight = typeof window !== 'undefined' ? window.innerHeight : 768,
    menuWidth = 160,
    estimatedHeight = 240,
  } = options;

  const spaceBelow = windowHeight - buttonRect.bottom;
  const placement: 'up' | 'down' = spaceBelow < estimatedHeight + 15 ? 'up' : 'down';

  let top = placement === 'up' ? buttonRect.top - estimatedHeight - 4 : buttonRect.bottom + 4;
  if (top < 10) top = 10;
  if (top + estimatedHeight > windowHeight - 10) {
    top = Math.max(10, windowHeight - estimatedHeight - 10);
  }

  let left = buttonRect.right - menuWidth;
  if (left < 10) left = 10;
  if (left + menuWidth > windowWidth - 10) {
    left = Math.max(10, windowWidth - menuWidth - 10);
  }

  return { top, left, placement };
}
