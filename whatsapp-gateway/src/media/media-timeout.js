/**
 * Dynamic Media Timeout and Resilience Calculator for WhatsApp Gateway.
 *
 * Provides bounded, type-aware, size-aware timeouts, exponential backoff with jitter,
 * and transient vs terminal error classification for WhatsApp media downloads.
 */

export const MEDIA_TIMEOUT_BOUNDS = {
  MIN_TIMEOUT_MS: 5_000,
  MAX_TIMEOUT_MS: 180_000, // 3 minutes maximum ceiling
  PREVIEW_TIMEOUT_MS: 10_000, // Fast path: thumbnail previews are small (<50KB)
  DEFAULT_TIMEOUT_MS: 30_000,
};

export const BASE_TIMEOUTS = {
  image: { base: 20_000, max: 45_000, bytesPerSec: 100 * 1024 },
  audio: { base: 30_000, max: 60_000, bytesPerSec: 100 * 1024 },
  video: { base: 45_000, max: 180_000, bytesPerSec: 150 * 1024 },
  document: { base: 35_000, max: 120_000, bytesPerSec: 150 * 1024 },
  sticker: { base: 15_000, max: 20_000, bytesPerSec: 100 * 1024 },
};

/**
 * Normalizes media type and mime type into a canonical category.
 */
export function normalizeMediaCategory(mediaType, mimetype) {
  const type = String(mediaType || '').toLowerCase().replace(/message$/i, '');
  const mime = String(mimetype || '').toLowerCase().trim();

  if (type === 'video' || type === 'ptv' || mime.startsWith('video/')) {
    return 'video';
  }
  if (
    type === 'audio' ||
    type === 'voice' ||
    mime.startsWith('audio/') ||
    mime.includes('ogg') ||
    mime.includes('opus')
  ) {
    return 'audio';
  }
  if (
    type === 'document' ||
    mime.startsWith('application/') ||
    mime.startsWith('text/') ||
    mime.includes('pdf')
  ) {
    return 'document';
  }
  if (type === 'sticker' || mime.includes('webp')) {
    return 'sticker';
  }
  if (type === 'image' || mime.startsWith('image/')) {
    return 'image';
  }
  return 'default';
}

/**
 * Calculates a dynamic timeout in milliseconds.
 *
 * Rules:
 * 1. If isPreview is true -> returns 10,000ms.
 * 2. If customTimeout is provided and valid -> clamped between MIN and MAX.
 * 3. Base timeout determined by category (image: 20s, audio: 30s, video: 45s, document: 35s, sticker: 15s).
 * 4. If fileLength > 0, scales timeout based on conservative bandwidth expectations.
 * 5. Capped at category max and clamped between MIN (5s) and MAX (180s).
 */
export function calculateMediaTimeout({
  mediaType = '',
  mimetype = '',
  fileLength = 0,
  isPreview = false,
  customTimeout = null,
} = {}) {
  if (isPreview) {
    return MEDIA_TIMEOUT_BOUNDS.PREVIEW_TIMEOUT_MS;
  }

  if (customTimeout !== null && customTimeout !== undefined && !Number.isNaN(Number(customTimeout))) {
    const custom = Math.round(Number(customTimeout));
    if (custom > 0) {
      return Math.max(
        MEDIA_TIMEOUT_BOUNDS.MIN_TIMEOUT_MS,
        Math.min(MEDIA_TIMEOUT_BOUNDS.MAX_TIMEOUT_MS, custom)
      );
    }
  }

  const category = normalizeMediaCategory(mediaType, mimetype);
  const spec = BASE_TIMEOUTS[category] || {
    base: MEDIA_TIMEOUT_BOUNDS.DEFAULT_TIMEOUT_MS,
    max: 60_000,
    bytesPerSec: 100 * 1024,
  };

  let timeout = spec.base;
  const numBytes = Number(fileLength);

  if (Number.isFinite(numBytes) && numBytes > 0) {
    // Add estimated transfer time based on expected size: (bytes / bytesPerSec) * 1000ms
    const estimatedTransferTimeMs = Math.ceil((numBytes / spec.bytesPerSec) * 1000);
    timeout = Math.max(spec.base, spec.base + estimatedTransferTimeMs);
  }

  // Cap by category maximum
  timeout = Math.min(spec.max, timeout);

  // Guarantee absolute bounds
  return Math.max(
    MEDIA_TIMEOUT_BOUNDS.MIN_TIMEOUT_MS,
    Math.min(MEDIA_TIMEOUT_BOUNDS.MAX_TIMEOUT_MS, Math.round(timeout))
  );
}

/**
 * Distinguishes between transient/retryable errors and terminal/permanent errors.
 */
export function isTransientMediaError(err) {
  if (!err) return false;
  const msg = String(err.message || err.toString() || '').toLowerCase();
  const code = String(err.code || '').toUpperCase();
  const status = Number(err.status || err.statusCode || (err.output && err.output.statusCode) || 0);

  // Terminal (non-transient) failures:
  // 404 Not Found, 410 Gone / Expired link, 401/403 Auth failures
  if (status === 404 || status === 410 || status === 401 || status === 403) {
    return false;
  }
  if (
    msg.includes('404') ||
    msg.includes('410') ||
    msg.includes('item-not-found') ||
    msg.includes('expired') ||
    msg.includes('rate-overlimit') ||
    msg.includes('invalid mediakey') ||
    msg.includes('no mediakey') ||
    msg.includes('missing mediakey')
  ) {
    return false;
  }

  // Transient network errors
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE'
  ) {
    return true;
  }

  // Transient HTTP / streaming / timeout errors
  if (
    (status >= 500 && status <= 599) ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('socket hang up') ||
    msg.includes('socket closed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('eai_again') ||
    msg.includes('network') ||
    msg.includes('stream truncated') ||
    msg.includes('premature close') ||
    msg.includes('aborted')
  ) {
    return true;
  }

  return false;
}

/**
 * Calculates exponential backoff with jitter for retries.
 * attempt is 0-indexed: 0 for 1st retry, 1 for 2nd retry, etc.
 */
export function getRetryDelay(attempt, baseDelay = 500, maxDelay = 3000) {
  const safeAttempt = Math.max(0, Math.min(attempt, 5));
  const exp = Math.min(maxDelay, baseDelay * Math.pow(2, safeAttempt));
  const jitter = Math.floor(Math.random() * (baseDelay / 2));
  return exp + jitter;
}
