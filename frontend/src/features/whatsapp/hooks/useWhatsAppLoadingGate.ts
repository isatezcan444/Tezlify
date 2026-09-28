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
  return {
    session_id: null,
    phase,
    stage: String(sync.stage || eventData.stage || 'chats'),
    progress: Math.max(0, Math.min(100, Math.round(Number(sync.progress || 0)))),
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
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail as LoadingGateEventPayload | undefined;
      if (!detail) return;
      if (detail.event === 'whatsapp_loading_gate') {
        applyGate(detail as WhatsAppLoadingGate);
        return;
      }
      if (
        detail.event === 'session_sync_started' ||
        detail.event === 'session_sync_progress' ||
        detail.event === 'session_sync_completed'
      ) {
        const derived = deriveFromSessionSync(detail as Record<string, any>);
        if (derived) applyGate(derived);
      }
    };
    window.addEventListener('tezlify:ws_event', handler);
    return () => window.removeEventListener('tezlify:ws_event', handler);
  }, [applyGate]);

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
