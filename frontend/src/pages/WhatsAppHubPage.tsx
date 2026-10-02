import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Smartphone, 
  QrCode, 
  ShieldCheck, 
  CheckCircle2, 
  Loader2, 
  RotateCcw,
  AlertTriangle,
  Building2,
  MessageSquare,
  Archive,
  MessageSquarePlus,
  Users,
  ArrowLeft
} from 'lucide-react';
import { startWaLatency } from '../features/whatsapp/lib/whatsappLatency';
import { translateApiError } from '../features/whatsapp/lib/translateError';
import { mergeDeliveryStatus, mergeWhatsAppMessages } from '../features/whatsapp/lib/whatsappMessageMerge';
import { WhatsAppRepository } from '../features/whatsapp/data/whatsappRepository';
import { compareConversationsByActivityDesc, restoreConversationActivity } from '../features/whatsapp/lib/whatsappOrdering';
import {
  createConversationHydrator,
  type ConversationHydrator,
} from '../features/whatsapp/lib/conversationHydration';
import {
  claimOlderPage,
  isCurrentOlderPage,
  releaseOlderPage,
  type OlderPageRequest,
} from '../features/whatsapp/lib/olderPageLock';
import { applyOlderPageResult } from '../features/whatsapp/lib/olderPageState';
import { isRawWhatsAppJid as isRawWhatsAppIdentity, identityKeys } from '../features/whatsapp/lib/whatsappIdentity';
import { PEER_TYPING_TTL_MS, pruneExpiredTyping, resolveSyncDisplayCounts } from '../features/whatsapp/lib/whatsappSync';
import { applyConversationEvent } from '../features/whatsapp/lib/whatsappConversationPatch';
import { applyReactionToThread } from '../features/whatsapp/lib/whatsappReactions';
import { WhatsAppSession, Conversation, ConversationStatus, ConversationMessageStatus, Lead, Message, LiveModeStatus, SessionSyncState } from '../types';
import { WhatsAppApi, useLiveMode, mapConversationItem, mapMessageItem, type LidSplitCandidate } from '../features/whatsapp/api/whatsappApi';
import { useWhatsAppLoadingGate } from '../features/whatsapp/hooks/useWhatsAppLoadingGate';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { EmptyState } from '../components/ui/EmptyState';
import { Avatar } from '../components/ui/Avatar';
import { WhatsAppIcon } from '../components/ui/whatsapp-icon';
import { 
  SessionCard,
  WhatsAppQrConnectModal,
  ConversationList, 
  getConversationDisplayName,
  extractCleanPhone,
  formatPhoneNumber,
  stripJidPrefix,
  ChatThread, 
  ChatComposer, 
  TemplateSelectModal, 
  NewChatModal,
  WhatsAppSyncGate,
  AntiBanPanel,
} from '../features/whatsapp/components';
import { LeadDetailDrawer } from '../features/leads/components';
import { useAntiBanSettings } from '../features/whatsapp/hooks/useAntiBanSettings';
import { FilterTab } from '../features/whatsapp/components/ConversationList';
import { useToast } from '../context/ToastContext';
import { useI18n } from '../context/I18nContext';
import { buildChatPreview, shouldApplyPreview } from '../features/whatsapp/lib/whatsappPreview';


interface WhatsAppHubPageProps {
  onRefreshStats: () => void;
}

// Faz 8 (§3): ham WhatsApp kimligi (jid:/@lid/@g.us/@s.whatsapp.net) kullaniciya
// ASLA isim veya telefon gibi gosterilmez. Tek kanonik predicate
// `features/whatsapp/lib/whatsappIdentity` içinde yaşar (burada kopya TANIMLANMAZ).

// Faz 11 (§27): banner ilerlemesi GERÇEK job sayaçlarından türetilir — sahte
// timer/progress üretilmez. Mesaj toplamı biliniyorsa oran, değilse asama.
// Faz 6 (P0.3): job sirasi artik chats -> contacts -> messages (sohbetler
// once gelir); asama agirliklari bu siraya gore guncellendi — ilerleme
// geriye gitmez.
function computeSyncProgress(
  stage: string,
  chatsSynced: number,
  contactsSynced: number,
  messagesSynced: number,
  messagesTotal: number
): number {
  if (stage === 'complete') return 100;
  if (messagesTotal > 0) return Math.min(99, Math.round((messagesSynced / messagesTotal) * 100));
  if (stage === 'finalizing') return 92;
  if (stage === 'messages') return 85;
  if (stage === 'contacts') return contactsSynced > 0 ? 70 : 60;
  if (stage === 'chats') return chatsSynced > 0 ? 50 : 30;
  return 4;
}

// Faz 14: uzun suren ilk senkron sonrasi "yine de devam et" cikisi gorunur
// olur — kullanici kapida asla kilitli kalmaz (WhatsApp Web'de bu cikis yok
// ama orada baglanti yereldir; burada ag/telefon yavassa kullaniciyi rehin
// tutmak yanlis olurdu).
const SYNC_GATE_ESCAPE_MS = 60_000;

// WhatsApp Web kronolojik siralama standardi (last_message_at -> updated_at -> created_at)
const compareByLastMessageDesc = compareConversationsByActivityDesc;

// Faz 12 (Sorun 2): tekrar oynatilan WS olaylarinda sayac sismesini onlemek icin
// tutulan son gorulen wa_message_id kumesinin ust siniri.
const SEEN_WA_IDS_MAX = 1000;

// Faz 16 (Sorun 3/9): ilk sohbet sayfasi 200 satir getirir (backend tavani
// 1000). Kalan sayfalar ARKA PLANDA sinirli sayida tamamlanir — WhatsApp
// Web'in sohbet listesini kademeli doldurmasi gibi. Sonsuz polling YOK,
// yalnizca sunucunun `has_more` sinyaline bagli bounded bir doldurma.
const CONVERSATION_PAGE_SIZE = 200;
const MAX_BACKGROUND_CONVERSATION_PAGES = 5;
// Bir mesaj sayfasi isteginin istemci tarafi iptal butcesi. SUNUCUNUN KENDI en
// kotu durumundan BUYUK olmak ZORUNDA, aksi halde yavas ama basarili bir yukleme
// "iptal" olarak gorunur:
//   gateway saglayici beklemesi : 25_000 ms  (whatsapp-gateway/src/session-manager.js
//                                             `timeoutMs = 25000`, history PDO)
//   backend gateway HTTP tavani : 30_000 ms  (WHATSAPP_GATEWAY_TIMEOUT varsayilani;
//                                             whatsapp_gateway.gateway_timeout())
// 20_000 ms, gateway'in kendi penceresi dolmadan ~5 s ONCE iptal ediyordu; bu
// yuzden saglayici zaman asimi kullaniciya her zaman `AbortError` -> "Mesajlar
// yuklenemedi" olarak donuyordu (backend'in 502 cevabi hic gorunmuyordu).
// 40_000 ms, saglayici turundan SONRA gelen DB isi + evidence commit'i icin de
// pay birakir. `WHATSAPP_GATEWAY_TIMEOUT` degistirilirse bu deger de ustunde
// kalmali.
const MESSAGE_LOAD_TIMEOUT_MS = 40_000;

export const WhatsAppHubPage: React.FC<WhatsAppHubPageProps> = ({ onRefreshStats }) => {
  const toast = useToast();
  const { t } = useI18n();
  // D7: outbound optimistic mesajlarin gonderen etiketi i18n'den gelir.
  const youName = t('whatsapp.youLabel');
  const [sessions, setSessions] = useState<WhatsAppSession[]>([]);
  const [isQrConnectModalOpen, setIsQrConnectModalOpen] = useState<boolean>(false);
  const [reconnectSessionId, setReconnectSessionId] = useState<number | undefined>(undefined);
  const [disconnectingSessionId, setDisconnectingSessionId] = useState<number | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<number | null>(null);

  // Tab State: 'conversations' | 'sessions' | 'antiban'
  const [hubTab, setHubTab] = useState<'conversations' | 'sessions' | 'antiban'>('conversations');

  // Yönetim yüzeyi: bekleyen LID/telefon bölünmüş sohbetleri. Liste SUNUCUDAN
  // okunur; istemci hiçbir koşulda "bekleyen yok" VARSAYMAZ — sonda
  // başarısızsa hiçbir şey gösterilmez (sessizlik iddia değildir).
  const [lidSplits, setLidSplits] = useState<LidSplitCandidate[]>([]);
  const [lidSplitsMerging, setLidSplitsMerging] = useState(false);

  const refreshLidSplits = useCallback(async () => {
    try {
      const res = await WhatsAppRepository.getLidSplits();
      setLidSplits(res.items);
    } catch (err) {
      // Gateway/DB sondası başarısız olabilir; ekranda yanlış bir "temiz"
      // iddiası üretmemek için yalnızca konsola yazılır.
      console.warn('[WhatsAppHubPage] Bölünmüş LID adayları alınamadı:', err);
    }
  }, []);

  useEffect(() => {
    if (hubTab !== 'conversations') return;
    void refreshLidSplits();
  }, [hubTab, refreshLidSplits]);

  // Live Conversations State (connected directly to WhatsApp session)
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const conversationsRef = useRef<Conversation[]>(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [messagesMap, setMessagesMap] = useState<Record<number, Message[]>>({});
  // PHASE 2.K.1 (single variable = onRetry prop identity): dependency-safe refs
  // mirroring the existing conversationsRef/toastRef idiom. They let the retry
  // handler be a STABLE useCallback that reads the LATEST selectedConv/messagesMap
  // at call time (no stale closure). The state declarations above are unchanged.
  const selectedConvRef = useRef(selectedConv);
  selectedConvRef.current = selectedConv;
  const lastMarkedReadConvIdRef = useRef<number | null>(null);
  const messagesMapRef = useRef(messagesMap);
  messagesMapRef.current = messagesMap;
  // `error`: sayfalama (history) istegi basarisiz oldu — mevcut mesajlar SILINMEZ,
  // yalnizca bu sayfa icin retry edilebilir durum isaretlenir (Sorun 2).
  const [messagePaging, setMessagePaging] = useState<Record<number, { hasMore: boolean; oldest?: number; loading: boolean; error?: boolean }>>({});
  // Faz 16 (Sorun 1/2/10/17): LOADING ≠ EMPTY ≠ ERROR ayrimi.
  //  - convLoadState: sohbet LISTESININ ilk yuklemesi (empty state yalnizca
  //    'ready' iken gosterilir; hata ayri bir error state'tir).
  //  - messageLoadState: sohbet BASINA mesaj hidrasyonu (bir sohbetin hatasi
  //    tum chat UI'ini error'a dusurmez).
  const [convLoadState, setConvLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [convLoadError, setConvLoadError] = useState<string | null>(null);
  const [messageLoadState, setMessageLoadState] = useState<Record<number, 'idle' | 'loading' | 'ready' | 'error'>>({});
  const [messageLoadError, setMessageLoadError] = useState<Record<number, string>>({});
  const messagePagingRequestsRef = useRef(new Map<number, AbortController>());
  // Older-page fetch lock, keyed by conversation. Kept separate from the
  // hydration requests above: those fetch the newest page, this fetches older
  // ones, and each may only hold its own cursor at a time.
  const pagingLocksRef = useRef(new Map<number, OlderPageRequest>());
  // Conversations whose server preview is newer than what we hold. The list
  // refresh records it here; the revalidation effect below consumes it. This
  // replaces a network call that used to live inside a setSelectedConv updater,
  // where it fired on every list refresh and StrictMode ran it twice.
  const conversationsNewerThanMessagesRef = useRef(new Map<number, string>());

  // Wires the tested hydration lifecycle to this page's state. Created once
  // (every dependency is a ref) and torn down on unmount, so no request can
  // commit into a dead component.
  const hydratorRef = useRef<ConversationHydrator<Message> | null>(null);
  if (hydratorRef.current === null) {
    hydratorRef.current = createConversationHydrator<Message>({
      fetchMessages: (convId, init) =>
        WhatsAppRepository.getConversationMessages(convId, { limit: 50, signal: init.signal }),
      onMessages: (convId, messages, meta) => {
        setMessagePaging((prev) => ({
          ...prev,
          [convId]: { hasMore: meta.has_more, oldest: meta.oldest ?? undefined, loading: false, error: false },
        }));
        setMessagesMap((prev) => ({ ...prev, [convId]: messages }));
      },
      getExisting: (convId) => messagesMapRef.current?.[convId] || [],
      // Identity-based merge, NOT a concat. A revalidation fetches the same
      // rows that are already on screen; concatenating them duplicated EVERY
      // message in the thread on every hydration (and a second hydration
      // triplicated them). `mergeWhatsAppMessages` reconciles by
      // id / wa_message_id / client_message_id, keeps the server-authoritative
      // fields (the fetched page is the newer snapshot) and preserves
      // optimistic rows until their real identity arrives.
      merge: (fetched, existing) => mergeWhatsAppMessages(existing, fetched),
      describeError: (err) => {
        const text = translateApiError(err, tRef.current);
        return text || tRef.current('whatsapp.messagesLoadFailed');
      },
      timeoutMs: MESSAGE_LOAD_TIMEOUT_MS,
    });
  }
  // Mirror the lifecycle into React state. The module owns the truth; this
  // subscription is only so the existing UI (which reads React state) renders
  // it, and so a transition re-renders exactly once.
  useEffect(() => {
    const h = hydratorRef.current;
    if (!h) return undefined;
    return h.subscribe((convId, state) => {
      setMessageLoadState((prev) => (prev[convId] === state ? prev : { ...prev, [convId]: state }));
      if (state === 'error') {
        setMessageLoadError((prev) => ({ ...prev, [convId]: h.getError(convId) || '' }));
      } else {
        setMessageLoadError((prev) => {
          if (!(convId in prev)) return prev;
          const next = { ...prev };
          delete next[convId];
          return next;
        });
      }
    });
  }, []);
  const [convsLoading, setConvsLoading] = useState<boolean>(false);
  const [convSearch, setConvSearch] = useState<string>('');
  const [convFilter, setConvFilter] = useState<FilterTab>('ALL');
  const [hasMoreConvs, setHasMoreConvs] = useState<boolean>(false);
  const [loadingMoreConvs, setLoadingMoreConvs] = useState<boolean>(false);
  const nextConvOffsetRef = useRef<number>(0);
  const totalConvsRef = useRef<number>(0);


  // Lead Detail Drawer State for Conversation -> Lead navigation
  const [drawerLead, setDrawerLead] = useState<Lead | null>(null);
  const [isLeadDrawerOpen, setIsLeadDrawerOpen] = useState<boolean>(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState<boolean>(false);
  const [isNewChatModalOpen, setIsNewChatModalOpen] = useState<boolean>(false);
  const [isSyncingChats, setIsSyncingChats] = useState<boolean>(false);
  const conversationsGenerationRef = useRef(0);
  // Faz 6: WS handler'i guncel loadConversations kopyasini ve bilinen sohbet
  // id'lerini ref uzerinden okur (bayat closure / StrictMode çift calisma yok).
  const loadConversationsRef = useRef<((silent?: boolean) => Promise<void>) | null>(null);
  const knownConvIdsRef = useRef<Set<number>>(new Set());
  const hydratingConversationIds = useRef(new Set<number>());
  const hydrateConversation = useCallback((id: number) => {
    if (!Number.isSafeInteger(id) || id <= 0 || hydratingConversationIds.current.has(id)) return;
    hydratingConversationIds.current.add(id);
    void WhatsAppApi.getConversations({ conversation_id: id, limit: 1 }).then((items) => {
      const item = items.find((c) => c.id === id);
      if (!item) return;
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === id);
        const merged = existing && !shouldApplyPreview(item.last_message_at, existing.last_message_at)
          ? { ...item, ...existing } : { ...existing, ...item };
        return [...prev.filter((c) => c.id !== id), merged].sort(compareByLastMessageDesc);
      });
    }).catch((error) => console.warn('[WhatsApp] Targeted conversation hydration failed', error))
      .finally(() => hydratingConversationIds.current.delete(id));
  }, []);

  // Faz 13 (truthfulness): okundu isaretleme artik GERCEK sonuc dondurur.
  // Gateway'e iletilemezse sessizce yutulmaz — konsola her zaman yazilir,
  // kullanici eylemiyse (tiklama) kullaniciya da bildirilir.
  //
  // `toast` ve `t` ref uzerinden okunur: bu callback'ler WS kurulum effect'inin
  // bagimlilik dizisine girer; kimlikleri degisirse listener'lar her render'da
  // sokulup yeniden takilir (olay kaybi + gereksiz is).
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tRef = useRef(t);
  tRef.current = t;

  const reportReadSync = useCallback(
    (res: { success: boolean; error?: string } | null | undefined, opts?: { notify?: boolean; label?: string }) => {
      if (!res || res.success) return;
      const detail = res.error || 'bilinmeyen neden';
      console.warn(
        `[WhatsAppHubPage] Okundu bilgisi WhatsApp'a iletilemedi${opts?.label ? ` (${opts.label})` : ''}: ${detail}`
      );
      if (opts?.notify) {
        toastRef.current.error(tRef.current('whatsapp.readSyncFailed'), tRef.current('common.error'));
      }
    },
    []
  );

  // Faz 13: arka plan mesaj tazeleme hatalari da sessizce yutulmaz.
  const logBackgroundFetchFailure = useCallback(
    (scope: string) => (err: unknown) => {
      console.warn(`[WhatsAppHubPage] ${scope} basarisiz:`, err);
    },
    []
  );

  // Faz 12 (P0): `onRefreshStats` prop'u üst bileşende (App) yeniden üretilirse
  // kimliği değişir. Aşağıdaki kurulum effect'i bunu bağımlılık olarak taşırsa
  // HER render'da yeniden çalışır ve GET /whatsapp/sessions +
  // GET /whatsapp/sync/job + GET /settings/antiban isteklerini tekrar atar
  // (Network sekmesindeki fırtınanın ikinci ayağı). Ref üzerinden okunur;
  // effect bağımlılığından çıkarılır.
  const onRefreshStatsRef = useRef(onRefreshStats);
  useEffect(() => {
    onRefreshStatsRef.current = onRefreshStats;
  }, [onRefreshStats]);

  // Faz 12 (Sorun 2 — canli liste tutarliligi): backend ayni `wa_message_id`
  // icin dedup edip ERKEN donsa bile olayi yine de broadcast ediyor
  // (main.py `/ws/gateway`), ayrica gateway kuyrugu yeniden baglanmada olaylari
  // tekrar oynatabiliyor. Bu durumda `message_count` ve `unread_count`
  // KOSULSUZ +1 yapildigi icin rozet/sayaclar sisiyordu. Son gorulen
  // wa_message_id'ler sinirli bir kume (ring) ile tutulur; tekrar gelen olay
  // sayaclari ARTIRMAZ (mesaj balonlari zaten messagesMap'te dedup edilir).
  const seenWaMessageIdsRef = useRef<Set<string>>(new Set());
  const rememberWaMessageId = useCallback((waId: string, convId?: number | string): boolean => {
    const key = convId != null ? `${convId}:${waId}` : waId;
    const seen = seenWaMessageIdsRef.current;
    if (seen.has(key)) return false; // tekrar oynatilan olay
    seen.add(key);
    if (seen.size > SEEN_WA_IDS_MAX) {
      // Bellek siniri: en eski girdileri dusur (Set ekleme sirasini korur).
      const it = seen.values();
      for (let i = 0; i < SEEN_WA_IDS_MAX / 2; i += 1) {
        const next = it.next();
        if (next.done) break;
        seen.delete(next.value);
      }
    }
    return true;
  }, []);

  // Faz 7/11: GERÇEK initial-sync durumu — artık WS tabanlı chunked sync job'i
  // (whatsapp_sync_* olaylari) ile beslenir. Polling storm ve sahte progress YOK.
  const [sessionSync, setSessionSync] = useState<SessionSyncState | null>(null);
  // Aktif sync job kimligi — eski (stale) job'un geç gelen olaylari yok sayilir (§14).
  const activeSyncIdRef = useRef<string | null>(null);
  // Sync mesaj tamponu: conversation_id -> Message[] chunk chunk birikir; her
  // chunk icin TAM liste yeniden render edilmez (§29) — yalnizca acik sohbet.
  const syncMsgBufferRef = useRef<Record<number, Message[]>>({});

  // Faz 14 — QR sonrasi senkron kapisi (WhatsApp Web paritesi). WhatsApp Web
  // eslestirme sonrasi sohbet listesini HEMEN acmaz; tum sohbetler ve kisiler
  // inene kadar tam ekran senkron ekrani gosterir. Ayni davranis burada: kapi
  // acilmadan canli sohbetler render EDILMEZ, boylece bir sohbete tiklamak
  // "o an indirme" (on-demand provider cagrisi) gecikmesi uretemez.
  //
  // Kapi YALNIZCA hattin ILK senkronu icin kapanir. `initial_sync_completed`
  // backend'de kalici bir damgadir (gateway'in bellek ici sync durumu ve sync
  // job'i restart'ta kaybolur, bu damga kaybolmaz) — bu yuzden kullanici
  // sohbetleri gordukten sonra yaptigi manuel "Esitle" UI'i KILITLEMEZ.
  const [syncGateDismissed, setSyncGateDismissed] = useState(false);
  // Kullaniciyi kapida asla kilitli birakma: uzun suren senkron sonrasi
  // "yine de devam et" cikisi gorunur hale gelir.
  const [syncGateEscapeVisible, setSyncGateEscapeVisible] = useState(false);
  // QR basarili oldugunda kapiyi hemen acan ve veri hazir olana kadar tutan durum
  const [isPostQrSyncing, setIsPostQrSyncing] = useState<boolean>(false);

  // Faz 3/4 — tek-authority Loading Gate (backend GET /whatsapp/loading-gate +
  // WS whatsapp_loading_gate / session_sync_* sinyalleri). `ready` aninda:
  // kapı kapanır, Canlı Diyaloglar'a otomatik geçilir ve sohbetler eager yüklenir.
  // Not: `loadConversations` bu bloktan SONRA tanimlanir; cagri sirasinda en
  // guncel kopyayi okumak icin mevcut `loadConversationsRef` kalibi kullanilir.
  const {
    gate: loadingGate,
    dismiss: dismissLoadingGate,
    refresh: refreshLoadingGate,
  } = useWhatsAppLoadingGate(
    useCallback(() => {
      setIsPostQrSyncing(false);
      setHubTab('conversations');
      loadConversationsRef.current?.(true);
    }, []),
  );

  // 'yazıyor...' durumu: conversation_id -> bool (gateway presence_updated ile)
  const [peerTypingMap, setPeerTypingMap] = useState<Record<number, boolean>>({});
  // F-11: TTL TÜM sohbetler için geçerlidir. Per-conversation `setTimeout`
  // yerine tek bir expiry haritası + tek bir süpürme interval'i kullanılır;
  // böylece kaybedilen bir 'paused' olayı arka plandaki bir sohbette asılı
  // "yazıyor..." bırakamaz.
  const peerTypingExpiryRef = useRef<Record<number, number>>({});
  const clearPeerTyping = useCallback((convId: number) => {
    delete peerTypingExpiryRef.current[convId];
    setPeerTypingMap((prev) => {
      if (!(convId in prev)) return prev;
      const next = { ...prev };
      delete next[convId];
      return next;
    });
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      const expired = pruneExpiredTyping(peerTypingExpiryRef.current, Date.now());
      if (!expired.length) return;
      for (const id of expired) delete peerTypingExpiryRef.current[id];
      setPeerTypingMap((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const id of expired) {
          if (id in next) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  // Live mode: probes backend WhatsApp gateway health on mount & periodically
  // Read-only: the flag is passed to a disabled= prop, and nothing in this
  // component ever sets it, so the setter is deliberately omitted.
  const [leadLoading] = useState<boolean>(false);

  const { status: liveStatus } = useLiveMode();

  const activeMessages = selectedConv ? (messagesMap[selectedConv.id] || []) : [];
  const activePaging = selectedConv ? messagePaging[selectedConv.id] : undefined;
  const activeHasMore = Boolean(activePaging?.hasMore && activePaging.oldest);
  const activeLoadingOlder = Boolean(activePaging?.loading);
  const activePagingError = Boolean(activePaging?.error);
  // Faz 16 (Sorun 2/10): ilk hidrasyon SURERKEN "mesaj yok" gosterilmez —
  // skeleton gosterilir. Hata ayri bir in-thread error + retry durumudur;
  // mevcut mesajlar varsa hicbir zaman loading/empty ekranina dusulmez.
  const activeChatLoading = Boolean(
    selectedConv && activeMessages.length === 0 && messageLoadState[selectedConv.id] === 'loading',
  );
  const activeMessagesError = selectedConv ? (messageLoadError[selectedConv.id] || null) : null;
  const activeConv = selectedConv;

  const activeLoadOlder = useCallback(async () => {
    if (!selectedConv || !activePaging?.hasMore || !activePaging.oldest || activePaging.loading) return;
    const convId = selectedConv.id;
    // Claim the lock BEFORE reading any state. The `activePaging.loading` check
    // above cannot see a fetch that started in this same tick, because React has
    // not committed the state update yet — a double click, or a scroll event
    // that fires again while the control is still visible, would otherwise fire
    // two requests for the same cursor. See olderPageLock.
    const request = claimOlderPage(pagingLocksRef.current, convId);
    if (!request) return;
    const { controller } = request;
    const timeout = window.setTimeout(() => controller.abort(), MESSAGE_LOAD_TIMEOUT_MS);
    startWaLatency('chat_request_to_commit_ms', convId);
    setMessagePaging((prev) => ({ ...prev, [convId]: { ...(prev[convId] || activePaging), loading: true } }));
    try {
      const res = await WhatsAppRepository.getConversationMessages(convId, {
        limit: 50,
        before: activePaging.oldest,
        signal: controller.signal,
      });
      if (!isCurrentOlderPage(pagingLocksRef.current, convId, request)) return;
      setMessagesMap((prev) => {
        const existing = prev[convId] || [];
        // Identity-based: an older page may arrive with a different DB id for a
        // row we already hold (history re-ingest), and a wa_message_id-less row
        // defeated the old `${wa || ''}:${id}` key entirely. The canonical merge
        // reconciles on id / wa_message_id / client_message_id and keeps the
        // older rows' chronological position.
        const merged = mergeWhatsAppMessages(existing, res.messages);
        return { ...prev, [convId]: merged };
      });
      setMessagePaging((prev) => ({
        ...prev,
        // A page that adds no rows and does not move the cursor is terminal —
        // see olderPageState. The backend legitimately answers an empty page
        // with `has_more: true` when it cannot prove exhaustion, and keeping
        // the affordance there re-sent the identical cursor forever.
        [convId]: applyOlderPageResult(
          prev[convId] ?? { hasMore: true, oldest: activePaging?.oldest, loading: true },
          res,
        ),
      }));
    } catch (err) {
      if (!isCurrentOlderPage(pagingLocksRef.current, convId, request)) return;
      // Sorun 2: history sayfasi basarisiz → mevcut mesajlar SILINMEZ,
      // yalnizca retry edilebilir bir hata isareti konur. Global hata toast'i
      // yok: tek sayfa hatasi tum sohbet ekranini hata gibi gostermez.
      setMessagePaging((prev) => ({
        ...prev,
        [convId]: { ...(prev[convId] || activePaging), loading: false, error: true },
      }));
      console.warn('[WhatsAppHubPage] Older messages fetch failed:', err);
    } finally {
      window.clearTimeout(timeout);
      releaseOlderPage(pagingLocksRef.current, convId, request);
    }
  }, [selectedConv, activePaging]);

  // Faz 16 (Sorun 3/9): sohbet listesi sayfa boyutu / arka plan doldurma
  // sabitleri modul seviyesinde yasar (CONVERSATION_PAGE_SIZE, ...
  const loadMoreConversationsRef = useRef<((isBackground?: boolean) => Promise<void>) | null>(null);
  const backgroundBackfillRef = useRef<{ pages: number; timer: ReturnType<typeof setTimeout> | null }>({ pages: 0, timer: null });
  const scheduleBackgroundBackfill = useCallback(() => {
    const state = backgroundBackfillRef.current;
    if (state.timer || state.pages >= MAX_BACKGROUND_CONVERSATION_PAGES) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      state.pages += 1;
      void loadMoreConversationsRef.current?.(true);
    }, 800);
  }, []);

  const loadConversations = useCallback(async (isSilent: boolean = false) => {
    const generation = conversationsGenerationRef.current;
    if (!isSilent) {
      setConvsLoading(true);
      // LOADING ≠ EMPTY ≠ ERROR (Sorun 1/16/17): ilk yukleme boyunca liste
      // "sohbet yok" DEMEZ; yanlis ara durum gosterilmez.
      setConvLoadState('loading');
      setConvLoadError(null);
      // Yeni (kullanici kaynakli) yuklemede arka plan doldurma sayaci sifirlanir.
      backgroundBackfillRef.current.pages = 0;
      if (backgroundBackfillRef.current.timer) {
        clearTimeout(backgroundBackfillRef.current.timer);
        backgroundBackfillRef.current.timer = null;
      }
    }
    try {
      // Sorun 4: GROUPS / ARCHIVED sekmeleri sunucu tarafı filtreyle yüklenir
      // (is_group / is_archived || status=ARCHIVED) — istemcide eksik sayfa
      // riski yok. ALL sekmesi arşivlenmeleri dışlar (ConversationList filtresi
      // ile tutarlı), bu yüzden archived_only=false varsayılanı korunur.
      const page = await WhatsAppRepository.getConversationsPage({
        status:
          convFilter === 'ALL' || convFilter === 'GROUPS' || convFilter === 'ARCHIVED'
            ? undefined
            : (convFilter as ConversationStatus),
        unread_only: convFilter === 'UNREAD',
        group_only: convFilter === 'GROUPS' ? true : undefined,
        archived_only: convFilter === 'ARCHIVED' ? true : undefined,
        search: convSearch.trim() || undefined,
        limit: CONVERSATION_PAGE_SIZE,
        offset: 0,
      });
      if (generation !== conversationsGenerationRef.current) return;
      // Bu istek yalnizca ILK sayfayi (offset=0) getirir. Eskiden burada
      // `setConversations(page.items)` ile listenin tamami degistiriliyordu;
      // sonuc: kullanici 150 satir yukleyip kaydirdiktan sonra gelen sessiz bir
      // yenileme (session olayi / WS reconnect / conversations_updated) 51-150
      // arasi satirlari sessizce siliyordu.
      //
      // Sorun 4: `has_more=true` iken sunucu "listede daha fazla sohbet var"
      // demektedir; bu yuzden ilk sayfada GORUNMEYEN yerel satirlar ARTIK
      // SILINMEZ (siralama tie'i ya da henuz kalici yazilmamis canli aktivite
      // yuzunden bir sohbetin kaybolmasi onlenir). `has_more=false` ise ilk
      // sayfa otoriter TAM listedir — sunucuda olmayan satir birakilir.
      setConversations((prev) => {
        const activeId = selectedConvRef.current?.id;
        const sanitizedItems = page.items.map((item) =>
          activeId && Number(item.id) === Number(activeId) ? { ...item, unread_count: 0 } : item
        );
        const pageIds = new Set(sanitizedItems.map((c) => c.id));
        if (!page.has_more) return sanitizedItems;
        const retained = prev.filter((c) => !pageIds.has(c.id));
        if (!retained.length) return sanitizedItems;
        return [...sanitizedItems, ...retained].sort(compareByLastMessageDesc);
      });
      setHasMoreConvs(page.has_more);
      nextConvOffsetRef.current = page.next_offset ?? page.items.length;
      totalConvsRef.current = page.total;

      setSelectedConv((prev) => {
        if (!prev && page.items.length > 0) return page.items[0];
        if (prev) {
          const updated = page.items.find((c) => Number(c.id) === Number(prev.id));
          if (updated) {
            const sanitized = { ...updated, unread_count: 0 };
            const currentMsgs = messagesMapRef.current?.[prev.id] || [];
            const lastMsg = currentMsgs[currentMsgs.length - 1];
            const isNewer = sanitized.last_message_at && (!lastMsg?.created_at || new Date(sanitized.last_message_at).getTime() > new Date(lastMsg.created_at).getTime());
            // NO side effects in a state updater. This branch used to call
            // hydrateConversationMessages here, which meant every list refresh
            // (WebSocket event, background backfill, tab visibility) aborted the
            // in-flight message fetch and started a new one — and StrictMode
            // invoked the updater twice, doubling that. The fetch could then
            // never finish, and the conversation sat on "Mesajlar yükleniyor"
            // with no request behind it. The revalidation is driven by the
            // effect below, which watches the preview timestamp.
            if (isNewer) {
              conversationsNewerThanMessagesRef.current.set(prev.id, sanitized.last_message_at as string);
            }
            return sanitized;
          }
          if (conversationsRef.current.some((c) => Number(c.id) === Number(prev.id))) return prev;
          return page.items.length > 0 ? page.items[0] : null;
        }
        return null;
      });

      // LOADING ≠ EMPTY ≠ ERROR: empty state yalnizca gercek veri geldikten
      // sonra gosterilir (bkz. ConversationList).
      setConvLoadState('ready');
      setConvLoadError(null);
      // Arka planda kalan sayfalar kademeli olarak getirilir (Sorun 3/9).
      if (page.has_more) scheduleBackgroundBackfill();
    } catch (err: any) {
      console.warn('[WhatsAppHubPage] Conversation list load failed', {
        silent: isSilent,
        filter: convFilter,
        search: convSearch.trim() || null,
        error: err instanceof Error ? err.message : String(err),
      });
      // GERCEK hata → ayri error state (empty/liste durumu ile karismaz).
      // Sessiz yenileme hatasi mevcut calisan listeyi ERROR'a DUSURMEZ.
      if (!isSilent) {
        setConvLoadState('error');
        setConvLoadError(
          translateApiError(err, tRef.current) || tRef.current('whatsapp.conversationsLoadFailed'),
        );
        toastRef.current.error(
          translateApiError(err, tRef.current) || tRef.current('whatsapp.conversationsLoadFailed'),
          tRef.current('common.error'),
        );
      }
    } finally {
      if (!isSilent && generation === conversationsGenerationRef.current) setConvsLoading(false);
    }
    // hydrateConversationMessages is intentionally NOT a dependency. This list
    // fetch is re-issued by the WS bootstrap and by the backfill chain, and
    // pulling hydration in here would let a conversation-list response schedule
    // a per-conversation message fetch, which is how the page ended up issuing
    // a request storm while hydrating. The list and the messages are
    // deliberately independent flows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convFilter, convSearch, scheduleBackgroundBackfill]);

  const loadMoreConversations = useCallback(async (isBackground: boolean = false) => {
    if (loadingMoreConvs || !hasMoreConvs) return;
    const generation = conversationsGenerationRef.current;
    setLoadingMoreConvs(true);
    try {
      const page = await WhatsAppRepository.getConversationsPage({
        status:
          convFilter === 'ALL' || convFilter === 'GROUPS' || convFilter === 'ARCHIVED'
            ? undefined
            : (convFilter as ConversationStatus),
        unread_only: convFilter === 'UNREAD',
        group_only: convFilter === 'GROUPS' ? true : undefined,
        archived_only: convFilter === 'ARCHIVED' ? true : undefined,
        search: convSearch.trim() || undefined,
        limit: CONVERSATION_PAGE_SIZE,
        offset: nextConvOffsetRef.current,
      });
      if (generation !== conversationsGenerationRef.current) return;
      setConversations((prev) => {
        const existingIds = new Set(prev.map((c) => c.id));
        const newItems = page.items.filter((c) => !existingIds.has(c.id));
        const combined = [...prev, ...newItems];
        // WhatsApp Web paritesi: kronolojik siralama kesin korunur
        combined.sort(compareConversationsByActivityDesc);
        return combined;
      });
      setHasMoreConvs(page.has_more);
      nextConvOffsetRef.current = page.next_offset ?? (nextConvOffsetRef.current + page.items.length);
      totalConvsRef.current = page.total;
      // Arka plan doldurma devam eder (bounded; kullanici kaydirmasini beklemez).
      if (isBackground && page.has_more) scheduleBackgroundBackfill();
    } catch (err) {
      console.warn('[WhatsAppHubPage] loadMoreConversations failed', err);
    } finally {
      setLoadingMoreConvs(false);
    }
  }, [convFilter, convSearch, hasMoreConvs, loadingMoreConvs, scheduleBackgroundBackfill]);

  // Ref uzerinden en guncel surum: arka plan doldurma zinciri bayat closure
  // kullanmaz (hasMoreConvs/loadingMoreConvs state'leri her cagride guncel).
  useEffect(() => {
    loadMoreConversationsRef.current = loadMoreConversations;
  }, [loadMoreConversations]);


  // Faz 11: 4 sn'lik sync=true polling STORM'u kaldirildi. Sync durumu yalnizca
  // WS olaylariyla akir; mount/reconnect sirasinda TEK seferlik GET /sync/job
  // ile devam eden job benimsenir (yeniden indirme YOK, §28 kurtarma).
  //
  // Sorun (Render log / "senkron %60'ta takıldı"): backend job kaydı
  // `_sync_jobs` IN-PROCESS bir sozluktur — container restart/redeploy'da
  // DUSER ve uç nokta `state: 'IDLE'` dondurur. Bu dal daha once hic ele
  // alinmiyordu; banner son bilinen degerde (tipik olarak contacts asamasinin
  // sabit %60'i) SONSUZA asili kaliyordu. Artik job yoksa/IDLE ise senkron
  // bitmis kabul edilir: banner KAPATILIR ve liste DB gerceginden yuklenir.
  // Faz 16 (Sorun 8): retained (kalici) FAILED sync job'i her sayfa acilisinda
  // ayni hatayi tekrar gostermemeli. Kullanici bir kez gordukten sonra bu
  // sync_id (fallback: finished_at) "acknowledged" olarak isaretlenir ve
  // sonraki mount'larda banner'i yeniden acmaz — yeni bir sync denemesi yeni
  // bir sync_id urettigi icin GERCEK yeni hatalar yine gosterilir.
  const FAILED_SYNC_ACK_KEY = 'tezlify_wa_failed_sync_ack';
  const acknowledgedFailedSyncId = useRef<string | null>(null);
  // Banner'daki "tekrar dene" ayni basarisizligi ack edebilsin diye gosterilen
  // hatanin anahtari saklanir (sync_id yoksa finished_at).
  const failedSyncKeyRef = useRef<string | null>(null);
  useEffect(() => {
    try {
      acknowledgedFailedSyncId.current = window.sessionStorage.getItem(FAILED_SYNC_ACK_KEY);
    } catch {
      acknowledgedFailedSyncId.current = null;
    }
  }, []);
  const acknowledgeFailedSync = useCallback((syncId: string | null) => {
    if (!syncId) return;
    acknowledgedFailedSyncId.current = syncId;
    try {
      window.sessionStorage.setItem(FAILED_SYNC_ACK_KEY, syncId);
    } catch {
      /* sessionStorage kapali — bellek ici ref yeterli */
    }
  }, []);

  // "Sohbetler esitlendi" bildirimi gercek tamamlanmadan sonra kisa sure
  // gorunur ve kendiliginden kapanir (hata MASKELENMEZ — yalnizca tamamlanma
  // mesajinin omru sinirlidir).
  useEffect(() => {
    if (sessionSync?.phase !== 'ready') return;
    setIsPostQrSyncing(false);
    loadConversations(true);
    // İlk senkron biterken biriken bölünmeleri de tazele: onarım yüzeyi
    // senkron tamamlandıktan sonra gerçek durumu göstersin.
    void refreshLidSplits();
    const timer = setTimeout(() => {
      setSessionSync((prev) => (prev && prev.phase === 'ready' ? null : prev));
    }, 4000);
    return () => clearTimeout(timer);
  }, [sessionSync?.phase, loadConversations, refreshLidSplits]);

  // Faz 14 — kapi kosulu. WhatsApp Web paritesi senkron kapisi.
  //   1) QR okutulup yeni baglanti yapildiginda (`isPostQrSyncing`),
  //   2) Ilk senkronu henuz tamamlanmamis hatta senkron suresince,
  //   3) Hata veya devam eden gercek senkron asamasinda,
  //   4) Faz 3: tek-authority loading gate `syncing_history`/`loading_profiles`
  //      asamasindayken (profil fotograflari dahil).
  // Kullanici kapiyi kapatmadigi surece WhatsApp Web yukleme ekrani gosterilir.
  const connectedSession = sessions.find((s) => s.status === 'CONNECTED') || null;
  const initialSyncPending = Boolean(connectedSession) && connectedSession?.initial_sync_completed !== true;
  // Avatarlar asla kapıyı TUTMAZ (backend `resolve_gate_phase` de artık
  // `loading_profiles` dondurmez). Kapı yalnızca gercek ilk senkron surerken
  // kapanır; profil fotografları arkada akar.
  const loadingGateActive = loadingGate?.phase === 'syncing_history';
  const syncGateActive =
    hubTab === 'conversations' &&
    !syncGateDismissed &&
    (isPostQrSyncing ||
      loadingGateActive ||
      (initialSyncPending && (sessionSync?.phase === 'syncing' || sessionSync?.phase === 'error')) ||
      (sessionSync?.phase === 'syncing' && isSyncingChats));

  // Uzun suren senkron kullaniciyi kapida kilitli birakmasin: bir esikten
  // sonra "yine de devam et" cikisi gorunur olur. Hata durumunda zaten
  // aninda gosterilir (bkz. render).
  useEffect(() => {
    if (!syncGateActive || sessionSync?.phase === 'error') {
      setSyncGateEscapeVisible(false);
      return;
    }
    const timer = setTimeout(() => setSyncGateEscapeVisible(true), SYNC_GATE_ESCAPE_MS);
    return () => clearTimeout(timer);
  }, [syncGateActive, sessionSync?.phase]);

  // Yeni bir senkron BASLADIGINDA onceki "kapatma" karari sifirlanir: kullanici
  // kapiyi bir kez kapatmis olsa bile yeni bir eslesmenin ilk senkronu yine
  // kapiyi kapatir. Yalnizca 'syncing' durumuna GECISTE sifirlanir — her
  // progress olayinda degil, aksi halde "yine de devam et" hic ise yaramazdi.
  const prevSyncPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    const phase = sessionSync?.phase ?? null;
    if (phase === 'syncing' && prevSyncPhaseRef.current !== 'syncing') {
      setSyncGateDismissed(false);
    }
    prevSyncPhaseRef.current = phase;
  }, [sessionSync?.phase]);

  const handleSyncGateContinueAnyway = useCallback(() => {
    setIsPostQrSyncing(false);
    setSyncGateDismissed(true);
    dismissLoadingGate();
  }, [dismissLoadingGate]);

  const refreshSyncStatus = useCallback(async () => {
    try {
      const job = await WhatsAppApi.getSyncJob();
      if (job.state === 'SYNCING') {
        if (job.sync_id) activeSyncIdRef.current = job.sync_id;
        setSessionSync({
          phase: 'syncing',
          stage: job.stage,
          progress: computeSyncProgress(job.stage, job.chats_synced, job.contacts_synced, job.messages_synced, job.messages_total),
          chats_synced: job.chats_synced,
          contacts_synced: job.contacts_synced,
          messages_synced: job.messages_synced,
          started_at: job.started_at ?? null,
          completed_at: null,
        });
      } else if (job.state === 'COMPLETED') {
        setSessionSync((prev) => (prev ? { ...prev, phase: 'ready', progress: 100, stage: 'complete' } : prev));
      } else if (job.state === 'FAILED') {
        // Sorun 8: FAILED job backend'de (in-process kayit) tutulabilir ve
        // sayfa her acildiginda ayni hata yeniden render edilirdi. Kullanici
        // tarafindan bir kez gorulmus (acknowledged) bir basarisizlik ARTIK
        // normal initial-load durumunu bozmaz; yeni bir sync denemesi yeni
        // sync_id uretir ve yeni hatalar normal sekilde gosterilir.
        const failureKey = job.sync_id || job.finished_at || null;
        if (failureKey && acknowledgedFailedSyncId.current === failureKey) {
          activeSyncIdRef.current = null;
          setIsSyncingChats(false);
          setSessionSync((prev) => (prev && prev.phase !== 'syncing' ? null : prev));
        } else {
          failedSyncKeyRef.current = failureKey;
          setSessionSync({ phase: 'error', stage: job.stage, error: job.error ?? null, progress: 0 });
        }
      } else {
        // IDLE ya da taninmayan durum: calisan/bilinen bir job YOK. Bu, isin
        // bittigi (veya backend'in yeniden basladigi) anlamina gelir — banner
        // asla asili birakilmaz. `isSyncingChats` de temizlenir.
        activeSyncIdRef.current = null;
        setIsSyncingChats(false);
        setSessionSync((prev) => (prev && prev.phase === 'syncing' ? null : prev));
      }
    } catch (err) {
      // Faz 13: hata MASKELENMEZ — startup'i kirletmeden gorunur loglanir.
      console.warn('[WhatsAppHubPage] Sync durumu alinamadi (GET /whatsapp/sync/job):', err);
    }
  }, []);

  useEffect(() => {
    loadConversationsRef.current = loadConversations;
  }, [loadConversations]);

  useEffect(() => {
    knownConvIdsRef.current = new Set(conversations.map((c) => c.id));
  }, [conversations]);

  // Faz 6 (P0.4/PHASE-28): canli sohbet akisi (bootstrap) sinyalleri tek
  // refetch'e indirgenir — 2 sn'den sik GET /conversations istegi yok.
  const bootstrapFetchRef = useRef<{ last: number; pending: ReturnType<typeof setTimeout> | null }>({ last: 0, pending: null });
  const scheduleBootstrapFetch = useCallback(() => {
    const st = bootstrapFetchRef.current;
    if (st.pending) return;
    const wait = Math.max(0, 2000 - (Date.now() - st.last));
    st.pending = setTimeout(() => {
      st.pending = null;
      st.last = Date.now();
      loadConversationsRef.current?.(true);
    }, wait);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadConversations();
    }, convSearch ? 300 : 0);
    return () => clearTimeout(timer);
  }, [loadConversations, convSearch]);

  // Faz 16 (Sorun 2/10): secilen sohbetin mesaj hidrasyonu sohbet BASINA
  // izlenir. Basarisizlik YALNIZCA o sohbeti error durumuna alir; mevcut
  // mesajlar SILINMEZ ve tum chat UI'i hata ekranina dusmez.
  // The lifecycle itself lives in features/whatsapp/lib/conversationHydration,
  // where it is covered by verify:chat-loading-lifecycle. This wires it to the
  // page's state; the ordering and merge rules stay the ones the tests pin.
  const hydrateConversationMessages = useCallback((convId: number) => {
    hydratorRef.current.hydrate(convId);
  }, []);

  // A conversation switch must not leave the previous pane's network work
  // alive. The identity guard above is retained for fetch adapters that settle
  // after abort instead of rejecting immediately.
  useEffect(() => {
    const convId = selectedConv?.id;
    // Captured now, not read in the cleanup: a ref's .current may point
    // somewhere else by the time the cleanup runs.
    const pagingRequests = messagePagingRequestsRef.current;
    const olderPageLocks = pagingLocksRef.current;
    return () => {
      if (!convId) return;
      // release() cancels the fetch AND clears 'loading' — see the note there.
      hydratorRef.current?.release(convId);
      pagingRequests.get(convId)?.abort();
      pagingRequests.delete(convId);
      // The older-page lock MUST be dropped here too. Leaving it behind would
      // strand the conversation: the guard would report a fetch in flight for a
      // request that no longer exists, so returning to this chat could never
      // load older messages again — and the only visible symptom is a control
      // that silently does nothing.
      olderPageLocks.get(convId)?.controller.abort();
      olderPageLocks.delete(convId);
      setMessagePaging((prev) => {
        const paging = prev[convId];
        return paging?.loading ? { ...prev, [convId]: { ...paging, loading: false } } : prev;
      });
      // The message load state MUST leave 'loading' here. The abort makes the
      // request's own catch return early (it is no longer the current request),
      // so nothing else would ever clear it — the conversation would keep
      // rendering "Mesajlar yükleniyor..." with no request behind it, and
      // returning to it would not start a new load. Clearing to 'idle' means
      // re-selecting it starts a clean fetch.
      setMessageLoadState((prev) => (prev[convId] === 'loading' ? { ...prev, [convId]: 'idle' } : prev));
    };
  }, [selectedConv?.id]);

  useEffect(() => {
    const pagingRequests = messagePagingRequestsRef.current;
    return () => {
      // Aborts every in-flight fetch and moves any 'loading' state out, so an
      // unmounted page can never commit or leave a spinner behind.
      hydratorRef.current?.dispose();
      for (const request of pagingRequests.values()) request.abort();
      pagingRequests.clear();
    };
  }, []);

  // Kullanici kaynakli retry: yalnizca secili sohbetin hidrasyonunu tekrarlar.
  const retrySelectedConversationMessages = useCallback(() => {
    const convId = selectedConv?.id;
    if (!convId) return;
    void hydrateConversationMessages(convId);
  }, [selectedConv?.id, hydrateConversationMessages]);

  // Load messages whenever selected conversation changes (with race condition mitigation)
  useEffect(() => {
    if (!selectedConv?.id) return;
    const convId = selectedConv.id;

    // Faz 5: secilen sohbeti acmak okundu sayilir (WhatsApp Web paritesi) —
    // tiklama ya da otomatik secim yoluyla gelmesi farketmez; okundu boylece
    // telefona da geri yazilir.
    if ((selectedConv.unread_count ?? 0) > 0 && lastMarkedReadConvIdRef.current !== convId) {
      lastMarkedReadConvIdRef.current = convId;
      // Faz 12: sohbet elimizde — `known` geçilir; ekstra 200 satırlık liste
      // GET'i YOK.
      // Faz 13: sonuc GERCEK — gateway'e iletilemezse sessizce yutulmaz.
      WhatsAppRepository.markConversationAsRead(convId, selectedConv)
        .then((res) => reportReadSync(res, { label: `conv#${convId}` }))
        .catch((err) => console.warn('[WhatsAppHubPage] Okundu istegi basarisiz:', err));
      setConversations((prev) =>
        prev.map((item) => (item.id === convId ? { ...item, unread_count: 0 } : item))
      );
    }

    void hydrateConversationMessages(convId);
    // `selectedConv` itself is not a dependency, only its id: depending on the
    // object would re-run this on every list refresh, since the conversation is
    // replaced whenever unread counts or previews change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConv?.id, reportReadSync, hydrateConversationMessages]);

  // Revalidate the OPEN conversation when the list reports a newer preview.
  //
  // This replaces the call that used to sit inside the setSelectedConv updater.
  // Two properties matter and neither held before:
  //   - it only revalidates the conversation the user is actually looking at,
  //     so a busy event stream cannot pile requests onto the open thread;
  //   - it compares the server timestamp against the newest message we already
  //     hold, so a list refresh that changed nothing (an unread badge, a
  //     contact name) does NOT restart the fetch.
  //
  // Without the second property this is the same bug in a new place: a fetch
  // restarted on every event would never complete.
  useEffect(() => {
    const convId = selectedConv?.id;
    if (!convId) return;
    const stamp = conversationsNewerThanMessagesRef.current.get(convId);
    if (!stamp) return;
    conversationsNewerThanMessagesRef.current.delete(convId);

    const held = messagesMapRef.current?.[convId] || [];
    const newest = held[held.length - 1]?.created_at;
    if (newest && new Date(stamp).getTime() <= new Date(newest).getTime()) return;

    void hydrateConversationMessages(convId);
  // The trigger is the preview timestamp the list just handed us, so the
  // effect runs once per genuine change rather than once per render.
  }, [selectedConv?.id, selectedConv?.last_message_at, hydrateConversationMessages]);

  // Faz 11: Manuel "Eşitle" artık ağır sync'i HTTP'de BEKLEMİYOR — POST /sync
  // kısa ömürlü job'ı tetikler (202); tüm ilerleme ve tamamlama mevcut WS
  // üzerinden whatsapp_sync_* olaylarıyla akar. 502/polling storm sona erdi.
  // Banner'ın kapanması job'ın GERÇEK tamamlanmasina bağlıdır (§20).
  const handleSyncChats = useCallback(async () => {
    setIsSyncingChats(true);
    try {
      const job = await WhatsAppApi.startSync();
      if (job.sync_id) activeSyncIdRef.current = job.sync_id;
      syncMsgBufferRef.current = {};
      setSessionSync({
        phase: 'syncing',
        stage: job.stage,
        progress: computeSyncProgress(job.stage, job.chats_synced, job.contacts_synced, job.messages_synced, job.messages_total),
        chats_synced: job.chats_synced,
        contacts_synced: job.contacts_synced,
        messages_synced: job.messages_synced,
        started_at: job.started_at ?? new Date().toISOString(),
        completed_at: null,
      });
    } catch (err: any) {
      // Başarısız tetikleme — banner sonsuz 'syncing' durumunda bırakılmaz;
      // gerçek durum bir kez okunur ve hata maskelenmez.
      setIsSyncingChats(false);
      void refreshSyncStatus();
      toastRef.current.error(err.message || tRef.current('whatsapp.syncFailed'), tRef.current('common.error'));
    }
  }, [refreshSyncStatus]);

  // PHASE 2.K.4 (single variable: ConversationList callback identity stabilization):
  // stable handlers so React.memo(ConversationList) can bail out on events that do NOT
  // change `conversations` (status/typing/sync). Each reads the latest toast/t via the
  // existing refs and depends only on already-stable callbacks (reportReadSync deps [],
  // loadConversations, refreshSyncStatus deps []) -> stable identity, no stale closure.
  const handleSelectConversation = useCallback((c: Conversation) => {
    setSelectedConv(c);
    if (c.unread_count > 0) {
      lastMarkedReadConvIdRef.current = c.id;
      // Kullanici eylemi → gateway'e iletilemezse GORUNUR bildirim.
      WhatsAppRepository.markConversationAsRead(c.id, c)
        .then((res) => reportReadSync(res, { notify: true, label: `click#${c.id}` }))
        .catch((err) => {
          console.warn('[WhatsAppHubPage] Okundu istegi basarisiz:', err);
          toastRef.current.error(tRef.current('whatsapp.readSyncFailed'), tRef.current('common.error'));
        });
      setConversations((prev) =>
        prev.map((item) => (item.id === c.id ? { ...item, unread_count: 0 } : item))
      );
    }
  }, [reportReadSync]);

  const handleNewChat = useCallback(() => setIsNewChatModalOpen(true), []);

  const handleRetryLoadConversations = useCallback(() => {
    void loadConversations();
  }, [loadConversations]);

  // Sohbet listesi satir menusu (asagi ok) eylemleri icin ortak gerekce:
  // satirlar `React.memo` ile sarildigi icin bu callback'lerin kimligi SABIT
  // olmali, aksi halde her render butun satirlari yeniden cizdirir. Canli
  // degerler ref uzerinden okunur; bagimlilik listeleri bu yuzden bostur.
  // (`statusChangeRef` tanimi, `handleStatusChange` bir `const` oldugu ve
  // kimligi her render degistigi icin o fonksiyonun TANIMINDAN SONRA gelir.)

  /**
   * Sohbeti KALICI olarak siler (mesajlar ve reaksiyonlar dahil).
   *
   * Iki kural burada kilitlidir:
   *
   * 1. **Once acik onay.** Bu islem geri alinamaz ve yedegi yoktur; ayrica
   *    karsi tarafin cihazindaki konusmayi SILMEZ, bunu onay metni acikca
   *    soyler. Yanlislikla tetiklenebilecek bir yere konmaz.
   * 2. **Basarisizlikta yerel state'e DOKUNULMAZ.** Once listeden dusup sonra
   *    hata gostermek "silindi" izlenimi birakir; AGENTS.md §1.1 geregi
   *    basarisiz bir silme basarili gibi gosterilemez.
   */
  const handleDeleteConversation = useCallback(async (convId: number) => {
    const conv = conversationsRef.current.find((c) => c.id === convId);
    const name = conv ? getConversationDisplayName(conv, tRef.current) : '';
    const confirmed = await toastRef.current.confirm({
      title: tRef.current('whatsapp.deleteChatConfirmTitle'),
      message: tRef.current('whatsapp.deleteChatConfirmBody').replace('{name}', name),
      confirmText: tRef.current('whatsapp.deleteChat'),
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      const res = await WhatsAppRepository.deleteConversation(convId);
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      // Yuklenmis mesaj tamponu da dusmeli; aksi halde ayni id yeniden acilirsa
      // eski mesajlar hayalet olarak geri gelir.
      setMessagesMap((prev) => {
        if (!(convId in prev)) return prev;
        const next = { ...prev };
        delete next[convId];
        return next;
      });
      if (selectedConvRef.current?.id === convId) setSelectedConv(null);
      toastRef.current.success(
        tRef.current('whatsapp.deleteChatDone').replace('{count}', String(res.messages_deleted)),
        tRef.current('common.success'),
      );
      // §1.1 durustluk: yerel silme basarili diye sohbet WhatsApp tarafinda da
      // silindi VARSAYILAMAZ. Silinememisse telefonda sohbet durmaya devam eder
      // ve bir sonraki gecmis senkronu onu geri getirebilir; kullanici bunu
      // simdi bilmezse "sildim" sanir.
      if (!res.remote_deleted) {
        toastRef.current.warning(
          tRef.current('whatsapp.deleteChatRemoteFailed'),
          tRef.current('common.warning'),
        );
      }
    } catch (err: any) {
      console.warn('[WhatsAppHubPage] Sohbet silinemedi:', err);
      toastRef.current.error(
        err?.message || tRef.current('whatsapp.deleteChatFailed'),
        tRef.current('common.error'),
      );
    }
  }, []);

  /**
   * Bekleyen bölünmüş LID sohbetlerini TEK istekte onarır.
   *
   * Onarım veri SİLMEZ (mesajlar kanonik sohbete taşınır, LID sohbeti
   * arşivlenir) ama yine de önce kapsam onaylatılır: tek tık onlarca sohbeti
   * yerinden edebilir. Sonuç SUNUCUDAN okunur; `deferred`/`errors` sessizce
   * yutulmaz — kısmi sonuç uyarı olarak gösterilir.
   */
  const handleRepairLidSplits = async () => {
    const totalMessages = lidSplits.reduce((sum, item) => sum + item.message_count, 0);
    const confirmed = await toast.confirm({
      title: t('whatsapp.lidSplitConfirmTitle'),
      message: t('whatsapp.lidSplitConfirmBody')
        .replace('{count}', String(lidSplits.length))
        .replace('{messages}', String(totalMessages)),
      confirmText: t('whatsapp.lidSplitMerge'),
    });
    if (!confirmed) return;
    setLidSplitsMerging(true);
    try {
      const res = await WhatsAppRepository.mergeLidSplits();
      if (res.deferred > 0 || res.errors > 0) {
        toast.warning(
          t('whatsapp.lidSplitPartial')
            .replace('{merged}', String(res.merged))
            .replace('{deferred}', String(res.deferred))
            .replace('{errors}', String(res.errors)),
          t('common.warning'),
        );
      } else {
        toast.success(
          t('whatsapp.lidSplitMerged').replace('{count}', String(res.merged)),
          t('common.success'),
        );
      }
      await refreshLidSplits();
      loadConversationsRef.current?.(true);
    } catch (err: any) {
      console.warn('[WhatsAppHubPage] LID onarımı başarısız:', err);
      toast.error(err?.message || t('whatsapp.lidSplitFailed'), t('common.error'));
    } finally {
      setLidSplitsMerging(false);
    }
  };

  const handleOpenLead = async (leadId: number) => {
    const rawPhone = selectedConv?.lead_phone || (selectedConv as any)?.phone || '';
    const displayName = selectedConv ? getConversationDisplayName(selectedConv, t) : t('whatsapp.customerLabel');
    const cleanPhone = selectedConv ? extractCleanPhone(rawPhone) : null;
    setDrawerLead({
      id: leadId,
      name: selectedConv?.lead_name || displayName,
      phone: cleanPhone || (!isRawWhatsAppIdentity(rawPhone) ? rawPhone : '') || '',
      category: 'WhatsApp Sohbeti',
      status: 'NEW',
    } as any);
    setIsLeadDrawerOpen(true);
  };

  const handleStatusChange = async (convId: number, newStatus: ConversationStatus) => {
    // Truthfulness (AGENTS.md §1.1): eskiden yalnizca yerel state degistirilip
    // kosulsuz basari toast'i gosteriliyordu; kalici yazma YOKTU ve degisiklik
    // bir sonraki yenilemede sessizce geri donuyordu. Artik gercek PATCH
    // cagrisi yapilir; hata halinde gercek hata gosterilir ve yalnizca bu
    // sohbetin durumu geri alinir (tum liste degil).
    const previousStatus: ConversationStatus =
      conversations.find((c) => c.id === convId)?.status || 'ACTIVE';
    const previousSelectedStatus =
      selectedConv && selectedConv.id === convId ? selectedConv.status : null;

    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, status: newStatus } : c))
    );
    if (selectedConv && selectedConv.id === convId) {
      setSelectedConv((prev) => (prev ? { ...prev, status: newStatus } : prev));
    }
    try {
      const res = await WhatsAppRepository.updateConversationStatus(convId, newStatus);
      const applied = (res.status as ConversationStatus) || newStatus;
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, status: applied } : c))
      );
      if (selectedConv && selectedConv.id === convId) {
        setSelectedConv((prev) => (prev ? { ...prev, status: applied } : prev));
      }
      toast.success(t('whatsapp.statusUpdated'), t('common.success'));
    } catch (err: any) {
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, status: previousStatus } : c))
      );
      if (previousSelectedStatus !== null) {
        setSelectedConv((prev) =>
          prev && prev.id === convId ? { ...prev, status: previousSelectedStatus } : prev
        );
      }
      console.warn('[WhatsAppHubPage] Conversation status update failed', {
        conversationId: convId,
        status: newStatus,
        error: err?.message || String(err),
      });
      toast.error(
        err?.message || t('whatsapp.statusUpdateFailed'),
        t('common.error')
      );
    }
  };

  // `handleStatusChange` bir `const` ve kimligi her render degisir; satir memo'su
  // bozulmasin diye ref'e alinip uc sabit sarmalayici uretilir.
  const statusChangeRef = useRef(handleStatusChange);
  statusChangeRef.current = handleStatusChange;
  const handleArchiveConversation = useCallback(
    (convId: number) => void statusChangeRef.current(convId, 'ARCHIVED'),
    [],
  );
  const handleCloseConversation = useCallback(
    (convId: number) => void statusChangeRef.current(convId, 'CLOSED'),
    [],
  );
  const handleReopenConversation = useCallback(
    (convId: number) => void statusChangeRef.current(convId, 'ACTIVE'),
    [],
  );

  const activeSendMessage = async (text: string) => {
    if (!selectedConv || !text.trim()) return;
    const trimmed = text.trim();
    const tempClientMid = `cmsg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempId = `optimistic_${tempClientMid}`;
    const nowIso = new Date().toISOString();

    const optimisticMsg: Message = {
      id: tempId,
      conversation_id: selectedConv.id,
      direction: 'OUTBOUND',
      message_type: 'TEXT',
      status: 'PENDING',
      body: trimmed,
      client_message_id: tempClientMid,
      sender_name: youName,
      created_at: nowIso,
    };

    // F-6: snapshot the pre-optimistic activity so a FAILED send can be rolled
    // back — a message that never went out must not stay pinned at the top of
    // the list as if it were the latest real activity.
    const previousConversation = conversations.find((c) => c.id === selectedConv.id);
    const previousActivity = {
      last_message_preview: previousConversation?.last_message_preview,
      last_message_at: previousConversation?.last_message_at,
    };

    // Optimistic UI feedback (0ms perceived delay)
    setMessagesMap((prev) => ({
      ...prev,
      [selectedConv.id]: [...(prev[selectedConv.id] || []), optimisticMsg],
    }));
    setConversations((prev) => {
      const updated = prev.map((c) =>
        c.id === selectedConv.id
          ? { ...c, last_message_preview: trimmed, last_message_at: nowIso }
          : c
      );
      return [...updated].sort(compareConversationsByActivityDesc);
    });

    try {
      const res = await WhatsAppRepository.sendMessage(selectedConv.id, trimmed, tempClientMid);
      // Reconcile temporary message with backend response (which has status 'PENDING', real id, client_message_id)
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? {
                ...m,
                id: res.id,
                client_message_id: res.client_message_id || tempClientMid,
                wa_message_id: res.wa_message_id ?? m.wa_message_id,
                status: res.status,
                created_at: res.created_at || m.created_at,
              }
            : m
        ),
      }));
    } catch (err: any) {
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, status: 'FAILED', error_message: translateApiError(err, t) || t('whatsapp.msgFailed') }
            : m
        ),
      }));
      // F-6: undo the optimistic preview/timestamp (and re-sort) so the
      // conversation reflects REAL activity again. If a real message
      // superseded the optimistic write meanwhile, it is left untouched.
      setConversations((prev) =>
        prev
          .map((c) =>
            c.id === selectedConv.id
              ? restoreConversationActivity(
                  c,
                  { last_message_preview: trimmed, last_message_at: nowIso },
                  previousActivity,
                )
              : c,
          )
          .sort(compareConversationsByActivityDesc),
      );
      // F-7: no toast here — the UI caller owns the single user-facing toast.
      throw err;
    }
  };

  const activeRetryMessage = useCallback(async (msgId: number | string) => {
    // PHASE 2.K.1: reads the LATEST selectedConv/messagesMap via refs so this
    // handler is a STABLE reference (deps []) with NO stale closure — behavior
    // is identical to the previous render-scoped closure (which was recreated
    // every render and therefore also saw the latest state at call time).
    const selectedConv = selectedConvRef.current;
    if (!selectedConv) return;
    // Optimistic rows (client-only string ids) must never hit /retry. Re-POST
    // with the existing client_message_id so idempotency holds and the row is
    // reconciled with the real numeric DB id.
    const convId = selectedConv.id;
    const target = (messagesMapRef.current[convId] || []).find((m) => m.id === msgId);
    const isRealDbId = typeof msgId === 'number' && Number.isInteger(msgId) && msgId > 0;
      if (!isRealDbId) {
        const clientMid = target?.client_message_id;
        if (!target || !clientMid || !target.body) {
          throw new Error(
            tRef.current('whatsapp.msgNotPersisted')
          );
        }
        const res = await WhatsAppRepository.sendMessage(convId, target.body, clientMid);
        setMessagesMap((prev) => ({
          ...prev,
          [convId]: (prev[convId] || []).map((m) =>
            m.id === msgId || (clientMid && m.client_message_id === clientMid)
              ? {
                  ...m,
                  id: res.id,
                  client_message_id: res.client_message_id || clientMid,
                  wa_message_id: (res as any).wa_message_id ?? m.wa_message_id,
                  status: res.status,
                  error_message: undefined,
                }
              : m
          ),
        }));
        return;
      }
      const res = await WhatsAppRepository.retryMessage(convId, msgId);
      setMessagesMap((prev) => ({
        ...prev,
        [convId]: (prev[convId] || []).map((m) =>
          m.id === msgId ? { ...m, status: res.status, error_message: undefined } : m
        ),
      }));
    // No try/catch: F-7 requires no toast here because the UI caller owns the
    // single user-facing toast. A catch that only rethrows would be a no-op
    // wrapper, so the error propagates untouched instead.
  }, []);

  // PHASE 2.K.1 (single variable): STABLE onRetry handler. Same behavior as the
  // previous inline lambda — wraps the retry with the single user-facing toast —
  // but reads toast/t from refs (existing idiom) and depends only on the now
  // stable `activeRetryMessage`, so its reference NEVER changes across renders.
  // This is what lets ChatBubble's React.memo bail out unchanged rows.
  const handleRetryMessage = useCallback(async (msgId: number | string) => {
    try {
      await activeRetryMessage(msgId);
      toastRef.current.success(tRef.current('whatsapp.messageSent'), tRef.current('common.success'));
    } catch (err: any) {
      toastRef.current.error(translateApiError(err, tRef.current) || tRef.current('whatsapp.msgFailed'), tRef.current('common.error'));
      // The rethrow is NOT redundant: ChatBubble catches this to flip the
      // message into its FAILED state. The toast tells the user, the throw
      // tells the row to update. ESLint only sees a catch that rethrows and
      // calls the wrapper useless, which it would be if the toast were absent.
      // eslint-disable-next-line no-useless-catch
      throw err;
    }
  }, [activeRetryMessage]);

  /**
   * Bir mesaja ifade birakir/degistirir/kaldirir (WhatsApp Web paritesi).
   *
   * Iyimser rozet ANINDA gosterilir; sunucu yaniti (ve ayni anda gelen WS
   * yankisi) gercek degeri yazar. Hata olursa rozet ESKI haline doner ve
   * kullaniciya toast gider — "basarili gibi gorunen ama WhatsApp'a hic
   * gitmeyen" bir tepki birakilmaz.
   */
  const handleReactMessage = useCallback(async (msgId: number | string, emoji: string) => {
    const convId = selectedConvRef.current ? Number(selectedConvRef.current.id) : null;
    const numericId = typeof msgId === 'number' ? msgId : Number(msgId);
    if (!convId || !Number.isInteger(numericId) || numericId <= 0) return;
    const before = messagesMapRef.current?.[convId]?.find(
      (m) => String(m.id) === String(numericId),
    )?.reactions;
    setMessagesMap((prev) => ({
      ...prev,
      [convId]: applyReactionToThread(prev[convId] || [], numericId, emoji),
    }));
    try {
      const res = await WhatsAppRepository.sendReaction(convId, numericId, emoji);
      setMessagesMap((prev) => ({
        ...prev,
        [convId]: applyReactionToThread(prev[convId] || [], numericId, res.removed ? '' : res.emoji),
      }));
      // Liste rozeti SUNUCUDAN gelir: eski bir mesaja birakilan ifade rozeti
      // degistirmez (`conversation_reaction` o durumda mevcut rozeti doner).
      const serverReaction = res.conversation_reaction ?? null;
      setConversations((prev) =>
        prev.map((c) => (Number(c.id) === convId ? { ...c, last_reaction: serverReaction } : c)),
      );
      setSelectedConv((prev) =>
        prev && Number(prev.id) === convId ? { ...prev, last_reaction: serverReaction } : prev,
      );
    } catch (err: any) {
      setMessagesMap((prev) => ({
        ...prev,
        [convId]: (prev[convId] || []).map((m) =>
          String(m.id) === String(numericId) ? { ...m, reactions: before } : m,
        ),
      }));
      toastRef.current.error(
        translateApiError(err, tRef.current) || tRef.current('whatsapp.reactionFailed'),
        tRef.current('common.error'),
      );
      throw err;
    }
  }, []);

  const activeSendMedia = async (type: string, url: string, caption?: string, filename?: string) => {
    if (!selectedConv) return;
    const tempClientMid = `media_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempId = `optimistic_${tempClientMid}`;
    const nowIso = new Date().toISOString();

    const newMsg: Message = {
      id: tempId,
      conversation_id: selectedConv.id,
      direction: 'OUTBOUND',
      message_type: (type === 'IMAGE' ? 'IMAGE' : 'DOCUMENT') as any,
      status: 'PENDING',
      body: caption || filename || url || `[${type}]`,
      client_message_id: tempClientMid,
      media_url: url,
      media_filename: filename,
      media_caption: caption,
      sender_name: youName,
      created_at: nowIso,
    };
    setMessagesMap((prev) => ({
      ...prev,
      [selectedConv.id]: [...(prev[selectedConv.id] || []), newMsg],
    }));

    try {
      const res = await WhatsAppRepository.sendMedia(
        selectedConv.id,
        {
          media_type: type.toLowerCase(),
          media_url: url,
          caption,
          filename,
        },
        tempClientMid
      );
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, id: res.id, client_message_id: res.client_message_id || tempClientMid, status: res.status, created_at: res.created_at || m.created_at }
            : m
        ),
      }));
      const previewText = caption || filename || (type.toUpperCase() === 'IMAGE' ? t('whatsapp.previewImage') : t('whatsapp.previewDocument'));
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedConv.id
            ? { ...c, last_message_preview: previewText, last_message_at: new Date().toISOString() }
            : c
        ).sort(compareByLastMessageDesc)
      );
    } catch (err: any) {
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, status: 'FAILED', error_message: err.message }
            : m
        ),
      }));
      throw err;
    }
  };

  const activeSendMediaFile = async (file: File, caption?: string) => {
    if (!selectedConv) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const mt = file.type || '';
    let msgType: Message['message_type'] = 'DOCUMENT';
    if (mt.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) msgType = 'IMAGE';
    else if (mt.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(ext)) msgType = 'VIDEO';
    else if (mt.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) msgType = 'AUDIO';

    const tempClientMid = `file_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempId = `optimistic_${tempClientMid}`;
    const nowIso = new Date().toISOString();

    const objectUrl = URL.createObjectURL(file);
    const newMsg: Message = {
      id: tempId,
      conversation_id: selectedConv.id,
      direction: 'OUTBOUND',
      message_type: msgType,
      status: 'PENDING',
      body: caption || file.name,
      client_message_id: tempClientMid,
      media_url: objectUrl,
      media_filename: file.name,
      media_mime_type: file.type || undefined,
      media_caption: caption,
      sender_name: youName,
      created_at: nowIso,
    };
    setMessagesMap((prev) => ({
      ...prev,
      [selectedConv.id]: [...(prev[selectedConv.id] || []), newMsg],
    }));

    try {
      const res = await WhatsAppRepository.sendMediaFile(selectedConv.id, file, caption, tempClientMid);
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? {
                ...m,
                id: res.id,
                client_message_id: res.client_message_id || tempClientMid,
                wa_message_id: res.wa_message_id ?? m.wa_message_id,
                media_url: res.media_url ?? m.media_url,
                status: res.status,
                created_at: res.created_at || m.created_at,
              }
            : m
        ),
      }));
      const previewText = caption || file.name || (msgType === 'IMAGE' ? t('whatsapp.previewImage') : t('whatsapp.previewDocument'));
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedConv.id
            ? { ...c, last_message_preview: previewText, last_message_at: nowIso }
            : c
        ).sort(compareByLastMessageDesc)
      );
    } catch (err: any) {
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, status: 'FAILED', error_message: err.message }
            : m
        ),
      }));
      throw err;
    }
  };

  const activeSendTemplate = async (templateKey: string, variables: Record<string, string> = {}) => {
    if (!selectedConv) return;
    const tempClientMid = `tmpl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempId = `optimistic_${tempClientMid}`;
    const nowIso = new Date().toISOString();

    const optimisticMsg: Message = {
      id: tempId,
      conversation_id: selectedConv.id,
      direction: 'OUTBOUND',
      message_type: 'TEMPLATE',
      status: 'PENDING',
      body: `[${t('whatsapp.previewTemplate')} · ${templateKey}]`,
      client_message_id: tempClientMid,
      sender_name: youName,
      created_at: nowIso,
    };

    setMessagesMap((prev) => ({
      ...prev,
      [selectedConv.id]: [...(prev[selectedConv.id] || []), optimisticMsg],
    }));

    try {
      const res = await WhatsAppRepository.sendTemplate(selectedConv.id, templateKey, variables, tempClientMid);
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, id: res.id, body: res.body || m.body, status: res.status }
            : m
        ),
      }));
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedConv.id
            ? { ...c, last_message_preview: res.body || optimisticMsg.body, last_message_at: nowIso }
            : c
        )
      );
    } catch (err: any) {
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, status: 'FAILED', error_message: translateApiError(err, t) || t('whatsapp.templateFailed') }
            : m
        ),
      }));
      // F-7: no toast here — the UI caller owns the single user-facing toast.
      throw err;
    }
  };


  // Real-time listener for conversation list unread, status and preview updates
  useEffect(() => {
    const handleWsEvent = (e: Event) => {
      const customEvent = e as CustomEvent<any>;
      const eventData = customEvent.detail;
      if (!eventData) return;
      if (eventData.event === 'message_new' && eventData.message?.id) {
        startWaLatency('event_handler_to_message_commit_ms', eventData.message.id);
      }

      // 1. INBOUND MESSAGE & OUTBOUND CONFIRMATION
      // Faz 10 (P3): gateway'in gercek olay adi 'message_new'tir (hem gelen hem
      // telefondan gonderilen mesajlar icin). D5: 'inbound_reply',
      // 'new_message' ve 'outbound_message_sent' adlarini HICBIR yerde ne
      // gateway ne backend yayinlamiyordu — o lu dallar kaldirildi.
      if (eventData.event === 'message_new') {
        const convIdRaw = eventData.conversation_id ?? eventData.conversation?.id ?? eventData.message?.conversation_id;
        const convIdNumber = typeof convIdRaw === 'number'
          ? convIdRaw
          : typeof convIdRaw === 'string' && convIdRaw.trim() !== '' && !Number.isNaN(Number(convIdRaw))
            ? Number(convIdRaw)
            : NaN;
        const numericConvId = Number.isInteger(convIdNumber) && convIdNumber > 0 ? convIdNumber : null;
        const rawPhone = eventData.lead_phone || eventData.phone || eventData.recipient_phone || eventData.sender_phone || '';
        // I-7 (single authority): the event's phone/JID identity is resolved
        // ONCE below into a canonical alias set (`eventKeys`). Matching on the
        // last 10 digits is wrong — two different people can share their last
        // 10 digits (+905321234567 and +1555551234567) — so identity is always
        // compared through `extractCleanPhone`/canonical JID, never by suffix.

        // Group JID or remote JID resolution
        const rawJid = typeof convIdRaw === 'string' && convIdRaw.includes('@')
          ? stripJidPrefix(convIdRaw)
          : (eventData.jid ? stripJidPrefix(eventData.jid) : (eventData.message?.conversation_id && String(eventData.message.conversation_id).includes('@') ? stripJidPrefix(eventData.message.conversation_id) : null));

        // KOK NEDENI FIX: the event's conversation identity is resolved ONCE,
        // into a canonical alias set. Previously the conversation list compared
        // `c.lead_phone || c.phone` while the open thread compared only
        // `c.lead_phone`, and BOTH compared it with `stripJidPrefix` — a helper
        // that merely removes a `jid:` prefix and therefore can never equate a
        // stored phone (`+905550000777`) with an event JID
        // (`905550000777@s.whatsapp.net`). A JID-only inbound event therefore
        // updated the list row and was then dropped before the thread merge.
        // One resolution now feeds the list, the active-chat test and the
        // message merge, so they can no longer disagree.
        const eventKeys = identityKeys(convIdRaw ?? rawJid);
        for (const candidate of [eventData.jid, eventData.lead_phone, eventData.phone, rawPhone]) {
          for (const key of identityKeys(candidate)) eventKeys.add(key);
        }
        const matchesEvent = (row: Conversation | null | undefined): boolean => {
          if (!row) return false;
          for (const key of identityKeys(row)) if (eventKeys.has(key)) return true;
          return false;
        };
        // Ambiguity guard (preserved from the previous phone-only fallback):
        // a non-exact identity match is trusted only when it selects exactly
        // one row, or when that row is the conversation already on screen.
        // Guessing between two rows would file an inbound message under the
        // wrong person, which is worse than not rendering it.
        const selectedId = selectedConvRef.current ? Number(selectedConvRef.current.id) : null;
        const pickEventRow = <T extends { id: number }>(rows: T[]): T | null => {
          const hits = rows.filter((r) => matchesEvent(r as unknown as Conversation));
          if (hits.length === 1) return hits[0];
          if (selectedId != null) {
            const open = hits.find((r) => Number(r.id) === selectedId);
            if (open) return open;
          }
          return null;
        };

        // Resolve conversation ID: prefer numericConvId, fall back to matching conversation in memory by canonical identity
        let convId: number | null = numericConvId;
        if (convId === null && eventKeys.size > 0) {
          const match = pickEventRow(conversationsRef.current) || (matchesEvent(selectedConvRef.current) ? selectedConvRef.current : null);
          if (match && Number(match.id) > 0) {
            convId = Number(match.id);
          }
        }

        const msgObj0 = eventData.message && typeof eventData.message === 'object' ? eventData.message : null;
        const msgText = eventData.message?.body || (typeof eventData.message === 'string' ? eventData.message : '') || eventData.body || '';
        const msgTime = msgObj0?.created_at || eventData.created_at || eventData.timestamp || new Date().toISOString();
        // D5: 'outbound_message_sent' hicbir yerde yayinlanmadi; yon her
        // zaman olay payload'indaki direction alanindan cozulur.
        const isOutbound =
          msgObj0?.direction === 'OUTBOUND' ||
          eventData.direction === 'OUTBOUND';
        // Faz 10 (P3): canli sohbette balonun gondereni — outbound'ta backend
        // 'ME' yayinlar; balon sagda 'Siz' olarak etiketlenir.
        const senderLabel = isOutbound ? t('whatsapp.youLabel') : msgObj0?.sender_name || eventData.sender_name;

        // Faz 12 (Sorun 2): ayni mesajin tekrar oynatilmasi (WS replay / cift
        // emit) liste sayaclarini SISIRMEZ. `wa_message_id` yoksa (nadir:
        // optimistic/eski olay) eski davranis korunur — sessizce yutmayiz.
        const waIdForDedup = msgObj0?.wa_message_id || eventData.wa_message_id || eventData.message_id;
        const isReplayedEvent = Boolean(waIdForDedup) && !rememberWaMessageId(String(waIdForDedup), convId ?? undefined);

        const activeConv = selectedConvRef.current;
        // The active chat is recognised through the SAME canonical identity
        // resolution as the list, so an event that updates a list row can no
        // longer be dropped before it reaches the open thread.
        const isCurrentSelected = Boolean(
          activeConv && (
            (convId != null && Number(activeConv.id) === Number(convId)) ||
            matchesEvent(activeConv)
          )
        );
        const isActiveConversation = isCurrentSelected;

        // Update Conversation in list
        if (convId !== null && !knownConvIdsRef.current.has(convId)) hydrateConversation(convId);
        setConversations((prev) => {
          const exactIdx = convId == null ? -1 : prev.findIndex((c) => Number(c.id) === Number(convId));
          // Same canonical identity resolution as the thread: the list and the
          // open chat must never disagree about which row an event belongs to.
          const hit = exactIdx !== -1 ? prev[exactIdx] : pickEventRow(prev);
          const idx = hit ? prev.indexOf(hit) : -1;

          if (idx !== -1) {
            const existing = prev[idx];
            // Faz 10 (P2): sohbet ozeti paylasilan kuraldan gecer — medyada
            // tip etiketi (📷 Fotoğraf), gruplarda cozulmus gonderen on eki
            // ("Ahmet: ..."), ham JID on ek ASLA; daha eski mesaj mevcut
            // ozeti ezemez (zaman damgali siralama).
            const summary = buildChatPreview(
              {
                message_type: msgObj0?.message_type || eventData.message_type || 'TEXT',
                body: typeof msgText === 'string' ? msgText : '',
                sender_name: msgObj0?.sender_name || eventData.sender_name,
                direction: isOutbound ? 'OUTBOUND' : 'INBOUND',
              },
              Boolean(existing.is_group),
              t,
            );
            // Sorun 2 (kronolojik siralama — sertlestirme): ZAMAN DAMGASI
            // guncellemesi onizleme uretiminden BAGIMSIZDIR. Onceden
            // `last_message_at` yalnizca `summary` (insan-okur onizleme)
            // uretilebildiginde yaziliyordu: govdesiz/etiketsiz bir olay
            // (bos metin, taninmayan tip, gec gelen metadata) geldiginde
            // damga yerinde kaliyor ve sohbet listede EN USTE TASINMIYORDU.
            // Artik: damga her zaman zaman-damgali kurala gore uygulanir,
            // onizleme ayrica degerlendirilir — siralama ile metin birbirini
            // bloklamaz.
            const tsFresh = shouldApplyPreview(msgTime, existing.last_message_at);
            const applyPreview = Boolean(summary) && tsFresh;
            // Tekrar oynatilan olayda sayaclar/rozet ARTMAZ; mesaj balonu
            // messagesMap'te ayrica dedup edilir, veri kaybi olmaz.
            const updated: Conversation = {
              ...existing,
              status: 'ACTIVE',
              last_message_preview:
                isReplayedEvent
                  ? existing.last_message_preview
                  : applyPreview
                    ? summary
                    : existing.last_message_preview,
              last_message_at:
                isReplayedEvent
                  ? existing.last_message_at
                  : tsFresh || !existing.last_message_at
                    ? msgTime
                    : existing.last_message_at,
              message_count: isReplayedEvent ? (existing.message_count ?? 0) : (existing.message_count ?? 0) + 1,
              last_message_state: applyPreview ? 'RESOLVED' : existing.last_message_state,
              unread_count:
                isReplayedEvent
                  ? existing.unread_count
                  : isCurrentSelected || isOutbound
                    ? 0
                    : (existing.unread_count || 0) + 1,
              is_window_open: true, // Inbound message opens the 24h customer window!
              last_inbound_at: isReplayedEvent ? existing.last_inbound_at : !isOutbound ? msgTime : existing.last_inbound_at,
            };
            if (isCurrentSelected) {
              setSelectedConv(updated);
            }
            // Sorun 2 (kronolojik siralama): kosulsuz "en uste tasi" yerine
            // zaman damgasina gore yeniden siralanir — gec/bayat bir olay
            // (retry, geciken WS) sohbeti haksiz yere en uste kilitleyemez.
            const rest = prev.filter((_, i) => i !== idx);
            return [updated, ...rest].sort(compareByLastMessageDesc);
          } else {
            return prev;
          }
        });

        // F-11: an inbound message ends the peer's typing state for THAT
        // conversation regardless of which chat is currently open — a
        // background conversation must not keep a stale "yazıyor...".
        if (!isOutbound && convId != null) clearPeerTyping(convId);

        const targetConvId = convId ?? (isActiveConversation && activeConv ? Number(activeConv.id) : null);

        if (targetConvId != null) {
          const msgObj = eventData.message && typeof eventData.message === 'object' ? eventData.message : null;
          const waId = msgObj?.wa_message_id || eventData.wa_message_id || eventData.message_id;
          const clientMid = msgObj?.client_message_id || eventData.client_message_id;
          const msgId = msgObj?.id || eventData.id;

          const incomingMediaId = msgObj?.media_id || eventData.media_id || undefined;
          const incomingMediaUrl =
            msgObj?.media_url ||
            eventData.media_url ||
            (incomingMediaId ? `/api/v1/whatsapp/media/${incomingMediaId}` : undefined);

          const newMsg: Message = {
            id: msgId || Date.now(),
            conversation_id: targetConvId,
            direction: isOutbound ? 'OUTBOUND' : 'INBOUND',
            message_type: (msgObj?.message_type || eventData.message_type || 'TEXT').toUpperCase() as any,
            status: msgObj?.status || (isOutbound ? 'PENDING' : 'RECEIVED'),
            body: typeof msgText === 'string' ? msgText : '',
            wa_message_id: waId,
            client_message_id: clientMid,
            sender_name: senderLabel || (isOutbound ? t('whatsapp.youLabel') : undefined),
            sender_phone: msgObj?.sender_phone || eventData.phone || '',
            media_id: incomingMediaId,
            media_mime_type: msgObj?.media_mime_type || eventData.media_mime_type,
            media_filename: msgObj?.media_filename || eventData.media_filename,
            media_caption: msgObj?.media_caption || eventData.media_caption,
            media_url: incomingMediaUrl,
            link_preview: msgObj?.link_preview || eventData.link_preview || undefined,
            reactions: Array.isArray(msgObj?.reactions)
              ? msgObj.reactions
              : Array.isArray(eventData.reactions)
              ? eventData.reactions
              : [],
            created_at: msgTime,
          };

          setMessagesMap((prev) => {
            // Update if active or if thread is already in memory
            if (isActiveConversation || prev[targetConvId]) {
              return { ...prev, [targetConvId]: mergeWhatsAppMessages(prev[targetConvId] || [], [newMsg]) };
            }
            return prev;
          });

          // Auto-mark conversation as read if user is actively viewing it
          if (!isOutbound && isActiveConversation) {
            WhatsAppRepository.markConversationAsRead(targetConvId)
              .then((res) => reportReadSync(res, { label: `auto#${targetConvId}` }))
              .catch((err) => console.warn('[WhatsAppHubPage] Otomatik okundu istegi basarisiz:', err));
          }
        }
      }

      // 2b. MESSAGE REACTION — bir mesaja birakilan/geri cekilen ifade.
      //
      // Reaksiyon bir MESAJ DEGILDIR: `messagesMap`e yeni balon EKLEMEZ, var
      // olan balonun rozetlerini gunceller. Liste rozeti icin SUNUCUNUN
      // hesapladigi `conversation_reaction` esas alinir (eski bir mesaja
      // birakilan ifade rozeti degistirmez).
      if (eventData.event === 'message_reaction') {
        const convId = Number(eventData.conversation_id);
        const messageId = Number(eventData.message_id);
        const emoji = typeof eventData.emoji === 'string' ? eventData.emoji : '';
        const fromMe = Boolean(eventData.from_me);
        const reactorJid = eventData.reactor_jid || (fromMe ? 'ME' : '');
        if (Number.isInteger(convId) && convId > 0 && Number.isInteger(messageId) && messageId > 0 && reactorJid) {
          setMessagesMap((prev) => {
            const list = prev[convId];
            if (!list) return prev;
            const updated = applyReactionToThread(list, messageId, emoji, {
              reactorJid,
              fromMe,
            });
            return updated === list ? prev : { ...prev, [convId]: updated };
          });
          const serverReaction = eventData.conversation_reaction || null;
          setConversations((prev) =>
            prev.map((c) => (Number(c.id) === convId ? { ...c, last_reaction: serverReaction } : c)),
          );
          setSelectedConv((prev) =>
            prev && Number(prev.id) === convId ? { ...prev, last_reaction: serverReaction } : prev,
          );
        }
      }

      // 1.5. LINK PREVIEW UPDATED
      if (eventData.event === 'link_preview_updated' && eventData.preview) {
        const preview = eventData.preview;
        const targetConvId = eventData.conversation_id;
        const previewUrl = eventData.url || preview.url;
        if (targetConvId && previewUrl) {
          setMessagesMap((prev) => {
            const list = prev[targetConvId];
            if (!list) return prev;
            let changed = false;
            const updatedList = list.map((msg) => {
              if (
                msg.body &&
                (msg.body.includes(previewUrl) || (preview.url && msg.body.includes(preview.url)))
              ) {
                if (!msg.link_preview || JSON.stringify(msg.link_preview) !== JSON.stringify(preview)) {
                  changed = true;
                  return { ...msg, link_preview: preview };
                }
              }
              return msg;
            });
            return changed ? { ...prev, [targetConvId]: updatedList } : prev;
          });
        }
      }

      // 2. MESSAGE STATUS UPDATE (PENDING -> SENT -> DELIVERED -> READ / FAILED)
      if (eventData.event === 'message_status_updated') {
        const convId = eventData.conversation_id;
        const waId = eventData.wa_message_id;
        const clientMid = eventData.client_message_id;
        const serverId = eventData.id;
        const numericServerId =
          typeof eventData.message_id === 'number' && eventData.message_id > 0
            ? eventData.message_id
            : typeof serverId === 'number' && serverId > 0
              ? serverId
              : undefined;
        const newStatus = eventData.status as ConversationMessageStatus;
        const errorMsg = eventData.error_message;

        if (convId) {
          setMessagesMap((prev) => {
            const list = prev[convId];
            if (!list) return prev;
            let changed = false;
            const updated = list.map((m) => {
              const matchesWaId = waId && m.wa_message_id === waId;
              const matchesClientMid = clientMid && m.client_message_id === clientMid;
              const matchesId = numericServerId && m.id === numericServerId;
              if (matchesWaId || matchesClientMid || matchesId) {
                changed = true;
                return {
                  ...m,
                  id: numericServerId ?? m.id,
                  wa_message_id: waId || m.wa_message_id,
                  status: mergeDeliveryStatus(m.status, newStatus),
                  error_message: errorMsg || m.error_message,
                };
              }
              return m;
            });
            if (!changed) return prev;
            return { ...prev, [convId]: updated };
          });
        }
      }

      // 3. CONVERSATION STATUS / READ EVENTS
      if (eventData.event === 'conversation_status_updated') {
        const convId = eventData.conversation_id;
        const newStatus = eventData.status;
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, status: newStatus } : c))
        );
        if (selectedConvRef.current && selectedConvRef.current.id === convId) {
          setSelectedConv((prev) => (prev ? { ...prev, status: newStatus } : prev));
        }
      }

      if (eventData.event === 'conversation_read') {
        const convId = eventData.conversation_id;
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, unread_count: 0 } : c))
        );
        if (selectedConvRef.current && selectedConvRef.current.id === convId) {
          setSelectedConv((prev) => (prev ? { ...prev, unread_count: 0 } : prev));
        }
      }

      // Sohbet baska bir oturumda silindiginde liste kendiliginden temizlenir.
      // Aksi halde silinmis bir sohbet listede kalir ve acildiginda bos bir
      // mesaj akisi gosterir — kullanici bunu "mesajlar kayboldu" sanir.
      if (eventData.event === 'conversation_deleted') {
        const convId = Number(eventData.conversation_id);
        if (Number.isInteger(convId)) {
          setConversations((prev) => prev.filter((c) => c.id !== convId));
          setMessagesMap((prev) => {
            if (!(convId in prev)) return prev;
            const next = { ...prev };
            delete next[convId];
            return next;
          });
          if (selectedConvRef.current?.id === convId) setSelectedConv(null);
        }
      }

      // Faz 5: gateway'den canlı sohbet metadata'sı (isim/avatar/preview/unread)
      // — backend jid'yi sayısal conversation_id'ye çevirerek ileri iletir.
      if (eventData.event === 'conversation_updated') {
        const rawConvId = eventData.conversation_id;
        const convIdNumber = typeof rawConvId === 'number' ? rawConvId : Number(rawConvId);
        const payload = eventData.conversation || {};
        const rawJid = payload.jid || payload.phone || (typeof rawConvId === 'string' && rawConvId.includes('@') ? rawConvId : null);
        let convId = Number.isInteger(convIdNumber) && convIdNumber > 0 ? convIdNumber : null;
        if (convId === null && rawJid) {
          const match = conversationsRef.current.find((c) => {
            const cJid = c.lead_phone ? stripJidPrefix(c.lead_phone) : '';
            const cPhone = (c as any).phone ? stripJidPrefix((c as any).phone) : '';
            return cJid === stripJidPrefix(rawJid) || cPhone === stripJidPrefix(rawJid);
          });
          if (match && Number(match.id) > 0) convId = Number(match.id);
        }

        if (Number.isInteger(convId) && convId! > 0) {
          const resolvedId = convId!;
          const activeConv = selectedConvRef.current;
          const isCurrentSelected = Boolean(activeConv && Number(activeConv.id) === Number(resolvedId));
          // I-4 / Faz 5 / Faz 6: the merge lives in ONE pure helper so the list
          // row, the selected conversation and the DOM tests all run the same
          // code. See `applyConversationEvent` for the invariants.
          const patch = (c: Conversation): Conversation => {
            const patched = applyConversationEvent(c, payload, t);
            return isCurrentSelected && Number(c.id) === Number(resolvedId)
              ? { ...patched, unread_count: 0 }
              : patched;
          };
          if (!knownConvIdsRef.current.has(resolvedId)) {
            // Sorun 4/5 (grup dahil her sohbet first-class): gateway'den gelen
            // YENI sohbet, hedefli GET yanitini BEKLEMEDEN listeye eklenir.
            // Eskiden yalnizca `hydrateConversation` calisiyordu; o istek
            // yavasladiginda/basarisiz oldugunda satir listede HIC olusmuyordu
            // (ornegin yeni bir grup "3Hacker" sohbet listesinde kayboluyordu).
            // Burada WS payload'i kanonik alan adlariyla gelir; gecici olarak
            // gosterilir, hedefli GET satiri DB gercegiyle mutabik kilar.
            const seeded = mapConversationItem({ ...payload, id: resolvedId });
            setConversations((prev) => {
              if (prev.some((c) => Number(c.id) === Number(resolvedId))) return prev;
              const fresh: Conversation = { status: 'ACTIVE' as ConversationStatus, unread_count: isCurrentSelected ? 0 : (seeded.unread_count ?? 0), ...seeded };
              return [fresh, ...prev].sort(compareByLastMessageDesc);
            });
            hydrateConversation(resolvedId);
          }
          setConversations((prev) => {
            const next = prev.map((c) => (Number(c.id) === Number(resolvedId) ? patch(c) : c));
            // Sorun 2: patch son mesaji/siralamayi degistirdiyse liste zaman
            // damgasina gore yeniden siralanir (API sirasiyla ayni kural).
            const patched = next.find((c) => Number(c.id) === Number(resolvedId));
            const before = prev.find((c) => Number(c.id) === Number(resolvedId));
            if (patched && before && patched.last_message_at !== before.last_message_at) {
              return [...next].sort(compareByLastMessageDesc);
            }
            return next;
          });
          setSelectedConv((prev) => {
            if (!prev) {
              // Sorun 3 (WhatsApp Web akisi): ilk secilebilir sohbet, liste
              // dolarken hazirlanir — kullanici bos ekranla kalmaz.
              const seeded = mapConversationItem({ ...payload, id: resolvedId });
              return { status: 'ACTIVE' as ConversationStatus, unread_count: 0, ...seeded };
            }
            return Number(prev.id) === Number(resolvedId) ? patch(prev) : prev;
          });

          // LIVE CHAT THREAD UPDATE:
          // If the currently open conversation received an update, check if messagesMap has the latest message.
          // If not (e.g. message_new raced or was not yet merged), hydrate messages immediately!
          if (isCurrentSelected) {
            const currentMsgs = messagesMapRef.current?.[resolvedId] || [];
            const lastMsg = currentMsgs[currentMsgs.length - 1];
            const payloadTime = payload.last_message_at;
            const isNewer = Boolean(
              payloadTime && (!lastMsg?.created_at || new Date(payloadTime).getTime() > new Date(lastMsg.created_at).getTime())
            );
            if (isNewer || currentMsgs.length === 0) {
              void hydrateConversationMessages(resolvedId);
            }
            if ((payload.unread_count ?? 0) > 0) {
              WhatsAppRepository.markConversationAsRead(resolvedId)
                .then((res) => reportReadSync(res, { label: `cu#${resolvedId}` }))
                .catch((err) => console.warn('[WhatsAppHubPage] Read sync failed on conversation_updated:', err));
            }
          }
        }
      }

      if (eventData.event === 'contact_synced') {
        const contact = (eventData.contact || {}) as {
          jid?: string;
          id?: string;
          phone?: string;
          avatar_url?: string | null;
        };
        const avatarUrl = contact.avatar_url;
        const jid = contact.jid || contact.id;
        // §31: identity/phone normalization lives ONLY in `whatsappIdentity`.
        // `matchPhone` is the canonical E.164 form; `rawJid` is the exact-JID
        // fallback for identifiers that are not phone numbers (LID / group).
        const rawJid = jid ? stripJidPrefix(jid) : null;
        const matchPhone = extractCleanPhone(contact.phone || jid || null);
        if (avatarUrl && (matchPhone || rawJid)) {
          setConversations((prev) =>
            prev.map((c) => {
              const cRaw = c.lead_phone || (c as any).phone || '';
              const cPhone = extractCleanPhone(cRaw);
              if (
                (matchPhone && cPhone === matchPhone) ||
                (rawJid && cRaw && stripJidPrefix(cRaw) === rawJid)
              ) {
                return { ...c, lead_avatar_url: avatarUrl };
              }
              return c;
            })
          );
          setSelectedConv((prev) => {
            if (!prev) return prev;
            const pRaw = prev.lead_phone || (prev as any).phone || '';
            const prevPhone = extractCleanPhone(pRaw);
            if (
              (matchPhone && prevPhone === matchPhone) ||
              (rawJid && pRaw && stripJidPrefix(pRaw) === rawJid)
            ) {
              return { ...prev, lead_avatar_url: avatarUrl };
            }
            return prev;
          });
        }
      }

      // D5: 'new_conversation' hicbir yerde yayinlanmadi — gercek olay adi
      // 'conversations_updated'tir.
      if (eventData.event === 'conversations_updated') {
        if (eventData.conversation && eventData.conversation.id) {
          // Targeted insertion without full list refetch.
          // `mapConversationItem` yalnizca payload'da GERCEKTEN gonderilen
          // alanlari kopyalar (kismi realtime payload'larin mevcut ad/telefon
          // bilgisini `undefined` ile silmesini engeller). Yeni bir satir
          // eklenirken zorunlu alanlar burada varsayilanlanir.
          const mapped = mapConversationItem(eventData.conversation);
          setConversations((prev) => {
            if (prev.some((c) => c.id === mapped.id)) {
              return prev.map((c) => (c.id === mapped.id ? { ...c, ...mapped } : c)).sort(compareByLastMessageDesc);
            }
            const fresh = { status: 'ACTIVE' as ConversationStatus, unread_count: 0, ...mapped };
            return [fresh, ...prev].sort(compareByLastMessageDesc);
          });
        } else if (eventData.conversation_id) {
          hydrateConversation(Number(eventData.conversation_id));
        } else {
          // Full refetch retained only when event payload lacks conversation data to mutate accurately
          loadConversations(true);
        }
        fetchSessions(true);
        onRefreshStatsRef.current();
      }

      // Faz 11: WS tabanli chunked initial-sync olaylari — HTTP polling yerine
      // backend job'i bu olaylari mevcut /ws hattiyla sahibine yollar (§13).
      if (String(eventData.event || '').startsWith('whatsapp_sync_')) {
        // Faz 6 (P0.4): canli sohbet akisi sinyali — job'dan bagimsiz
        // (sync_id='live'), stale filtresinden once islenir. Backend
        // conversation_updated'i DB'ye yazdiginda gelir; UI GET /conversations
        // ile saniyeler icinde gercek sohbetleri gosterir — job'un
        // chats_snapshot'unu beklemez (WhatsApp Web paritesi).
        if (eventData.event === 'whatsapp_sync_chats_bootstrap') {
          scheduleBootstrapFetch();
          return;
        }
        const syncId = (eventData.sync_id as string) || null;
        const isStale = Boolean(syncId && activeSyncIdRef.current && syncId !== activeSyncIdRef.current);
        // §14: bay (stale) job'un gec gelen olaylari YOK SAYILIR. 'started' her
        // zaman benimsenir — yeni job basladiysa aktif kimlik guncellenir.
        if (isStale && eventData.event !== 'whatsapp_sync_started') {
          // eski job'un olayi — sessizce yok say
        } else if (eventData.event === 'whatsapp_sync_started') {
          activeSyncIdRef.current = syncId;
          syncMsgBufferRef.current = {};
          setSessionSync({
            phase: 'syncing', stage: 'starting', progress: 4,
            chats_synced: 0, contacts_synced: 0, messages_synced: 0,
            started_at: eventData.started_at || new Date().toISOString(), completed_at: null,
          });
        } else if (eventData.event === 'whatsapp_sync_contacts_snapshot') {
          setSessionSync((prev) => (prev && prev.phase === 'syncing' ? {
            ...prev, stage: 'contacts', contacts_synced: eventData.total ?? prev.contacts_synced,
            progress: computeSyncProgress('contacts', prev.chats_synced ?? 0, eventData.total ?? 0, prev.messages_synced ?? 0, 0),
          } : prev));
        } else if (eventData.event === 'whatsapp_sync_chats_snapshot') {
          // Sohbetler sayfa sayfa INCREMENTAL eklenir — tam liste rebuild yok (§29).
          const incoming: Conversation[] = (eventData.conversations || []).map((c: any) => mapConversationItem(c));
          if (incoming.length > 0) {
            setConversations((prev) => {
              const byId = new Map(prev.map((c) => [c.id, c]));
              for (const c of incoming) {
                const existing = byId.get(c.id);
                byId.set(c.id, existing && !shouldApplyPreview(c.last_message_at, existing.last_message_at)
                  ? { ...c, ...existing } : { ...existing, ...c });
              }
              return Array.from(byId.values()).sort(compareByLastMessageDesc);
            });
            setSelectedConv((prev) => prev || incoming[0] || null);
          }
          setSessionSync((prev) => (prev && prev.phase === 'syncing' ? {
            ...prev, stage: 'chats', chats_synced: eventData.total ?? prev.chats_synced,
            progress: computeSyncProgress('chats', eventData.total ?? 0, prev.contacts_synced ?? 0, prev.messages_synced ?? 0, 0),
          } : prev));
        } else if (eventData.event === 'whatsapp_sync_messages_chunk') {
          // Mesaj chunk'lari tampona birikir; YALNIZCA acik sohbetin store'u
          // incremental guncellenir — 16k mesajlik DOM rebuild yok (§29).
          const raw: any[] = eventData.messages || [];
          if (raw.length > 0) {
            const buf = syncMsgBufferRef.current;
            const byConv: Record<number, Message[]> = {};
            for (const m of raw) {
              const cid = Number(m.conversation_id);
              if (!Number.isFinite(cid)) continue;
              const mapped = mapMessageItem(m, cid);
              (buf[cid] = buf[cid] || []).push(mapped);
              (byConv[cid] = byConv[cid] || []).push(mapped);
            }
            // Bu dinleyici bilinçli olarak stabil tutulur (deps'te selectedConv
            // YOK); state'e kapanan erisim bayat kalir. Acik sohbet kimligi
            // message_new isleyicisiyle ayni sekilde ref'ten okunmalidir.
            const openId = selectedConvRef.current?.id;
            if (openId && byConv[openId]) {
              setMessagesMap((prev) => {
                return { ...prev, [openId]: mergeWhatsAppMessages(prev[openId] || [], byConv[openId]) };
              });
            }
          }
          setSessionSync((prev) => (prev && prev.phase === 'syncing' ? {
            ...prev, stage: 'messages', messages_synced: eventData.synced ?? prev.messages_synced,
            progress: computeSyncProgress('messages', prev.chats_synced ?? 0, prev.contacts_synced ?? 0, eventData.synced ?? 0, eventData.total ?? 0),
          } : prev));
        } else if (eventData.event === 'whatsapp_sync_progress') {
          setSessionSync((prev) => (prev && prev.phase === 'syncing' ? {
            ...prev,
            stage: eventData.stage || prev.stage,
            chats_synced: eventData.chats_synced ?? prev.chats_synced,
            contacts_synced: eventData.contacts_synced ?? prev.contacts_synced,
            messages_synced: eventData.messages_synced ?? prev.messages_synced,
            // Sorun: burada eksik alanlar `0`'a dusuyordu (yukaridaki durum
            // alanlari ise `prev`'e dusuyor). Alanlardan biri gelmezse
            // computeSyncProgress sifir sayaclarla hesaplanip ilerlemeyi
            // GERIYE dusuruyordu. Artik `prev`'e dusulur — ilerleme geriye
            // gitmez, uydurma deger uretilmez.
            progress: computeSyncProgress(
              eventData.stage || prev.stage || 'messages',
              eventData.chats_synced ?? prev.chats_synced ?? 0,
              eventData.contacts_synced ?? prev.contacts_synced ?? 0,
              eventData.messages_synced ?? prev.messages_synced ?? 0,
              eventData.messages_total ?? prev.messages_total ?? 0
            ),
          } : prev));
        } else if (eventData.event === 'whatsapp_sync_complete') {
          // Tamamlanma: cozulmus TAM sohbet listesi gelir (preview'lar dahil) —
          // banner gercek bitiste kapanir, sahte kapanis yok (§20/§27).
          const finalList: Conversation[] = (eventData.conversations || []).map((c: any) => mapConversationItem(c));
          if (finalList.length > 0) {
            setConversations((prev) => {
              const byId = new Map(prev.map((c) => [c.id, c]));
              for (const item of finalList) {
                const current = byId.get(item.id);
                byId.set(item.id, current && !shouldApplyPreview(item.last_message_at, current.last_message_at)
                  ? { ...item, ...current } : item);
              }
              return [...byId.values()].sort(compareByLastMessageDesc);
            });
          }
          setSessionSync((prev) => ({
            ...(prev || {}), phase: 'ready', stage: 'complete', progress: 100,
            chats_synced: eventData.chats_synced ?? prev?.chats_synced,
            contacts_synced: eventData.contacts_synced ?? prev?.contacts_synced,
            messages_synced: eventData.messages_synced ?? prev?.messages_synced,
            completed_at: eventData.finished_at || new Date().toISOString(),
          }));
          setIsSyncingChats(false);
          activeSyncIdRef.current = null;
          syncMsgBufferRef.current = {};
          fetchSessions(true);
          onRefreshStatsRef.current();
          // The BACKEND's first sync just reached its terminal state, and its
          // durable stamp (`initial_sync_completed_at`) was committed BEFORE this
          // event was broadcast. The full-screen gate is fed ONLY by the backend
          // authority (`loadingGate.phase === 'syncing_history'`), and the single
          // signal that re-asks it — the gateway's `session_sync_completed` — now
          // arrives EARLIER than this event, because the backend job waits for the
          // gateway's history sync before it pulls. Without this refresh the gate
          // would keep showing "loading chats" after everything had finished,
          // until a remount or a WS reconnect.
          void refreshLoadingGate();
        } else if (eventData.event === 'whatsapp_sync_failed') {
          // Sorun 8: basarisizlik kullaniciya BIR KEZ gosterilir ve
          // acknowledged olarak isaretlenir — backend'de tutulan ayni job
          // sonraki sayfa acilisinda banner'i yeniden acmaz.
          acknowledgeFailedSync(syncId);
          failedSyncKeyRef.current = syncId;
          setSessionSync({ phase: 'error', stage: eventData.stage || 'failed', error: eventData.error || null, progress: 0 });
          setIsSyncingChats(false);
          activeSyncIdRef.current = null;
          // A failed job is a real failure, never a hidden one. Re-ask the gate so
          // it reports `error` (with the retry affordance) instead of leaving the
          // full-screen gate stuck on `syncing_history` — the job snapshot stays
          // `FAILED` in memory, so the backend answers honestly.
          void refreshLoadingGate();
          if (eventData.error_code === 'RELINK_REQUIRED') {
            fetchSessions(true);
            toast.error(t('whatsapp.syncRelinkRequired'), t('common.error'));
          } else {
            toast.error(eventData.error || t('whatsapp.syncFailed'), t('common.error'));
          }
        }
      }

      // Gateway completion is not persistence completion. Backend sync snapshots
      // and chunks deliver the committed entities without replacing loaded history.

      // Faz 7: gateway initial-sync yasam dongusu (QR sonrasi GERCEK ilerleme).
      // Faz 11: polling yok — ilerleme WS olaylarinda; bu olaylar yalnizca
      // banner'i gateway (Baileys) asamasinda besler.
      if (eventData.event === 'session_sync_started' || eventData.event === 'session_sync_progress') {
        const sync = (eventData.sync || null) as SessionSyncState | null;
        // WS sync job'i aktifse banner job olaylarina birakilir; gateway
        // (Baileys) asamasinda yalnizca job yokken bu olaylar banner'i besler.
        if (sync && !activeSyncIdRef.current) {
          setSessionSync(sync);
        }
      }
      if (eventData.event === 'session_sync_completed') {
        const sync = (eventData.sync || null) as SessionSyncState | null;
        if (sync && !activeSyncIdRef.current) {
          // The gateway finishing ITS history pass is not the backend's first
          // sync finishing (chats snapshot + contacts + messages + empty-chat
          // backfill, stamped as `initial_sync_completed_at`). Promoting to
          // 'ready' here closed the full-screen gate while the real progress was
          // still moving — reported as "loading screen closes before it
          // completes, messages load instantly". Ask the two real authorities
          // (sync job + loading gate) and let them answer.
          void refreshSyncStatus();
          void refreshLoadingGate();
        }
      }

      // 4. PRESENCE UPDATE ('yazıyor...' göstergesi) — backend jid'yi sayısal
      // conversation_id'ye çevirip `typing` boolean'ı ekler.
      if (eventData.event === 'presence_updated') {
        const rawId = eventData.conversation_id;
        const convId = typeof rawId === 'number' ? rawId : parseInt(String(rawId), 10);
        if (!Number.isNaN(convId)) {
          const typing = !!eventData.typing;
          if (typing) {
            // F-11: TTL applies to ALL conversations. The single sweep interval
            // (above) removes the indicator ~10s after the last update even if
            // the 'paused' event never arrives.
            peerTypingExpiryRef.current[convId] = Date.now() + PEER_TYPING_TTL_MS;
            setPeerTypingMap((prev) => (prev[convId] ? prev : { ...prev, [convId]: true }));
          } else {
            clearPeerTyping(convId);
          }
        }
      }
    };

    // Reconnect Recovery: WS dustuyse job arka planda calismaya devam eder —
    // reconnect'te TEK seferlik GET /sync/job ile devam eden job benimsenir
    // (yeniden indirme YOK, §28) + sessiz mutabakat.
    const handleReconnect = () => {
      console.log('[WhatsAppHubPage] WebSocket reconnected. Performing silent reconciliation...');
      void refreshSyncStatus();
      loadConversations(true);
      const activeId = selectedConvRef.current?.id;
      if (activeId) {
        WhatsAppRepository.getConversationMessages(activeId, { limit: 50 })
          .then((res) => {
            if (res?.messages) {
              setMessagesMap((prev) => {
                const buf = syncMsgBufferRef.current[activeId] || [];
                return { ...prev, [activeId]: mergeWhatsAppMessages(
                  prev[activeId] || [], [...res.messages, ...buf]) };
              });
            }
          })
          .catch(logBackgroundFetchFailure('reconnect mesaj mutabakati'));
      }
    };

    window.addEventListener('tezlify:ws_event', handleWsEvent);
    window.addEventListener('tezlify:ws_connected', handleReconnect);
    return () => {
      window.removeEventListener('tezlify:ws_event', handleWsEvent);
      window.removeEventListener('tezlify:ws_connected', handleReconnect);
    };
    // Deliberately narrower than what the handler closes over. These are the
    // long-lived, memoised entry points; the rest are read through refs or are
    // pure setters, and listing them would tear down and re-register both WS
    // listeners on every render, dropping events mid-flight. This wiring is
    // covered by verify:realtime (9/9 scenarios) — change it only with that
    // suite running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConversations, refreshSyncStatus, reportReadSync, logBackgroundFetchFailure, hydrateConversation, clearPeerTyping, acknowledgeFailedSync, scheduleBootstrapFetch, refreshLoadingGate]);

  // Anti-ban: the editor itself is <AntiBanPanel>, but the tab button shows an
  // unsaved-changes dot, so the page still needs to know whether the config
  // differs from the last server-confirmed one. It subscribes to the same hook
  // rather than holding a second, divergent copy of the state.
  const { hasUnsavedChanges } = useAntiBanSettings();

  const fetchSessions = useCallback(async (silent = false) => {
    try {
      setSessions(await WhatsAppRepository.getWhatsAppSessions());
    } catch (err: any) {
      if (!silent) toast.error(err?.message || t('common.error'), t('common.error'));
    }
  }, [t, toast]);

  const handleQrSuccess = useCallback(() => {
    // QR eslesmesi sonrasi otomatik olarak Canli Diyaloglar sekmesine gec
    setHubTab('conversations');
    setIsPostQrSyncing(true);
    setSyncGateDismissed(false);
    fetchSessions(true);
    onRefreshStats();
    // Faz 6 (PHASE-17 cache-first): QR sonrasi ONCE DB'deki kalici sohbet
    // snapshot'i aninda yuklenir (reconnect'te kullanici 2-3 sn'de listeyi
    // gorur); gercek zamanli tazeleme WS bootstrap/chats_snapshot olaylariyla
    // ve job ile arkadan gelir. Sahte veri yok — yalnizca kalici gercek satirlar.
    loadConversations(true);
    // Faz 7/11: QR sonrasi initial-sync hemen izlenmeye baslanir — devam eden
    // job varsa GET /sync/job ile benimsenir, ilerleme WS olaylarinda akar.
    refreshSyncStatus();
    // Faz 4: tek-authority loading gate de ayni anda beslenir (avatar sayaclari
    // dahil); `ready` aninda hook otomatik gecisi tetikler.
    void refreshLoadingGate();
    // Sıfır tıklama eşitleme: QR eşleşmesi tamamlanır tamamlanmaz canlı veri çekimini başlat
    void handleSyncChats();
  }, [fetchSessions, onRefreshStats, refreshSyncStatus, loadConversations, handleSyncChats, refreshLoadingGate]);

  const handleOpenQrConnect = useCallback(() => {
    setReconnectSessionId(undefined);
    setIsQrConnectModalOpen(true);
  }, []);

  useEffect(() => {
    fetchSessions();

    // Listen to real-time WhatsApp session events.
    // D5: 'inbound_reply', 'number_updated' ve 'conversations_cleared'
    // adlarini ne gateway ne backend HICBIR yerde yayinlar (gercek akis
    // message_new / conversations_updated / session_* uzerindendir) — lu
    // dallar kaldirildi.
    const handleWs = (e: Event) => {
      const eventData = (e as CustomEvent<any>).detail;
      if (
        eventData?.event === 'session_connected' ||
        eventData?.event === 'session_disconnected' ||
        eventData?.event === 'session_updated'
      ) {
        fetchSessions(true);
        onRefreshStatsRef.current();
        loadConversations(true);
        // Faz 7: baglanti degisikliginde gercek sync durumunu cek (banner icin)
        refreshSyncStatus();
      } else if (
        eventData?.event === 'session_sync_started' ||
        eventData?.event === 'session_sync_completed'
      ) {
        // Handoff: `session_sync_progress` fires on EVERY history chunk. The
        // banner is fed by the progress event handler; refreshing sessions /
        // sync status here too produced an API storm during a long sync, so
        // these refreshes happen only on start and on completion.
        fetchSessions(true);
        onRefreshStatsRef.current();
        refreshSyncStatus();
      }
    };
    window.addEventListener('tezlify:ws_event', handleWs);
    // Faz 7: sayfa acildiginda devam eden bir initial-sync varsa banner hemen gorunsun
    refreshSyncStatus();

    return () => {
      window.removeEventListener('tezlify:ws_event', handleWs);
    };
    // Faz 12: `onRefreshStats` BİLEREK bağımlılıkta DEĞİL — ref üzerinden
    // okunur, böylece üst bileşen yeniden render olduğunda bu kurulum effect'i
    // (ve içindeki 3 HTTP isteği) tekrar tetiklenmez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchSessions, refreshSyncStatus]);


  const handleDisconnectSession = async (sessionId: number) => {
    if (disconnectingSessionId) return;
    const ok = await toast.confirm({
      title: t('whatsapp.disconnect'),
      message: t('whatsapp.disconnectConfirm'),
      confirmText: t('whatsapp.disconnect'),
      cancelText: t('common.cancel'),
      variant: 'warning',
    });
    if (!ok) return;

    setDisconnectingSessionId(sessionId);
    try {
      await WhatsAppRepository.disconnectSession(sessionId);
      await fetchSessions(true);
      toast.success(t('whatsapp.disconnectedSuccess'), t('common.success'));
      onRefreshStats();
    } catch (err: any) {
      toast.error(err?.message || t('common.error'), t('common.error'));
    } finally {
      setDisconnectingSessionId(null);
    }
  };

  const handleDeleteSession = async (sessionId: number) => {
    if (deletingSessionId) return;
    const ok = await toast.confirm({
      title: t('whatsapp.deleteSession'),
      message: t('whatsapp.deleteSessionConfirm'),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (!ok) return;

    setDeletingSessionId(sessionId);
    try {
      await WhatsAppRepository.deleteSession(sessionId);
      setSessions((prev) => prev.filter((session) => session.id !== sessionId));
      // Product rule: deleting a line wipes live dialogs. Clear immediately
      // and reload from the server instead of relying solely on the realtime
      // event (which can be missed on a reconnecting socket).
      setConversations([]);
      setSelectedConv(null);
      setMessagesMap({});
      await loadConversations(true);
      toast.success(t('whatsapp.deletedSuccess'), t('common.success'));
      onRefreshStats();
    } catch (err: any) {
      toast.error(translateApiError(err, t) || t('whatsapp.deleteSessionFailed'), t('common.error'));
      await loadConversations(true);
    } finally {
      setDeletingSessionId(null);
    }
  };

  return (
    <div className="space-y-6 pb-16 select-none animate-fade-in">
      {/* Top Header & Tab Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-extrabold text-slate-800 dark:text-white flex items-center gap-2">
            {hubTab === 'conversations' ? (
              <>
                <MessageSquare className="w-5 h-5 text-[#25D366]" />
                {t('whatsapp.conversationsTitle')}
              </>
            ) : hubTab === 'sessions' ? (
              <>
                <Smartphone className="w-5 h-5 text-[#28C76F]" />
                {t('whatsapp.sessionsTitle')}
              </>
            ) : (
              <>
                <ShieldCheck className="w-5 h-5 text-[#7367F0]" />
                {t('whatsapp.antiBanTitle')}
              </>
            )}
          </h2>
          <p className="text-xs text-slate-500 dark:text-[#7E7F96] mt-0.5 font-medium">
            {hubTab === 'conversations'
              ? t('whatsapp.conversationsSubtitle')
              : hubTab === 'sessions'
              ? t('whatsapp.sessionsSubtitle')
              : t('whatsapp.antiBanSubtitle')}
          </p>
        </div>

        {/* Live Gateway Status Badge */}
        <div className="shrink-0">
          <Badge
            className={`text-[10px] font-extrabold px-2.5 py-1 rounded-xl transition-all ${
              liveStatus === LiveModeStatus.LIVE_CONNECTED
                ? 'bg-[#25D366]/20 text-[#25D366] dark:bg-[#25D366]/15'
                : liveStatus === LiveModeStatus.LIVE_CONNECTING
                ? 'bg-amber-400/20 text-amber-600 dark:bg-amber-400/15'
                : 'bg-slate-400/20 text-slate-500 dark:bg-slate-400/15'
            }`}
          >
            {liveStatus === LiveModeStatus.LIVE_CONNECTED
              ? t('whatsapp.liveBadgeConnected')
              : liveStatus === LiveModeStatus.LIVE_CONNECTING
              ? t('whatsapp.liveBadgeConnecting')
              : t('whatsapp.liveBadgeDisconnected')}
          </Badge>
        </div>

        {/* Segmented Tab Switcher */}
        <div className="flex p-1 rounded-2xl bg-slate-200/80 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.08] w-full md:w-auto shrink-0">
          <button
            type="button"
            onClick={() => setHubTab('conversations')}
            className={`flex-1 md:flex-initial py-1.5 px-3.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer whitespace-nowrap ${
              hubTab === 'conversations'
                ? 'bg-white dark:bg-[#7367F0] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t('whatsapp.tabConversations')}</span>
            {conversations.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-[#25D366]/20 text-[#25D366] dark:text-[#25D366] shrink-0">
                {conversations.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setHubTab('sessions')}
            className={`flex-1 md:flex-initial py-1.5 px-3.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer whitespace-nowrap ${
              hubTab === 'sessions'
                ? 'bg-white dark:bg-[#7367F0] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t('whatsapp.tabSessions')}</span>
          </button>

          <button
            type="button"
            onClick={() => setHubTab('antiban')}
            className={`flex-1 md:flex-initial py-1.5 px-3.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer whitespace-nowrap ${
              hubTab === 'antiban'
                ? 'bg-white dark:bg-[#7367F0] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t('whatsapp.tabAntiBan')}</span>
            {hasUnsavedChanges && (
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
            )}
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 1. CANLI DİYALOGLAR (CONVERSATIONS) PANELİ */}
      {/* ========================================================================= */}
      {hubTab === 'conversations' && (
        <Card className="w-full max-w-full h-[calc(100dvh-16rem)] max-h-[calc(100dvh-8rem)] min-h-[320px] md:h-[calc(100dvh-16.5rem)] md:min-h-[480px] md:max-h-[calc(100dvh-15.5rem)] p-0 flex flex-col md:flex-row overflow-hidden border border-slate-200/80 dark:border-white/[0.08] shadow-sm" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
          {/* Faz 14 — QR sonrasi senkron kapisi (WhatsApp Web paritesi): ilk
              senkron surerken sohbet listesi ve sohbet paneli HIC render
              EDILMEZ. Boylece bir sohbete tiklamak "o an indirme" yoluna
              dusemez; kullanici listeyi ancak veri hazir oldugunda gorur. */}
          {syncGateActive ? (
            <WhatsAppSyncGate
              sync={sessionSync}
              loadingGate={loadingGate}
              showEscape={syncGateEscapeVisible}
              onContinueAnyway={handleSyncGateContinueAnyway}
              onRetry={() => {
                setIsPostQrSyncing(true);
                setSyncGateDismissed(false);
                void refreshLoadingGate();
                void handleSyncChats();
              }}
            />
          ) : (
          <>
          {/* Left: Conversation List — SABIT genislik (Sorun 11/12/13):
              secilen sohbet sayisindan bagimsiz olarak sidebar ve chat alani
              ayni genislikte kalir. */}
          <div className={`w-full md:w-80 lg:w-96 md:max-w-80 lg:max-w-96 shrink-0 grow-0 h-full flex flex-col min-w-0 ${selectedConv ? 'hidden md:flex' : 'flex'}`}>
            {/* Faz 7/11: GERCEK initial-sync banneri — yalnizca backend'den
                gelen asama/sayaclar gosterilir (sahte progress yok); job
                gercekten tamamlaninca (whatsapp_sync_complete) kapanir. */}
            {sessionSync?.phase === 'syncing' && (
              <div className="mx-3 mt-3 rounded-xl border border-[#7367F0]/30 bg-[#7367F0]/5 dark:bg-[#7367F0]/10 px-3 py-2.5 shrink-0">
                <div className="flex items-center space-x-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#7367F0] shrink-0" />
                  <span className="text-[11px] font-bold text-[#7367F0] dark:text-[#a29bfe]">
                    {t('whatsapp.syncInProgressBanner')}
                  </span>
                  <span className="ml-auto text-[10px] font-extrabold text-[#7367F0]">{Math.max(0, Math.min(100, Math.round(sessionSync.progress || 0)))}%</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-[#7367F0]/15 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#7367F0] to-[#a29bfe] transition-all duration-700"
                    style={{ width: `${Math.max(4, Math.min(100, Math.round(sessionSync.progress || 0)))}%` }}
                  />
                </div>
                <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                  {(() => {
                    // F-9: dynamic stage key must resolve; if an unforeseen
                    // stage arrives, fall back to a real translation instead of
                    // rendering the raw key.
                    const stageKey = `whatsapp.syncStage.${sessionSync.stage || 'starting'}`;
                    const stageLabel = t(stageKey);
                    // G-6 handoff: prefer the gateway's real unique entity
                    // counts; the legacy `*_synced` counters are cumulative
                    // per-event totals and are misleading as entity counts.
                    const counts = resolveSyncDisplayCounts(sessionSync);
                    return (
                      <>
                        {stageLabel === stageKey ? t('whatsapp.syncingChats') : stageLabel}
                        {` · ${t('whatsapp.syncingContactsCount', { count: counts.contacts })}`}
                        {` · ${t('whatsapp.syncingChatsCount', { count: counts.chats })}`}
                        {` · ${t('whatsapp.syncingMessagesCount', { count: counts.messages })}`}
                      </>
                    );
                  })()}
                </p>
              </div>
            )}
            {/* Sorun 8: tamamlanma GERCEK bitise baglidir; bildirim kisaca
                gosterilip kaybolur (sahte progress degil, tamamlanma mesaji). */}
            {sessionSync?.phase === 'ready' && (
              <div className="mx-3 mt-3 rounded-xl border border-[#28C76F]/40 bg-[#28C76F]/5 dark:bg-[#28C76F]/10 px-3 py-2.5 shrink-0 flex items-center space-x-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#28C76F] shrink-0" />
                <span className="text-[11px] font-bold text-[#28C76F]">
                  {t('whatsapp.syncCompletedBanner')}
                </span>
              </div>
            )}
            {sessionSync?.phase === 'error' && (
              <div className="mx-3 mt-3 rounded-xl border border-rose-400/40 bg-rose-500/5 dark:bg-rose-500/10 px-3 py-2.5 shrink-0">
                <div className="flex items-center space-x-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  <span className="text-[11px] font-bold text-rose-600 dark:text-rose-400">
                    {t('whatsapp.syncFailedTitle')}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      // Retry: ayni basarisizlik bir daha banner acmasin; yeni
                      // deneme yeni sync_id uretir (Sorun 8).
                      acknowledgeFailedSync(failedSyncKeyRef.current ?? activeSyncIdRef.current);
                      setSessionSync(null);
                      void handleSyncChats();
                    }}
                    className="ml-auto text-[10px] font-extrabold text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                  >
                    {t('whatsapp.syncRetry')}
                  </button>
                </div>
                {sessionSync.error && (
                  <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400 break-words">{sessionSync.error}</p>
                )}
              </div>
            )}
            {/* Bekleyen bölünmüş sohbetler: operatör tek tıkla onarır. Yalnızca
                GERÇEK aday varsa görünür; "bekleyen yok" diye yeşil bir rozet
                YOKTUR (sessizlik iddia değildir, sonda hatası da "temiz"
                gösterilmez). */}
            {lidSplits.length > 0 && (
              <div className="mx-3 mt-3 rounded-xl border border-amber-400/40 bg-amber-400/5 dark:bg-amber-400/10 px-3 py-2.5 shrink-0">
                <div className="flex items-center space-x-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400">
                    {t('whatsapp.lidSplitBannerTitle').replace('{count}', String(lidSplits.length))}
                  </span>
                  <button
                    type="button"
                    onClick={() => { void handleRepairLidSplits(); }}
                    disabled={lidSplitsMerging}
                    className="ml-auto text-[10px] font-extrabold text-amber-600 dark:text-amber-400 hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-default"
                  >
                    {lidSplitsMerging ? t('whatsapp.lidSplitMerging') : t('whatsapp.lidSplitMerge')}
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                  {t('whatsapp.lidSplitBannerBody')
                    .replace('{count}', String(lidSplits.length))
                    .replace('{messages}', String(lidSplits.reduce((sum, item) => sum + item.message_count, 0)))}
                </p>
              </div>
            )}
            <ConversationList
              conversations={conversations}
              selectedId={selectedConv?.id}
              loading={convsLoading}
              // Sorun 1/16/17: LOADING ≠ EMPTY ≠ ERROR — liste bilesenine
              // acik yukleme durumu verilir; ilk yukleme bitmeden "sohbet yok"
              // gosterilmez, gercek hata ayri error ekranidir.
              loadState={convLoadState}
              loadError={convLoadError}
              onRetryLoad={handleRetryLoadConversations}
              searchQuery={convSearch}
              onSearchChange={setConvSearch}
              activeFilter={convFilter}
              onFilterChange={setConvFilter}
              onNewChat={handleNewChat}
              onSync={handleSyncChats}
              isSyncing={isSyncingChats}
              typingMap={peerTypingMap}
              onLoadMore={loadMoreConversations}
              hasMore={hasMoreConvs}
              loadingMore={loadingMoreConvs}
              onSelect={handleSelectConversation}
              // Satir menusu (asagi ok). Dordunun de kimligi sabittir; satir
              // memo'su bu yuzden bozulmaz.
              onArchive={handleArchiveConversation}
              onClose={handleCloseConversation}
              onReopen={handleReopenConversation}
              onDelete={handleDeleteConversation}
            />
          </div>

          {/* Right: Active Chat View — Sorun 11/12/13: SABIT layout. Bu tek
              container her secimde AYNI genislikte kalir; `min-w-0` +
              `overflow-hidden` yatay buyumeyi engeller ve secim yeni bir pane
              EKLEMEZ, yalnizca icerigi degistirir. */}
          <div className={`flex-1 w-0 min-w-0 overflow-hidden flex flex-col h-full bg-white dark:bg-[#181C28] ${selectedConv ? 'flex' : 'hidden md:flex'}`}>
            {selectedConv ? (
              <>
                {/* Active Chat Header */}
                <div className="p-3 sm:p-3.5 border-b border-slate-200/80 dark:border-white/[0.08] bg-slate-50/50 dark:bg-black/20 flex items-center justify-between shrink-0 gap-2">
                  <div className="flex items-center space-x-2 sm:space-x-3 min-w-0 flex-1">
                    {/* Mobile Back Button to Conversation List */}
                    <button
                      type="button"
                      onClick={() => setSelectedConv(null)}
                      className="md:hidden p-1.5 -ml-1 rounded-lg text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-white/[0.08] transition-all cursor-pointer shrink-0"
                      aria-label={t('common.back')}
                      title={t('common.back')}
                    >
                      <ArrowLeft className="w-5 h-5" />
                    </button>

                    {(() => {
                      const rawPhone = selectedConv.lead_phone || (selectedConv as any).phone;
                      const headerDisplayName = getConversationDisplayName(selectedConv, t);
                      const headerCleanPhone = extractCleanPhone(rawPhone);
                      return (
                        <>
                          <Avatar
                            name={headerDisplayName}
                            image={selectedConv.lead_avatar_url}
                            phone={headerCleanPhone || (!isRawWhatsAppIdentity(rawPhone) ? rawPhone : undefined)}
                            size="md"
                            shape="rounded"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center space-x-2 truncate">
                              {selectedConv.is_group && (
                                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25">
                                  <Users className="w-3 h-3" />
                                  <span>{t('whatsapp.group')}</span>
                                </span>
                              )}
                              <h4 className="font-extrabold text-sm text-slate-800 dark:text-white truncate">
                                {headerDisplayName}
                              </h4>
                              {selectedConv.status !== 'ACTIVE' && (
                                <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-200 dark:bg-white/10 text-slate-500 dark:text-slate-400 shrink-0">
                                  {selectedConv.status === 'ARCHIVED' ? (t('whatsapp.statusArchived')) : (t('whatsapp.statusClosed'))}
                                </span>
                              )}
                            </div>
                            {headerCleanPhone && formatPhoneNumber(headerCleanPhone) !== headerDisplayName && (
                              <p className="text-[11px] font-mono text-slate-400 font-medium truncate">
                                {formatPhoneNumber(headerCleanPhone)}
                              </p>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>

                  <div className="flex items-center space-x-1 sm:space-x-2 shrink-0">
                    {/* Lifecycle Status Action */}
                    {selectedConv.status === 'ACTIVE' ? (
                      <div className="flex items-center space-x-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleStatusChange(selectedConv.id, 'ARCHIVED')}
                          title={t('whatsapp.archive')}
                          className="space-x-1 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer px-2 sm:px-3"
                        >
                          <Archive className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">{t('whatsapp.archive')}</span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleStatusChange(selectedConv.id, 'CLOSED')}
                          title={t('whatsapp.close')}
                          className="space-x-1 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer px-2 sm:px-3"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 text-slate-400" />
                          <span className="hidden sm:inline">{t('whatsapp.close')}</span>
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStatusChange(selectedConv.id, 'ACTIVE')}
                        className="space-x-1 text-xs font-bold text-[#7367F0] border-[#7367F0]/30 hover:bg-[#7367F0]/10 cursor-pointer px-2 sm:px-3"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">{t('whatsapp.reopen')}</span>
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenLead(selectedConv.lead_id)}
                      disabled={leadLoading}
                      title={t('leads.openLeadDetail')}
                      className="space-x-1.5 text-xs font-bold border-slate-200 dark:border-white/[0.1] hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer px-2 sm:px-3"
                    >
                      <Building2 className="w-3.5 h-3.5 text-[#7367F0]" />
                      <span className="hidden md:inline">{t('leads.openLeadDetail')}</span>
                    </Button>

                    <span className="inline-flex items-center space-x-1 px-2 sm:px-2.5 py-1 rounded-full bg-[#25D366]/15 text-[#25D366] font-bold text-xs">
                      <WhatsAppIcon className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">{t('leads.whatsappActive')}</span>
                    </span>
                  </div>
                </div>

                {/* Chat Thread with Pagination
                    P6-4 (revised): a conversation switch must NOT remount the
                    thread. Remounting is a deletion, and a deletion that does
                    not complete leaves the old root behind in the pane — one
                    extra chat per clicked person. Instead the pane keeps a
                    single thread instance and `conversationKey` makes that
                    instance reset its own viewport/pagination state for the new
                    chat, so the previous chat's `isNearBottom` and scroll position
                    can never carry over. Reordering keeps the same id, so an
                    inbound in the active chat still does not disturb the view.
                    Sorun 11/12: pane'de TEK thread kökü vardır; secim onun
                    icerigini degistirir, yeni pane EKLEMEZ. */}
                <ChatThread
                  conversationKey={selectedConv.id}
                  messages={activeMessages}
                  loading={activeChatLoading}
                  error={activeMessagesError}
                  onRetryLoad={retrySelectedConversationMessages}
                  hasMore={activeHasMore}
                  loadingOlder={activeLoadingOlder}
                  pagingError={activePagingError}
                  onLoadOlder={activeLoadOlder}
                  leadName={selectedConv.lead_name}
                  leadPhone={selectedConv.lead_phone}
                  isGroup={Boolean(selectedConv.is_group)}
                  peerTyping={!!peerTypingMap[selectedConv.id]}
                  onRetry={handleRetryMessage}
                  onReact={handleReactMessage}
                />

                {/* Active Chat Composer */}
                {/* P6-5: keyed by conversation id. The composer owns the draft
                    (`text`, `pendingFile`, captions) in internal state and
                    receives no conversation identifier, so an unkeyed instance
                    carries the draft into the next chat — and `onSend`
                    delivers to the SELECTED conversation, so it would send to
                    the wrong person. Keying clears it on switch. */}
                <ChatComposer
                  key={selectedConv.id}
                  onSend={async (text) => {
                    try {
                      await activeSendMessage(text);
                      toast.success(t('whatsapp.messageSent'), t('common.success'));
                    } catch (err: any) {
                      const msg = (err?.message || '').toLowerCase();
                      if (msg.includes('24 saat') || msg.includes('window')) {
                        toast.error(t('whatsapp.windowExpiredNotice'), t('common.error'));
                      } else {
                        toast.error(translateApiError(err, t) || t('whatsapp.msgFailed'), t('common.error'));
                      }
                      throw err;
                    }
                  }}
                  onSendTemplate={() => setIsTemplateModalOpen(true)}
                  onSendMediaFile={async (file, caption) => {
                    try {
                      await activeSendMediaFile(file, caption);
                      toast.success(t('whatsapp.mediaSent'), t('common.success'));
                    } catch (err: any) {
                      toast.error(translateApiError(err, t) || t('whatsapp.mediaFailed'), t('common.error'));
                      throw err;
                    }
                  }}
                  onTyping={(typing) => {
                    if (selectedConv) {
                      void WhatsAppRepository.sendTyping(selectedConv.id, typing).catch((err) => {
                        // Typing is background traffic; keep the composer quiet,
                        // but retain a correlation-rich diagnostic instead of
                        // dropping the failure.
                        console.warn('[WhatsAppHubPage] Typing signal failed', {
                          conversation_id: selectedConv.id,
                          typing,
                          error: err instanceof Error ? err.message : String(err),
                        });
                        toastRef.current.error(tRef.current('whatsapp.typingFailed') || tRef.current('common.error'), tRef.current('common.error'));
                      });
                    }
                  }}
                  onSendMedia={async (type, url, caption, filename) => {
                    try {
                      await activeSendMedia(type, url, caption, filename);
                      toast.success(t('whatsapp.mediaSent'), t('common.success'));
                    } catch (err: any) {
                      toast.error(t('whatsapp.mediaFailed'), t('common.error'));
                      throw err;
                    }
                  }}
                  onReopenConversation={() => handleStatusChange(selectedConv.id, 'ACTIVE')}
                  isClosed={selectedConv.status === 'CLOSED'}
                  isWindowOpen={activeConv?.is_window_open ?? selectedConv.is_window_open ?? true}
                />

                {/* Template Select Modal */}
                <TemplateSelectModal
                  isOpen={isTemplateModalOpen}
                  onClose={() => setIsTemplateModalOpen(false)}
                  leadName={selectedConv.lead_name}
                  onSendTemplate={async (templateKey, variables) => {
                    try {
                      await activeSendTemplate(templateKey, variables);
                      toast.success(t('whatsapp.templateSent'), t('common.success'));
                    } catch (err: any) {
                      toast.error(translateApiError(err, t) || t('whatsapp.templateFailed'), t('common.error'));
                      throw err;
                    }
                  }}
                />
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center p-8">
                {/* Sorun 1/17: ilk yukleme surerken "sohbet yok" DENMEZ —
                    loading ile empty karismaz. */}
                {convLoadState === 'loading' ? (
                  <div className="flex flex-col items-center gap-3 text-slate-400 dark:text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin text-[#7367F0]" />
                    <p className="text-xs font-bold">{t('whatsapp.loadingChats')}</p>
                  </div>
                ) : convLoadState === 'error' ? (
                  <EmptyState
                    icon={AlertTriangle}
                    title={t('whatsapp.loadFailedChats')}
                    description={convLoadError || t('whatsapp.conversationsLoadFailed')}
                    action={{
                      label: t('whatsapp.retryBtn'),
                      onClick: () => {
                        void loadConversations();
                      },
                      icon: RotateCcw,
                    }}
                  />
                ) : (
                  <EmptyState
                    icon={MessageSquare}
                    title={
                      conversations.length > 0
                        ? (t('whatsapp.selectConversationTitle'))
                        : (t('whatsapp.noConversations'))
                    }
                    description={
                      conversations.length > 0
                        ? (t('whatsapp.selectConversation'))
                        : (t('whatsapp.noConversationsDesc'))
                    }
                    action={
                      conversations.length === 0
                        ? {
                            label: t('whatsapp.newChat'),
                            onClick: () => setIsNewChatModalOpen(true),
                            icon: MessageSquarePlus,
                          }
                        : undefined
                    }
                  />
                )}
              </div>
            )}
          </div>
          </>
          )}
        </Card>
      )}

      {/* ========================================================================= */}
      {/* 2. BAILEYS QR OTURUM YÖNETİMİ */}
      {/* ========================================================================= */}
      {hubTab === 'sessions' && (
        <div className="space-y-6">
          <div className="flex items-center gap-3 justify-end flex-wrap">
            <Button
              onClick={handleOpenQrConnect}
              size="sm"
              className="space-x-2 font-bold shadow-md shadow-[#28C76F]/20 cursor-pointer bg-[#28C76F] hover:bg-[#24B263] text-white"
            >
              <QrCode className="w-4 h-4" />
              <span>{t('whatsapp.connectWithQr')}</span>
            </Button>

          </div>

          {sessions.length === 0 ? (
            <Card className="p-8">
              <EmptyState
                icon={Smartphone}
                title={t('whatsapp.noSessions')}
                description={t('whatsapp.noSessionsDesc')}
                action={{
                  label: t('whatsapp.connectWithQr'),
                  onClick: handleOpenQrConnect,
                  icon: QrCode,
                }}
              />
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {sessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onDisconnect={handleDisconnectSession}
                  onDelete={handleDeleteSession}
                  onScanQR={(sessionId) => {
                    setReconnectSessionId(sessionId);
                    setIsQrConnectModalOpen(true);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3. WHATSAPP ANTI-BAN YAPILANDIRMASI SUITE */}
      {/* ========================================================================= */}
      {hubTab === 'antiban' && <AntiBanPanel />}

      {/* Lead Detail Drawer for Conversation -> Lead Navigation */}
      <LeadDetailDrawer
        lead={drawerLead}
        isOpen={isLeadDrawerOpen}
        onClose={() => {
          setIsLeadDrawerOpen(false);
          setDrawerLead(null);
        }}
        initialTab="overview"
      />

      {/* New WhatsApp Conversation Modal */}
      <NewChatModal
        isOpen={isNewChatModalOpen}
        onClose={() => setIsNewChatModalOpen(false)}
        onSuccess={(newConv) => {
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === newConv.id);
            if (exists) {
              return prev.map((c) => (c.id === newConv.id ? newConv : c));
            }
            return [newConv, ...prev];
          });
          setSelectedConv(newConv);
        }}
      />

      {/* WhatsApp QR Connect & Pairing Modal */}
      <WhatsAppQrConnectModal
        isOpen={isQrConnectModalOpen}
        onClose={() => {
          setIsQrConnectModalOpen(false);
          setReconnectSessionId(undefined);
          void fetchSessions(true);
        }}
        existingSessionId={reconnectSessionId}
        onSuccess={handleQrSuccess}
      />
    </div>
  );
};
