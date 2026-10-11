import { QuickReply } from '../../../types';

/**
 * Normalizes a quick reply search query for case-insensitive and whitespace-trimmed matching.
 * Preserves Turkish character lowercase semantics while providing robust partial matching.
 */
export function normalizeQuickReplyQuery(query?: string | null): string {
  if (!query) return '';
  return query.trim().toLocaleLowerCase('tr-TR');
}

/**
 * Checks whether a single QuickReply matches a given normalized search query and category filter.
 *
 * Rules:
 * 1. Category: If category is 'ALL' or empty, category filter passes. Otherwise matches case-insensitively.
 * 2. Query: If query is empty, passes. Otherwise checks title, shortcut, and content.
 */
export function matchesQuickReply(
  qr: QuickReply,
  normalizedQuery: string,
  selectedCategory: string = 'ALL'
): boolean {
  if (!qr) return false;

  const targetCategory = (selectedCategory || 'ALL').trim().toUpperCase();
  if (targetCategory !== 'ALL') {
    const qrCategory = (qr.category || '').trim().toUpperCase();
    if (qrCategory !== targetCategory) {
      return false;
    }
  }

  if (!normalizedQuery) {
    return true;
  }

  const titleLower = (qr.title || '').toLocaleLowerCase('tr-TR');
  const shortcutLower = (qr.shortcut || '').toLocaleLowerCase('tr-TR');
  const contentLower = (qr.content || '').toLocaleLowerCase('tr-TR');

  return (
    titleLower.includes(normalizedQuery) ||
    shortcutLower.includes(normalizedQuery) ||
    contentLower.includes(normalizedQuery)
  );
}

/**
 * Filters a list of QuickReplies based on search query and category filter,
 * strictly preserving original list ordering.
 */
export function filterQuickReplies(
  quickReplies: QuickReply[],
  query?: string | null,
  selectedCategory: string = 'ALL'
): QuickReply[] {
  if (!Array.isArray(quickReplies) || quickReplies.length === 0) {
    return [];
  }

  const normalized = normalizeQuickReplyQuery(query);
  const targetCategory = (selectedCategory || 'ALL').trim();

  return quickReplies.filter((qr) => matchesQuickReply(qr, normalized, targetCategory));
}

/**
 * Extracts distinct, trimmed category names from a list of QuickReplies.
 */
export function extractQuickReplyCategories(quickReplies: QuickReply[]): string[] {
  if (!Array.isArray(quickReplies) || quickReplies.length === 0) {
    return [];
  }

  const categoriesSet = new Set<string>();
  for (const qr of quickReplies) {
    if (qr && qr.category) {
      const trimmed = qr.category.trim();
      if (trimmed) {
        categoriesSet.add(trimmed);
      }
    }
  }

  return Array.from(categoriesSet);
}

/**
 * Initializes template variable key-value map for a selected QuickReply,
 * resolving defaults and lead name interpolation.
 */
export function resolveQuickReplyVariables(
  qr: QuickReply | null,
  leadName: string = ''
): Record<string, string> {
  const initial: Record<string, string> = {};
  const safeName = (leadName || '').trim();

  if (!qr) {
    return initial;
  }

  if (qr.variables && Array.isArray(qr.variables) && qr.variables.length > 0) {
    for (const v of qr.variables) {
      if (!v || !v.key) continue;
      if (v.default_from === 'lead_name') {
        initial[v.key] = safeName;
      } else {
        initial[v.key] = v.default_value || '';
      }
    }
  } else {
    initial['isim'] = safeName;
  }

  return initial;
}

/**
 * Renders quick reply content by substituting variables ({var_name}) or default {isim} placeholder.
 * Safe against regex injection by escaping variable keys.
 */
export function renderQuickReplyContent(
  qr: QuickReply | null,
  variables: Record<string, string> = {},
  leadName: string = ''
): string {
  if (!qr || typeof qr.content !== 'string') {
    return '';
  }

  let rendered = qr.content;
  const safeLeadName = (leadName || '').trim();

  if (qr.variables && Array.isArray(qr.variables) && qr.variables.length > 0) {
    for (const v of qr.variables) {
      if (!v || !v.key) continue;
      const rawVal = variables[v.key];
      const val =
        rawVal !== undefined
          ? rawVal
          : v.default_from === 'lead_name'
          ? safeLeadName
          : v.default_value || '';

      // Escape special regex characters in variable key
      const escapedKey = v.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rendered = rendered.replace(new RegExp(`\\{${escapedKey}\\}`, 'g'), val);
    }
  } else {
    rendered = rendered.replace(/\{isim\}/g, safeLeadName);
  }

  return rendered;
}
