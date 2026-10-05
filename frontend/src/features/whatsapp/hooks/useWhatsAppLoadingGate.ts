/**
 * Faz 3 — QR sonrası Loading Gate state hook'u (WhatsApp Web paritesi).
 *
 * Tek-authority sözleşme: `phase` YALNIZCA backend `GET /whatsapp/loading-gate`
 * ve WS `whatsapp_loading_gate` / `session_sync_*` olaylarından gelir. Sahte
 * timer, sahte yüzde ÜRETİLMEZ (AGENTS.md §1.1 truthfulness).
 *
 * Sorumluluk (SRP):
 *  - REST bootstrap (mount + ws reconnect): kapı açılışta gerçek durumla açılır.
 *  - WS besleme: `whatsapp_loading_gate` olayı varsa onu, yoksa mevcut
 *    `session_sync_*` sinyallerini `phase`'e çevirir.
 *  - `ready` geçişini TESPR TARAFINA bildirir (hub tab geçişi + eager load).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { WhatsAppApi } from '../api/whatsappApi';
import { WhatsAppLoadingGate, LoadingGatePhase } from '../../../types';

/** WS olayından gelen payload — backend `WhatsAppLoadingGateResponse` ile aynı şekil. */
interface LoadingGateEventPayload extends Partial<WhatsAppLoadingGate> {
  event?: string;
  total?: number;
  synced?: number;
  chats_synced?: number;
  chats_total?: number;
  messages_synced?: number;
  messages_total?: number;
  [key: string]: any;
}

/** `session_sync_*` olaylarından türetilen eşdeğer durum (gerçek alanlardan). */
function deriveFromSessionSync(eventData: Record<string, any> | null | undefined): WhatsAppLoadingGate | null {
  if (!eventData) return null;
  const sync = eventData.sync || {};
  const phaseRaw = String(sync.phase || '');
  let phase: LoadingGatePhase | string;
  if (phaseRaw === 'ready') phase = 'ready';
  else if (phaseRaw === 'syncing') phase = 'syncing_history';
  else if (phaseRaw === 'error') phase = 'error';
  else phase = 'connecting';

  // Gateway'in kendi geçmiş senkron ilerlemesi tüm sürecin ilk kısmıdır (0 - 50%).
  // Kalan 50 - 95% backend'in PostgreSQL'e sohbet ve mesaj yazımıdır.
  // Bu nedenle tek başına gateway ilerlemesi kapıyı asla %100 yapamaz.
  const rawGw = Math.max(0, Math.min(100, Math.round(Number(sync.progress || 0))));
  const scaledProgress = phase === 'ready' ? 50 : Math.min(50, Math.round(rawGw * 0.5));

  return {
    session_id: null,
    phase,
    stage: String(sync.stage || eventData.stage || 'chats'),
    progress: scaledProgress,
    counts: {
      chats_total: Number(sync.chats_unique ?? sync.chats_total ?? 0) || 0,
      chats_synced: Number(sync.chats_unique ?? sync.chats_synced ?? 0) || 0,
      messages_total: Number(sync.messages_cached ?? sync.messages_total ?? 0) || 0,
      messages_synced: Number(sync.messages_cached ?? sync.messages_synced ?? 0) || 0,
      avatars_total: 0, avatars_fetched: 0, avatars_missing: 0,
    },
    gateway_available: true,
    gateway_error: null,
    error: sync.error ?? null,
  };
}

export interface UseWhatsAppLoadingGateResult {
  gate: WhatsAppLoadingGate | null;
  /** Kullanıcı "yine de devam et" dedi — kapı bir daha bu senkron için açılmaz. */
  dismiss: () => void;
  /** Manuel yeniden deneme — REST bootstrap'i tekrar çeker. */
  refresh: () => Promise<void>;
}

export function useWhatsAppLoadingGate(onReady?: () => void): UseWhatsAppLoadingGateResult {
  const [gate, setGate] = useState<WhatsAppLoadingGate | null>(null);
  const dismissedRef = useRef(false);
  const lastPhaseRef = useRef<string | null>(null);
  // Stable callback idiom (mevcut `loadConversationsRef` kalıbı ile aynı).
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const applyGate = useCallback((next: WhatsAppLoadingGate | null) => {
    if (!next) return;
    if (dismissedRef.current && next.phase !== 'ready' && next.phase !== 'error') return;
    setGate(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await WhatsAppApi.getLoadingGate();
      applyGate(data);
    } catch {
      // Fail-closed: hata durumunda sahte "ready" ÜRETİLMEZ. Kullanıcı mevcut
      // kapı durumuyla kalır; hata WS `session_sync_*` error sinyaliyle ya da
      // bir sonraki başarılı REST çağrısıyla yüzeye çıkar.
    }
  }, [applyGate]);

  // REST bootstrap: mount + WS reconnect (polling YOK — yalnızca gerçek sinyaller).
  useEffect(() => {
    void refresh();
    const handleWsConnected = () => void refresh();
    window.addEventListener('tezlify:ws_connected', handleWsConnected);
    return () => window.removeEventListener('tezlify:ws_connected', handleWsConnected);
  }, [refresh]);

  // WS besleme: birleşik olay varsa tek-authority, yoksa session_sync türetmesi.
  //
  // KRITIK AYRIM: gateway'in `session_sync_*` olayi YALNIZCA gateway'in kendi
  // geçmiş senkronunu anlatir. Backend'in isi (sohbet anlik goruntusu + rehber +
  // mesajlar + bos sohbet geri doldurma) bundan SONRA biter ve `initial_sync_completed_at`
  // damgasi o zaman yazilir. Bu yuzden gateway `ready` sinyali kapıyı AÇMAZ;
  // bunun yerine yetkili REST durumu yeniden cekilir (tek-authority sozlesme).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail as LoadingGateEventPayload | undefined;
      if (!detail) return;
      if (detail.event === 'whatsapp_loading_gate') {
        applyGate(detail as WhatsAppLoadingGate);
        return;
      }
      if (
        detail.event === 'whatsapp_sync_started' ||
        detail.event === 'whatsapp_sync_chats_snapshot' ||
        detail.event === 'whatsapp_sync_contacts_snapshot' ||
        detail.event === 'whatsapp_sync_messages_chunk' ||
        detail.event === 'whatsapp_sync_progress'
      ) {
        const stage = String(detail.stage || 'chats');
        const chatsSynced = Number(detail.chats_synced ?? 0);
        const chatsTotal = Number(detail.total ?? detail.chats_total ?? chatsSynced);
        const msgsSynced = Number(detail.messages_synced ?? detail.synced ?? 0);
        const msgsTotal = Number(detail.messages_total ?? msgsSynced);

        let backendProgress = 50;
        if (chatsTotal > 0) {
          backendProgress = Math.min(95, Math.round(50 + 45 * (chatsSynced / chatsTotal)));
        } else if (stage === 'messages' && msgsTotal > 0) {
          backendProgress = Math.min(95, Math.round(70 + 25 * (msgsSynced / msgsTotal)));
        } else if (stage === 'messages') {
          backendProgress = 75;
        } else if (stage === 'contacts') {
          backendProgress = 60;
        } else if (stage === 'backfill') {
          backendProgress = 85;
        } else if (stage === 'finalizing') {
          backendProgress = 92;
        }

        applyGate({
          session_id: null,
          phase: 'syncing_history',
          stage,
          progress: backendProgress,
          counts: {
            chats_total: chatsTotal,
            chats_synced: chatsSynced,
            messages_total: msgsTotal,
            messages_synced: msgsSynced,
            avatars_total: 0,
            avatars_fetched: 0,
            avatars_missing: 0,
          },
          gateway_available: true,
          gateway_error: null,
          error: null,
        });
        return;
      }
      if (detail.event === 'whatsapp_sync_complete') {
        // Backend DB sync tamamlandi! Tek-authority endpoint'e sor ve kapıyı ready'e geçir.
        void refresh();
        return;
      }
      if (detail.event === 'whatsapp_sync_failed') {
        void refresh();
        return;
      }
      if (
        detail.event === 'session_sync_started' ||
        detail.event === 'session_sync_progress' ||
        detail.event === 'session_sync_completed'
      ) {
        const derived = deriveFromSessionSync(detail as Record<string, any>);
        if (!derived) return;
        if (derived.phase === 'ready') {
          // Gateway bitti: tek-authority backend kapısına sor. Backend hala
          // SYNCING ise kapı `syncing_history` kalır; ilk senkron damgası
          // zaten atilmissa `ready` doner ve kapı açılır.
          void refresh();
          return;
        }
        applyGate(derived);
      }
    };
    window.addEventListener('tezlify:ws_event', handler);
    return () => window.removeEventListener('tezlify:ws_event', handler);
  }, [applyGate, refresh]);

  // `ready` geçişi: tam olarak bir kez, üst bileşene bildirilir.
  useEffect(() => {
    const phase = gate?.phase ?? null;
    if (phase === 'ready' && lastPhaseRef.current !== 'ready') {
      dismissedRef.current = false;
      onReadyRef.current?.();
    }
    lastPhaseRef.current = phase;
  }, [gate?.phase]);

  const dismiss = useCallback(() => {
    dismissedRef.current = true;
  }, []);

  return { gate, dismiss, refresh };
}
