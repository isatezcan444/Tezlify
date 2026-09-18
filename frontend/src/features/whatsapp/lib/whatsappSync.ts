/**
 * WhatsApp sync ilerlemesi + presence TTL için saf (React'siz) yardımcılar.
 *
 * Bu modül Node'da doğrudan çalıştırılabilir; `scripts/verify-whatsapp-logic.mjs`
 * gerçek kaynağı bundle edip bu fonksiyonları doğrular.
 */
import { SessionSyncState } from '../../../types';

/**
 * F-11 — "yazıyor..." göstergesi için TTL. Gateway 'paused' olayını
 * kaybettiğinde gösterge sonsuza kadar asılı kalmamalıdır.
 */
export const PEER_TYPING_TTL_MS = 10_000;

/**
 * Verilen son-kullanma haritasından süresi geçmiş sohbet kimliklerini döndürür.
 * TTL TÜM sohbetler için geçerlidir (yalnızca açık sohbet değil).
 */
export function pruneExpiredTyping(
  expiryByConversation: Record<number, number>,
  now: number,
): number[] {
  const expired: number[] = [];
  for (const key of Object.keys(expiryByConversation)) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    if (expiryByConversation[id] <= now) expired.push(id);
  }
  return expired;
}

export interface SyncDisplayCounts {
  chats: number;
  contacts: number;
  messages: number;
}

/**
 * Gateway handoff (G-6): `chats_synced` / `contacts_synced` / `messages_synced`
 * are CUMULATIVE per-event counters — showing them as entity counts is
 * misleading ("196 chats" for a tiny account). Prefer the non-destructive
 * unique/cached fields when the gateway provides them, and fall back to the
 * legacy counters only when they are absent.
 */
export function resolveSyncDisplayCounts(
  sync: Partial<SessionSyncState> | null | undefined,
): SyncDisplayCounts {
  const s = sync || {};
  const chats = s.chats_unique ?? s.chats_synced ?? 0;
  const contacts = s.contacts_unique ?? s.contacts_synced ?? 0;
  const messages = s.messages_cached ?? s.messages_synced ?? 0;
  return {
    chats: Number.isFinite(chats) ? Number(chats) : 0,
    contacts: Number.isFinite(contacts) ? Number(contacts) : 0,
    messages: Number.isFinite(messages) ? Number(messages) : 0,
  };
}
