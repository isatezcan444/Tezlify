/**
 * Pure helper functions for WhatsApp drag-and-drop and file staging.
 * Extracted as part of Phase 2.2 safe micro-refactoring.
 */

export const DRAG_DROP_COOLDOWN_MS = 1500;
export const DRAG_OVER_WATCHDOG_MS = 600;

export interface StagedFiles {
  files: File[];
  timestamp: number;
}

/**
 * Checks if the drag event's dataTransfer types include file payloads.
 */
export function hasDragFiles(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  const list = Array.from(types);
  return list.some((t) => t === 'Files' || t === 'application/x-moz-file');
}

/**
 * Checks if a dragleave event indicates the cursor has left the browser viewport.
 */
export function isDragLeavingWindow(
  e: { relatedTarget?: unknown; clientX: number; clientY: number },
  viewportWidth: number,
  viewportHeight: number
): boolean {
  if (e.relatedTarget) return false;
  return (
    e.clientX <= 0 ||
    e.clientY <= 0 ||
    e.clientX >= viewportWidth ||
    e.clientY >= viewportHeight
  );
}

/**
 * Checks whether the post-drop cooldown is currently active.
 * Prevents phantom dragenter events immediately after a drop.
 */
export function isDropCooldownActive(
  lastDropTimestamp: number,
  now: number = Date.now(),
  cooldownMs: number = DRAG_DROP_COOLDOWN_MS
): boolean {
  return now - lastDropTimestamp < cooldownMs;
}
