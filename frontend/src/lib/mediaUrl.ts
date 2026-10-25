import { ApiClient } from '../api/client';

/**
 * Checks whether a WhatsApp / Meta CDN URL has an expired 'oe=' hex timestamp signature.
 * Meta CDN URLs contain an `oe=<hex_timestamp>` parameter indicating UNIX epoch seconds of expiration.
 * If the current time is past or within 30 seconds of that expiration timestamp, the URL is expired.
 */
export function isWhatsAppUrlExpired(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const match = url.match(/[?&]oe=([0-9a-fA-F]+)/);
  if (!match) return false;
  try {
    const expirySec = parseInt(match[1], 16);
    if (isNaN(expirySec) || expirySec <= 0) return false;
    return Date.now() >= (expirySec - 30) * 1000;
  } catch {
    return false;
  }
}

/**
 * Resolves a media or image URL by:
 * 1. Prepending API base URL if relative (e.g. starts with /api/v1/)
 * 2. Appending auth token query parameter (?token=...) if not already present,
 *    enabling native <img>, <video>, <audio>, and <a> tags to authenticate.
 *
 * Guarded against SSR / Node / jsdom environments where import.meta.env may be undefined.
 */
export function resolveMediaUrl(url?: string | null): string | undefined {
  if (!url) return undefined;

  const trimmed = url.trim();
  if (!trimmed) return undefined;

  // Placeholder / invalid keywords must not be resolved to pseudo-endpoints
  const lower = trimmed.toLowerCase();
  if ([
    'image', 'video', 'audio', 'document', 'file', 'null', 'undefined',
    'changed', 'remove', 'error', 'none', 'false', 'true', 'unknown'
  ].includes(lower)) {
    return undefined;
  }

  // Pre-check for expired WhatsApp / Meta CDN URLs: avoid rendering <img> that will 403
  if (isWhatsAppUrlExpired(trimmed)) {
    return undefined;
  }

  // Blob or Data URLs are already local and authenticated
  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
    return trimmed;
  }

  let envApiUrl = '';
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && typeof import.meta.env.VITE_API_URL === 'string') {
      envApiUrl = import.meta.env.VITE_API_URL;
    }
  } catch {
    envApiUrl = '';
  }

  const apiBase = (envApiUrl || '').replace(/\/$/, '');
  let storedToken: string | null = null;
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      storedToken = localStorage.getItem('tezlify_session_token');
    }
  } catch {}
  if (!storedToken) {
    try {
      storedToken = ApiClient.getAuthToken();
    } catch {}
  }

  let pathOrUrl = url.trim();
  // Raw media ID or UUID (not a full URL or path) is resolved to the whatsapp media endpoint
  if (!pathOrUrl.startsWith('/') && !pathOrUrl.startsWith('http://') && !pathOrUrl.startsWith('https://')) {
    // Only resolve strings that look like a valid media ID (alphanumeric, dashes, underscores, min length 8)
    if (!/^[a-zA-Z0-9_\-]{8,}$/.test(pathOrUrl)) {
      return undefined;
    }
    pathOrUrl = `/api/v1/whatsapp/media/${pathOrUrl}`;
  }

  let fullUrl = pathOrUrl;
  if (pathOrUrl.startsWith('/') && apiBase) {
    fullUrl = `${apiBase}${pathOrUrl}`;
  }

  // If we have a token and the URL is targeting our API endpoints, attach ?token=
  if (storedToken && fullUrl.includes('/api/v1/')) {
    if (!fullUrl.includes('token=')) {
      const separator = fullUrl.includes('?') ? '&' : '?';
      fullUrl = `${fullUrl}${separator}token=${encodeURIComponent(storedToken)}`;
    }
  }

  return fullUrl;
}
