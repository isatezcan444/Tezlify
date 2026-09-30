/**
 * Mesaj reaksiyonlari — saf yardimcilar.
 *
 * Neden ayri bir modul: ayni kurallar UC yerde birden gerekir — balondaki
 * rozetler, iyimser (optimistic) guncelleme ve test kapisi. Kural her yerde
 * elle tekrarlanirsa (rozet gruplama, "benim ifadem", geri cekme) uc
 * kopya zamanla ayrisir ve kullanici bir ekranda ifadeyi geri cekip
 * digerinde cekemez hale gelir.
 *
 * Sozlesme (backend ile ayni):
 *  - Kisi basina mesaj basina TEK ifade; yeni ifade eskisini DEGISTIRIR.
 *  - `emoji === ''` o kisinin ifadesini GERI CEKER.
 *  - Kendi hattimizin kimligi `ME` sentinelidir (`Message.sender_phone` ile
 *    ayni gelenek); boylece "benim ifadem" sorusu jid'siz de cevaplanir.
 *  - Sunucudan bos `emoji` GELMEZ (geri cekilmis satirlar hic gonderilmez);
 *    bu yuzden rozet listesinde bos ifade hic gorunmez.
 */
import { Message, MessageReaction } from '../../../types';

export const SELF_REACTOR_JID = 'ME';

export interface ReactionGroup {
  emoji: string;
  count: number;
  /** Bu ifadeyi birakanlardan biri biz miyiz (rozet tiklanabilir/aktif stil). */
  mine: boolean;
}

/** Rozetler: ayni ifade tek satirda toplanir, sira SUNUCU sirasidir. */
export function groupReactions(reactions?: MessageReaction[] | null): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>();
  for (const reaction of reactions || []) {
    const emoji = reaction?.emoji;
    if (!emoji) continue;
    const slot = groups.get(emoji) || { emoji, count: 0, mine: false };
    slot.count += 1;
    slot.mine = slot.mine || Boolean(reaction.from_me);
    groups.set(emoji, slot);
  }
  return [...groups.values()];
}

/**
 * Tek bir mesaja TEK kisinin ifadesini uygular (upsert ya da geri cekme).
 * Digerlerinin ifadelerine dokunulmaz — geri cekme KISIYE OZELDIR.
 */
export function applyReactionToMessage(
  message: Message,
  emoji: string,
  opts?: { reactorJid?: string; fromMe?: boolean },
): Message {
  const reactorJid = opts?.reactorJid ?? SELF_REACTOR_JID;
  const fromMe = opts?.fromMe ?? true;
  const rest = (message.reactions || []).filter(
    (reaction) => (reaction?.reactor_jid ?? '') !== reactorJid,
  );
  if (!emoji) return { ...message, reactions: rest };
  return {
    ...message,
    reactions: [
      ...rest,
      {
        message_id: typeof message.id === 'number' ? message.id : 0,
        emoji,
        from_me: fromMe,
        reactor_jid: reactorJid,
      },
    ],
  };
}

/** Bir thread icindeki hedef mesaja ifadeyi uygular; diger satirlar AYNI kalir. */
export function applyReactionToThread(
  messages: Message[],
  messageId: number | string,
  emoji: string,
  opts?: { reactorJid?: string; fromMe?: boolean },
): Message[] {
  let changed = false;
  const next = messages.map((message) => {
    if (String(message.id) !== String(messageId)) return message;
    changed = true;
    return applyReactionToMessage(message, emoji, opts);
  });
  return changed ? next : messages;
}
