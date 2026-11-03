/**
 * Test stub used only by the 5.4.5 ingestion-atomicity harness.
 *
 * Unlike `stubs/baileys.mjs`, the download function is configurable so a test
 * can decide how many downloads happen, whether they succeed, and how long
 * they take. `downloadState.calls` lets a test prove that concurrent callers
 * coalesced onto ONE download.
 */
const notConfigured = async () => {
  throw new Error('baileys-atomic stub: download is not configured');
};

let downloadImpl = notConfigured;
let contentImpl = notConfigured;

export const downloadState = { calls: 0 };

export function setDownloadImpl(fn) {
  downloadImpl = fn;
}

export function setContentImpl(fn) {
  contentImpl = fn;
}

export function resetDownloadImpl() {
  downloadImpl = notConfigured;
  contentImpl = notConfigured;
  downloadState.calls = 0;
}

export async function downloadMediaMessage(...args) {
  downloadState.calls += 1;
  return downloadImpl(...args);
}

export async function downloadContentFromMessage(...args) {
  return contentImpl(...args);
}

export function extractMessageContent(content) {
  return content;
}

export function getContentType(content) {
  if (!content || typeof content !== 'object') return null;
  return Object.keys(content)[0] || null;
}
