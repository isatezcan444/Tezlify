/**
 * Test stub: the media-store unit harness never performs a real download.
 * Kept so `media-store.js` can be imported without installing dependencies.
 */
export async function downloadMediaMessage() {
  throw new Error('baileys stub: downloadMediaMessage not available in unit tests');
}

export async function downloadContentFromMessage() {
  throw new Error('baileys stub: downloadContentFromMessage not available in unit tests');
}

// message-classifier.js imports these at module load; the harness never calls them.
export function extractMessageContent(content) {
  return content;
}

export function getContentType(content) {
  if (!content || typeof content !== 'object') return null;
  return Object.keys(content)[0] || null;
}
