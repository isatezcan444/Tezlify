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

  // Blob or Data URLs are already local and authenticated
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    return url;
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
  const storedToken =
    typeof window !== 'undefined' && typeof localStorage !== 'undefined'
      ? localStorage.getItem('tezlify_session_token')
      : null;

  let fullUrl = url;
  if (url.startsWith('/') && apiBase) {
    fullUrl = `${apiBase}${url}`;
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
