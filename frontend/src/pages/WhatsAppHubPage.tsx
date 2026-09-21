import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { 
  Smartphone, 
  QrCode, 
  ShieldCheck, 
  Flame, 
  CheckCircle2, 
  Loader2, 
  Zap,
  Clock,
  Sliders,
  Check,
  RotateCcw,
  AlertTriangle,
  Shield,
  Building2,
  Save,
  Undo2,
  MessageSquare,
  Archive,
  ExternalLink,
  Copy,
  MessageSquarePlus,
  Users,
  ArrowLeft
} from 'lucide-react';
import { ApiClient } from '../api/client';
import { startWaLatency } from '../features/whatsapp/lib/whatsappLatency';
import { translateApiError } from '../features/whatsapp/lib/translateError';
import { mergeDeliveryStatus, mergeWhatsAppMessages } from '../features/whatsapp/lib/whatsappMessageMerge';
import { WhatsAppRepository } from '../features/whatsapp/data/whatsappRepository';
import { compareConversationsByActivityDesc, getConversationActivityTimestamp, restoreConversationActivity } from '../features/whatsapp/lib/whatsappOrdering';
import { isRawWhatsAppJid as isRawWhatsAppIdentity } from '../features/whatsapp/lib/whatsappIdentity';
import { PEER_TYPING_TTL_MS, pruneExpiredTyping, resolveSyncDisplayCounts } from '../features/whatsapp/lib/whatsappSync';
import { applyConversationEvent } from '../features/whatsapp/lib/whatsappConversationPatch';
import { WhatsAppSession, Conversation, ConversationStatus, ConversationMessageStatus, Lead, Message, LiveModeStatus, SessionSyncState } from '../types';
import { WhatsAppApi, useLiveMode, probeLive, invalidateLiveProbe, isLiveCached, mapConversationItem, mapMessageItem, buildConversationUpdatedPayload } from '../features/whatsapp/api/whatsappApi';
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
  NewChatModal 
} from '../features/whatsapp/components';
import { LeadDetailDrawer } from '../features/leads/components';
import { FilterTab } from '../features/whatsapp/components/ConversationList';
import { Slider, Switch } from '../components/forms';
import { 
  AntiBanConfig, 
  DEFAULT_ANTI_BAN_CONFIG, 
  ANTI_BAN_PRESETS, 
  getStoredAntiBanConfig, 
  saveAntiBanConfig, 
  calculateRiskLevel,
  isConfigEqual,
  resolvePresetFromConfig
} from '../utils/antiBanSettings';
import { useToast } from '../context/ToastContext';
import { useI18n } from '../context/I18nContext';
import { buildChatPreview, normalizePreviewText, shouldApplyPreview } from '../features/whatsapp/lib/whatsappPreview';
import { parseServerTime } from '../lib/utils';


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

  // Live Conversations State (connected directly to WhatsApp session)
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const conversationsRef = useRef<Conversation[]>(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [messagesMap, setMessagesMap] = useState<Record<number, Message[]>>({});
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
  const [messageLoadState, setMessageLoadState] = useState<Record<number, 'loading' | 'ready' | 'error'>>({});
  const [messageLoadError, setMessageLoadError] = useState<Record<number, string>>({});
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
  const [leadLoading, setLeadLoading] = useState<boolean>(false);
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
  const { status: liveStatus, probe: probeLiveMode } = useLiveMode();
  const isLive = liveStatus === LiveModeStatus.LIVE_CONNECTED;

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
    startWaLatency('chat_request_to_commit_ms', convId);
    setMessagePaging((prev) => ({ ...prev, [convId]: { ...(prev[convId] || activePaging), loading: true } }));
    try {
      const res = await WhatsAppRepository.getConversationMessages(convId, {
        limit: 50,
        before: activePaging.oldest,
      });
      setMessagesMap((prev) => {
        const existing = prev[convId] || [];
        const seen = new Set(existing.map((m) => `${m.wa_message_id || ''}:${m.id}`));
        const older = res.messages.filter((m) => !seen.has(`${m.wa_message_id || ''}:${m.id}`));
        const merged = [...older, ...existing].sort((a, b) => {
          const ta = new Date(a.created_at || a.external_timestamp || 0).getTime() || 0;
          const tb = new Date(b.created_at || b.external_timestamp || 0).getTime() || 0;
          return ta !== tb ? ta - tb : Number(a.id) - Number(b.id);
        });
        return { ...prev, [convId]: merged };
      });
      setMessagePaging((prev) => ({
        ...prev,
        [convId]: {
          hasMore: Boolean(res.has_more),
          oldest: res.oldest_message_id ?? prev[convId]?.oldest,
          loading: false,
        },
      }));
    } catch (err) {
      // Sorun 2: history sayfasi basarisiz → mevcut mesajlar SILINMEZ,
      // yalnizca retry edilebilir bir hata isareti konur. Global hata toast'i
      // yok: tek sayfa hatasi tum sohbet ekranini hata gibi gostermez.
      setMessagePaging((prev) => ({
        ...prev,
        [convId]: { ...(prev[convId] || activePaging), loading: false, error: true },
      }));
      console.warn('[WhatsAppHubPage] Older messages fetch failed:', err);
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
        const pageIds = new Set(page.items.map((c) => c.id));
        if (!page.has_more) return page.items;
        const retained = prev.filter((c) => !pageIds.has(c.id));
        if (!retained.length) return page.items;
        return [...page.items, ...retained].sort(compareByLastMessageDesc);
      });
      setHasMoreConvs(page.has_more);
      nextConvOffsetRef.current = page.next_offset ?? page.items.length;
      totalConvsRef.current = page.total;

      setSelectedConv((prev) => {
        if (!prev && page.items.length > 0) return page.items[0];
        if (prev) {
          const updated = page.items.find((c) => c.id === prev.id);
          if (updated) return updated;
          if (conversationsRef.current.some((c) => c.id === prev.id)) return prev;
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
    const timer = setTimeout(() => {
      setSessionSync((prev) => (prev && prev.phase === 'ready' ? null : prev));
    }, 4000);
    return () => clearTimeout(timer);
  }, [sessionSync?.phase]);

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
  const hydrateConversationMessages = useCallback(async (convId: number) => {
    setMessageLoadState((prev) => (prev[convId] === 'loading' ? prev : { ...prev, [convId]: 'loading' }));
    try {
      const res = await WhatsAppRepository.getConversationMessages(convId, { limit: 50 });
      if (!res?.messages) return;
      setMessagePaging((prev) => ({
        ...prev,
        [convId]: {
          hasMore: Boolean(res.has_more),
          oldest: res.oldest_message_id,
          loading: false,
          error: false,
        },
      }));
      setMessagesMap((prev) => {
        const existing = prev[convId] || [];
        // Merge strategy: prevent wiping messages received via realtime while GET was in flight
        const fetchedIds = new Set(res.messages.map((m) => m.id));
        const fetchedWaIds = new Set(res.messages.map((m) => m.wa_message_id).filter(Boolean));
        const fetchedClientIds = new Set(res.messages.map((m) => m.client_message_id).filter(Boolean));

        const inFlightOrRealtime = existing.filter((m) => {
          if (m.id && fetchedIds.has(m.id)) return false;
          if (m.wa_message_id && fetchedWaIds.has(m.wa_message_id)) return false;
          if (m.client_message_id && fetchedClientIds.has(m.client_message_id)) return false;
          return true;
        });

        const merged = [...res.messages, ...inFlightOrRealtime].sort((a, b) => {
          const tA = new Date(a.created_at || a.external_timestamp || 0).getTime();
          const tB = new Date(b.created_at || b.external_timestamp || 0).getTime();
          if (tA !== tB) return tA - tB;
          const nA = typeof a.id === 'number' ? a.id : 0;
          const nB = typeof b.id === 'number' ? b.id : 0;
          return nA - nB;
        });

        return {
          ...prev,
          [convId]: merged,
        };
      });
      setMessageLoadState((prev) => ({ ...prev, [convId]: 'ready' }));
      setMessageLoadError((prev) => {
        if (!(convId in prev)) return prev;
        const next = { ...prev };
        delete next[convId];
        return next;
      });
    } catch (err) {
      // Tek sohbetin hidrasyon hatasi tum chat UI'ini error'a dusurmez:
      // mesajlar korunur, yalnizca bu sohbet icin retry edilebilir state olur.
      console.warn('[WhatsAppHubPage] Conversation messages load failed', {
        conversation_id: convId,
        error: err instanceof Error ? err.message : String(err),
      });
      setMessageLoadState((prev) => ({ ...prev, [convId]: 'error' }));
      setMessageLoadError((prev) => ({
        ...prev,
        [convId]: (err as any)?.message || tRef.current('whatsapp.messagesLoadFailed') || tRef.current('common.error'),
      }));
    }
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
    if ((selectedConv.unread_count ?? 0) > 0) {
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
  }, [selectedConv?.id, reportReadSync, hydrateConversationMessages]);

  // Faz 11: Manuel "Eşitle" artık ağır sync'i HTTP'de BEKLEMİYOR — POST /sync
  // kısa ömürlü job'ı tetikler (202); tüm ilerleme ve tamamlama mevcut WS
  // üzerinden whatsapp_sync_* olaylarıyla akar. 502/polling storm sona erdi.
  // Banner'ın kapanması job'ın GERÇEK tamamlanmasina bağlıdır (§20).
  const handleSyncChats = async () => {
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
      toast.error(err.message || t('whatsapp.syncFailed'), t('common.error'));
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

  const activeRetryMessage = async (msgId: number | string) => {
    if (!selectedConv) return;
    // Optimistic rows (client-only string ids) must never hit /retry. Re-POST
    // with the existing client_message_id so idempotency holds and the row is
    // reconciled with the real numeric DB id.
    const convId = selectedConv.id;
    const target = (messagesMap[convId] || []).find((m) => m.id === msgId);
    const isRealDbId = typeof msgId === 'number' && Number.isInteger(msgId) && msgId > 0;
    try {
      if (!isRealDbId) {
        const clientMid = target?.client_message_id;
        if (!target || !clientMid || !target.body) {
          throw new Error(
            t('whatsapp.msgNotPersisted')
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
    } catch (err: any) {
      // F-7: no toast here — the UI caller owns the single user-facing toast.
      throw err;
    }
  };

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
            ? { ...m, id: res.id, client_message_id: res.client_message_id || tempClientMid, status: res.status }
            : m
        ),
      }));
      const previewText = caption || filename || (type.toUpperCase() === 'IMAGE' ? '📷 Fotoğraf' : '📄 Dosya');
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

    const newMsg: Message = {
      id: tempId,
      conversation_id: selectedConv.id,
      direction: 'OUTBOUND',
      message_type: msgType,
      status: 'PENDING',
      body: caption || file.name,
      client_message_id: tempClientMid,
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
              }
            : m
        ),
      }));
      const previewText = caption || file.name || (msgType === 'IMAGE' ? '📷 Fotoğraf' : '📄 Dosya');
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

  const fetchConversations = () => {
    loadConversations(true);
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
        const convIdRaw = eventData.conversation_id;
        const convIdNumber = typeof convIdRaw === 'number'
          ? convIdRaw
          : typeof convIdRaw === 'string' && convIdRaw.trim() !== ''
            ? Number(convIdRaw)
            : NaN;
        const convId = Number.isInteger(convIdNumber) && convIdNumber > 0 ? convIdNumber : null;
        const rawPhone = eventData.lead_phone || eventData.phone || eventData.recipient_phone || eventData.sender_phone || '';
        // I-7 (single authority): resolve the event's phone to its CANONICAL form
        // and match on that. Matching on the last 10 digits is wrong — two
        // different people can share their last 10 digits (+905321234567 and
        // +1555551234567), so a message could be attributed to the wrong chat.
        const eventPhone = extractCleanPhone(rawPhone);

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
        const isReplayedEvent = Boolean(waIdForDedup) && !rememberWaMessageId(String(waIdForDedup), convId);

        // Update Conversation in list
        if (convId !== null && !knownConvIdsRef.current.has(convId)) hydrateConversation(convId);
        setConversations((prev) => {
          const exactIdx = convId == null ? -1 : prev.findIndex((c) => c.id === convId);
          const phoneMatches = eventPhone
            ? prev.reduce<number[]>((matches, c, index) => {
                const cPhone = c.lead_phone || (c as any).phone || '';
                if (cPhone && extractCleanPhone(cPhone) === eventPhone) matches.push(index);
                return matches;
              }, [])
            : [];
          // A phone-only fallback is safe only when exactly one line matches.
          // With multiple lines, guessing would update the wrong tenant/line.
          const idx = exactIdx !== -1 ? exactIdx : phoneMatches.length === 1 ? phoneMatches[0] : -1;

          if (idx !== -1) {
            const existing = prev[idx];
            const isCurrentSelected = selectedConv && (selectedConv.id === existing.id || selectedConv.id === convId);
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

        // If active conversation matches, append message to thread with deduplication
        const selectedPhoneIsUnambiguous = Boolean(
          eventPhone &&
          conversationsRef.current.filter((c) => c.lead_phone && extractCleanPhone(c.lead_phone) === eventPhone).length === 1,
        );
        if (convId != null && selectedConv && (selectedConv.id === convId || (selectedPhoneIsUnambiguous && selectedConv.lead_phone && extractCleanPhone(selectedConv.lead_phone) === eventPhone))) {
          const msgObj = eventData.message && typeof eventData.message === 'object' ? eventData.message : null;
          const waId = msgObj?.wa_message_id || eventData.wa_message_id || eventData.message_id;
          const clientMid = msgObj?.client_message_id || eventData.client_message_id;
          const msgId = msgObj?.id || eventData.id;

          const newMsg: Message = {
            id: msgId || Date.now(),
            conversation_id: convId,
            direction: isOutbound ? 'OUTBOUND' : 'INBOUND',
            message_type: (msgObj?.message_type || eventData.message_type || 'TEXT').toUpperCase() as any,
            status: msgObj?.status || (isOutbound ? 'PENDING' : 'RECEIVED'),
            body: typeof msgText === 'string' ? msgText : '',
            wa_message_id: waId,
            client_message_id: clientMid,
            sender_name: senderLabel || (isOutbound ? t('whatsapp.youLabel') : undefined),
            sender_phone: msgObj?.sender_phone || eventData.phone || '',
            media_id: msgObj?.media_id || eventData.media_id,
            media_mime_type: msgObj?.media_mime_type || eventData.media_mime_type,
            media_filename: msgObj?.media_filename || eventData.media_filename,
            media_caption: msgObj?.media_caption || eventData.media_caption,
            created_at: msgTime,
          };

          setMessagesMap((prev) => {
            // P6-6: ONE canonical merge for every path. The previous inline
            // `findIndex` could not collapse two slots when a later event linked
            // both identities (optimistic row + provider echo), so the sent
            // message stayed rendered twice — once DELIVERED, once stuck SENT.
            // `mergeWhatsAppMessages` is what refresh, reconnect, sync-chunk
            // and pagination already use; using it here makes live WS agree.
            return { ...prev, [convId]: mergeWhatsAppMessages(prev[convId] || [], [newMsg]) };
          });

          // Auto-mark conversation as read if user is actively viewing it
          if (!isOutbound) {
            // Otomatik okundu: kullanici sohbeti acik tutuyor — basarisizlikta
            // toast GOSTERILMEZ (her gelen mesajda spam olur) ama konsola yazilir.
            WhatsAppRepository.markConversationAsRead(convId)
              .then((res) => reportReadSync(res, { label: `auto#${convId}` }))
              .catch((err) => console.warn('[WhatsAppHubPage] Otomatik okundu istegi basarisiz:', err));
          }
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
        if (selectedConv && selectedConv.id === convId) {
          setSelectedConv((prev) => (prev ? { ...prev, status: newStatus } : prev));
        }
      }

      if (eventData.event === 'conversation_read') {
        const convId = eventData.conversation_id;
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, unread_count: 0 } : c))
        );
        if (selectedConv && selectedConv.id === convId) {
          setSelectedConv((prev) => (prev ? { ...prev, unread_count: 0 } : prev));
        }
      }

      // Faz 5: gateway'den canlı sohbet metadata'sı (isim/avatar/preview/unread)
      // — backend jid'yi sayısal conversation_id'ye çevirerek ileri iletir.
      if (eventData.event === 'conversation_updated') {
        const rawConvId = eventData.conversation_id;
        const convId = typeof rawConvId === 'number' ? rawConvId : Number(rawConvId);
        const payload = eventData.conversation || {};
        if (Number.isInteger(convId) && convId > 0) {
          // I-4 / Faz 5 / Faz 6: the merge lives in ONE pure helper so the list
          // row, the selected conversation and the DOM tests all run the same
          // code. See `applyConversationEvent` for the invariants.
          const patch = (c: Conversation): Conversation => applyConversationEvent(c, payload, t);
          if (!knownConvIdsRef.current.has(convId)) {
            // Sorun 4/5 (grup dahil her sohbet first-class): gateway'den gelen
            // YENI sohbet, hedefli GET yanitini BEKLEMEDEN listeye eklenir.
            // Eskiden yalnizca `hydrateConversation` calisiyordu; o istek
            // yavasladiginda/basarisiz oldugunda satir listede HIC olusmuyordu
            // (ornegin yeni bir grup "3Hacker" sohbet listesinde kayboluyordu).
            // Burada WS payload'i kanonik alan adlariyla gelir; gecici olarak
            // gosterilir, hedefli GET satiri DB gercegiyle mutabik kilar.
            const seeded = mapConversationItem({ ...payload, id: convId });
            setConversations((prev) => {
              if (prev.some((c) => c.id === convId)) return prev;
              const fresh: Conversation = { status: 'ACTIVE' as ConversationStatus, unread_count: 0, ...seeded };
              return [fresh, ...prev].sort(compareByLastMessageDesc);
            });
            hydrateConversation(convId);
          }
          setConversations((prev) => {
            const next = prev.map((c) => (c.id === convId ? patch(c) : c));
            // Sorun 2: patch son mesaji/siralamayi degistirdiyse liste zaman
            // damgasina gore yeniden siralanir (API sirasiyla ayni kural).
            const patched = next.find((c) => c.id === convId);
            const before = prev.find((c) => c.id === convId);
            if (patched && before && patched.last_message_at !== before.last_message_at) {
              return [...next].sort(compareByLastMessageDesc);
            }
            return next;
          });
          setSelectedConv((prev) => {
            if (!prev) {
              // Sorun 3 (WhatsApp Web akisi): ilk secilebilir sohbet, liste
              // dolarken hazirlanir — kullanici bos ekranla kalmaz.
              const seeded = mapConversationItem({ ...payload, id: convId });
              return { status: 'ACTIVE' as ConversationStatus, unread_count: 0, ...seeded };
            }
            return prev.id === convId ? patch(prev) : prev;
          });
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
            const openId = selectedConv?.id;
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
        } else if (eventData.event === 'whatsapp_sync_failed') {
          // Sorun 8: basarisizlik kullaniciya BIR KEZ gosterilir ve
          // acknowledged olarak isaretlenir — backend'de tutulan ayni job
          // sonraki sayfa acilisinda banner'i yeniden acmaz.
          acknowledgeFailedSync(syncId);
          failedSyncKeyRef.current = syncId;
          setSessionSync({ phase: 'error', stage: eventData.stage || 'failed', error: eventData.error || null, progress: 0 });
          setIsSyncingChats(false);
          activeSyncIdRef.current = null;
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
        if (sync && !activeSyncIdRef.current) setSessionSync({ ...sync, phase: 'ready', progress: 100 });
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
      if (selectedConv?.id) {
        WhatsAppRepository.getConversationMessages(selectedConv.id, { limit: 50 })
          .then((res) => {
            if (res?.messages) {
              setMessagesMap((prev) => {
                const buf = syncMsgBufferRef.current[selectedConv.id] || [];
                return { ...prev, [selectedConv.id]: mergeWhatsAppMessages(
                  prev[selectedConv.id] || [], [...res.messages, ...buf]) };
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
  }, [selectedConv, loadConversations, refreshSyncStatus, reportReadSync, logBackgroundFetchFailure, hydrateConversation, clearPeerTyping, acknowledgeFailedSync, scheduleBootstrapFetch]);

  // Anti-Ban Timing & Change-Tracking State
  const [savedConfig, setSavedConfig] = useState<AntiBanConfig>(getStoredAntiBanConfig());
  const [config, setConfig] = useState<AntiBanConfig>(getStoredAntiBanConfig());
  const [isSavingAntiBan, setIsSavingAntiBan] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchSessions = useCallback(async (silent = false) => {
    try {
      setSessions(await WhatsAppRepository.getWhatsAppSessions());
    } catch (err: any) {
      if (!silent) toast.error(err?.message || t('common.error'), t('common.error'));
    }
  }, [t, toast]);

  const handleQrSuccess = useCallback(() => {
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
    // Sıfır tıklama eşitleme: QR eşleşmesi tamamlanır tamamlanmaz canlı veri çekimini başlat
    void handleSyncChats();
  }, [fetchSessions, onRefreshStats, refreshSyncStatus, loadConversations, handleSyncChats]);

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

    // Load persisted Anti-Ban configuration from backend database
    ApiClient.getAntiBanSettings()
      .then((remote) => {
        if (remote) {
          const resolvedPreset = resolvePresetFromConfig(remote);
          const normalized = { ...remote, preset: remote.preset || resolvedPreset };
          setConfig(normalized);
          setSavedConfig(normalized);
          saveAntiBanConfig(normalized);
        }
      })
      .catch((e) => {
        console.warn('Anti-ban config failed to load from backend, using local storage:', e);
      });

    return () => {
      window.removeEventListener('tezlify:ws_event', handleWs);
    };
    // Faz 12: `onRefreshStats` BİLEREK bağımlılıkta DEĞİL — ref üzerinden
    // okunur, böylece üst bileşen yeniden render olduğunda bu kurulum effect'i
    // (ve içindeki 3 HTTP isteği) tekrar tetiklenmez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchSessions, refreshSyncStatus]);

  const handlePresetSelect = (presetKey: 'ultra_safe' | 'standard_balanced' | 'fast_warmed') => {
    const presetData = ANTI_BAN_PRESETS[presetKey];
    setConfig((prev) => ({
      ...prev,
      preset: presetKey,
      ...presetData
    }));
  };

  const handleCustomChange = (field: keyof AntiBanConfig, value: any) => {
    setConfig((prev) => {
      const updated = {
        ...prev,
        [field]: value
      };
      updated.preset = resolvePresetFromConfig(updated);
      return updated;
    });
  };

  const handleSaveAntiBan = async () => {
    setIsSavingAntiBan(true);
    try {
      const updated = await ApiClient.updateAntiBanSettings(config);
      setSavedConfig(updated);
      setConfig(updated);
      saveAntiBanConfig(updated);
      setSaveSuccess(true);
      toast.success(t('whatsapp.policySavedSuccess'), t('toast.policySavedTitle'));
      setTimeout(() => setSaveSuccess(false), 3500);
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    } finally {
      setIsSavingAntiBan(false);
    }
  };

  const handleRevertChanges = () => {
    setConfig(savedConfig);
    toast.info(t('whatsapp.discardChanges'), t('common.info'));
  };

  const handleResetDefaults = async () => {
    const confirmed = await toast.confirm({
      title: t('whatsapp.resetDefaults') + '?',
      message: t('whatsapp.presetBalancedDesc'),
      confirmText: t('common.save'),
      cancelText: t('common.cancel'),
      variant: 'warning'
    });
    if (!confirmed) return;

    setIsSavingAntiBan(true);
    try {
      const updated = await ApiClient.updateAntiBanSettings(DEFAULT_ANTI_BAN_CONFIG);
      setSavedConfig(updated);
      setConfig(updated);
      saveAntiBanConfig(updated);
      setSaveSuccess(true);
      toast.success(t('whatsapp.policySavedSuccess'), t('toast.policySavedTitle'));
      setTimeout(() => setSaveSuccess(false), 3500);
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('common.error'));
    } finally {
      setIsSavingAntiBan(false);
    }
  };

  const hasUnsavedChanges = !isConfigEqual(config, savedConfig);
  const riskInfo = calculateRiskLevel(config.min_delay_seconds, config.daily_message_limit);

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
        <Card className="w-full max-w-full h-[520px] sm:h-[600px] md:h-[calc(100dvh-16.5rem)] md:min-h-[480px] md:max-h-[calc(100dvh-15.5rem)] p-0 flex flex-col md:flex-row overflow-hidden border border-slate-200/80 dark:border-white/[0.08] shadow-sm">
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
            <ConversationList
              conversations={conversations}
              selectedId={selectedConv?.id}
              loading={convsLoading}
              // Sorun 1/16/17: LOADING ≠ EMPTY ≠ ERROR — liste bilesenine
              // acik yukleme durumu verilir; ilk yukleme bitmeden "sohbet yok"
              // gosterilmez, gercek hata ayri error ekranidir.
              loadState={convLoadState}
              loadError={convLoadError}
              onRetryLoad={() => {
                void loadConversations();
              }}
              searchQuery={convSearch}
              onSearchChange={setConvSearch}
              activeFilter={convFilter}
              onFilterChange={setConvFilter}
              onNewChat={() => setIsNewChatModalOpen(true)}
              onSync={handleSyncChats}
              isSyncing={isSyncingChats}
              typingMap={peerTypingMap}
              onLoadMore={loadMoreConversations}
              hasMore={hasMoreConvs}
              loadingMore={loadingMoreConvs}
              onSelect={(c) => {

                setSelectedConv(c);
                if (c.unread_count > 0) {
                  // Kullanici eylemi → gateway'e iletilemezse GORUNUR bildirim.
                  WhatsAppRepository.markConversationAsRead(c.id, c)
                    .then((res) => reportReadSync(res, { notify: true, label: `click#${c.id}` }))
                    .catch((err) => {
                      console.warn('[WhatsAppHubPage] Okundu istegi basarisiz:', err);
                      toast.error(t('whatsapp.readSyncFailed'), t('common.error'));
                    });
                  setConversations((prev) =>
                    prev.map((item) => (item.id === c.id ? { ...item, unread_count: 0 } : item))
                  );
                }
              }}
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
                    P6-4: keyed by conversation id. Without it, switching
                    conversations reuses the same instance, so the viewport and
                    `isNearBottom` of the previous thread carry over and the new
                    chat opens mid-history (or with a spurious new-message
                    pill). Reordering keeps the same id, so it does NOT
                    remount — the active chat survives a new inbound. */}
                {/* Chat Thread with Pagination
                    P6-4: keyed by conversation id. Without it, switching
                    conversations reuses the same instance, so the viewport and
                    `isNearBottom` of the previous thread carry over and the new
                    chat opens mid-history (or with a spurious new-message
                    pill). Reordering keeps the same id, so it does NOT
                    remount — the active chat survives a new inbound.
                    Sorun 11/12: TEK bir thread instance vardir; secim yalnizca
                    bu instance'in icerigini degistirir, yeni pane EKLEMEZ. */}
                <ChatThread
                  key={selectedConv.id}
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
                  onRetry={async (msgId) => {
                    try {
                      await activeRetryMessage(msgId);
                      toast.success(t('whatsapp.messageSent'), t('common.success'));
                    } catch (err: any) {
                      toast.error(translateApiError(err, t) || t('whatsapp.msgFailed'), t('common.error'));
                      throw err;
                    }
                  }}
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
      {hubTab === 'antiban' && (
        <div className="space-y-6">
          <Card className="p-4 sm:p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-white/[0.08] pb-4">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#28C76F]/15 text-[#28C76F] flex items-center justify-center font-bold">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-extrabold text-slate-800 dark:text-white">
                  {t('whatsapp.antiBanTitle')}
                </h3>
                {hasUnsavedChanges ? (
                  <Badge variant="warning" className="text-[10px] animate-pulse">
                    ⚠️ {t('whatsapp.unsavedChanges')}
                  </Badge>
                ) : (
                  <Badge variant="success" className="text-[10px]">
                    ✅ {t('whatsapp.synchronized')}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium">
                {t('whatsapp.antiBanSubtitle')}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {hasUnsavedChanges && (
              <button
                type="button"
                onClick={handleRevertChanges}
                className="text-xs font-bold text-slate-500 hover:text-[#7367F0] dark:text-[#7E7F96] dark:hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer"
                title={t('whatsapp.discardChanges')}
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>{t('whatsapp.revertChanges')}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleResetDefaults}
              className="text-xs font-bold text-slate-500 hover:text-[#7367F0] dark:text-[#7E7F96] dark:hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer"
              title={t('whatsapp.resetDefaults')}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('whatsapp.resetDefaults')}</span>
            </button>
          </div>
        </div>

        {/* Preset Selector Tabs */}
        <div>
          <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block mb-2">
            {t('whatsapp.antiBanPresetLabel')}
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {/* Preset 1: Ultra Safe */}
            <button
              type="button"
              onClick={() => handlePresetSelect('ultra_safe')}
              className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                config.preset === 'ultra_safe'
                  ? 'border-[#28C76F] bg-[#28C76F]/10 ring-1 ring-[#28C76F]/50 shadow-sm'
                  : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100 dark:hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-[#28C76F]" />
                  {t('whatsapp.presetUltraSafe')}
                </span>
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#28C76F]/15 text-[#28C76F]">
                  {t('whatsapp.presetUltraSafeTag')}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
                {t('whatsapp.presetUltraSafeDesc')}
              </p>
            </button>

            {/* Preset 2: Standard Balanced (Default) */}
            <button
              type="button"
              onClick={() => handlePresetSelect('standard_balanced')}
              className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                config.preset === 'standard_balanced'
                  ? 'border-[#7367F0] bg-[#7367F0]/10 ring-1 ring-[#7367F0]/50 shadow-sm'
                  : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100 dark:hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#7367F0]" />
                  {t('whatsapp.presetBalanced')}
                </span>
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#7367F0]/15 text-[#7367F0]">
                  {t('whatsapp.presetBalancedTag')}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
                {t('whatsapp.presetBalancedDesc')}
              </p>
            </button>

            {/* Preset 3: Fast Warmed */}
            <button
              type="button"
              onClick={() => handlePresetSelect('fast_warmed')}
              className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                config.preset === 'fast_warmed'
                  ? 'border-[#FF9F43] bg-[#FF9F43]/10 ring-1 ring-[#FF9F43]/50 shadow-sm'
                  : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100 dark:hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-[#FF9F43]" />
                  {t('whatsapp.presetFast')}
                </span>
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#FF9F43]/15 text-[#FF9F43]">
                  {t('whatsapp.presetFastTag')}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
                {t('whatsapp.presetFastDesc')}
              </p>
            </button>
          </div>
        </div>

        {/* Detailed Sliders */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          <Slider
            label={t('whatsapp.minDelay')}
            icon={Clock}
            value={config.min_delay_seconds}
            min={10}
            max={120}
            step={5}
            unit="s"
            helperText={t('whatsapp.minDelayHelp')}
            onChange={(val) => {
              handleCustomChange('min_delay_seconds', val);
              if (val >= config.max_delay_seconds) {
                handleCustomChange('max_delay_seconds', val + 15);
              }
            }}
          />

          <Slider
            label={t('whatsapp.maxDelay')}
            icon={Clock}
            value={config.max_delay_seconds}
            min={config.min_delay_seconds + 5}
            max={240}
            step={5}
            unit="s"
            helperText={t('whatsapp.maxDelayHelp')}
            onChange={(val) => handleCustomChange('max_delay_seconds', val)}
          />

          <Slider
            label={t('whatsapp.typingDelay')}
            icon={Sliders}
            value={config.typing_delay_seconds}
            min={1}
            max={15}
            step={1}
            unit="s"
            helperText={t('whatsapp.typingDelayHelp')}
            onChange={(val) => handleCustomChange('typing_delay_seconds', val)}
          />

          <Slider
            label={t('whatsapp.dailyLimitSlider')}
            icon={Shield}
            value={config.daily_message_limit}
            min={10}
            max={250}
            step={5}
            helperText={t('whatsapp.dailyLimitHelp')}
            onChange={(val) => handleCustomChange('daily_message_limit', val)}
          />
        </div>

        {/* Working Hours Protection & Smooth Risk Gauge */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          {/* Working Hours Box */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-3 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Building2 className="w-4 h-4 text-[#7367F0]" />
                <div>
                  <span className="text-xs font-extrabold text-slate-800 dark:text-white block">
                    {t('whatsapp.workingHoursTitle')}
                  </span>
                  <span className="text-[10px] text-slate-400">{t('whatsapp.workingHoursSubtitle')}</span>
                </div>
              </div>

              <Switch
                checked={config.working_hours_enabled !== false}
                onChange={(checked) => handleCustomChange('working_hours_enabled', checked)}
              />
            </div>

            {config.working_hours_enabled !== false && (
              <div className="space-y-2.5 pt-1 animate-fade-in">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => {
                      handleCustomChange('working_hours_start', '09:00');
                      handleCustomChange('working_hours_end', '18:00');
                    }}
                    className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                      config.working_hours_start === '09:00' && config.working_hours_end === '18:00'
                        ? 'bg-[#7367F0]/15 text-[#7367F0] border-[#7367F0]/40'
                        : 'bg-white dark:bg-white/[0.04] text-slate-500 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100'
                    }`}
                  >
                    {t('whatsapp.presetStandardHours')}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      handleCustomChange('working_hours_start', '09:00');
                      handleCustomChange('working_hours_end', '18:30');
                    }}
                    className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                      config.working_hours_start === '09:00' && config.working_hours_end === '18:30'
                        ? 'bg-[#7367F0]/15 text-[#7367F0] border-[#7367F0]/40'
                        : 'bg-white dark:bg-white/[0.04] text-slate-500 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100'
                    }`}
                  >
                    {t('whatsapp.presetCorporateHours')}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      handleCustomChange('working_hours_start', '09:00');
                      handleCustomChange('working_hours_end', '20:00');
                    }}
                    className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                      config.working_hours_start === '09:00' && config.working_hours_end === '20:00'
                        ? 'bg-[#7367F0]/15 text-[#7367F0] border-[#7367F0]/40'
                        : 'bg-white dark:bg-white/[0.04] text-slate-500 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100'
                    }`}
                  >
                    {t('whatsapp.presetFlexibleHours')}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 dark:text-[#7E7F96] block mb-1">
                      {t('whatsapp.startTime')}
                    </label>
                    <input
                      type="time"
                      value={config.working_hours_start || '09:00'}
                      onChange={(e) => handleCustomChange('working_hours_start', e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg vuexy-input text-xs font-mono font-bold"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 dark:text-[#7E7F96] block mb-1">
                      {t('whatsapp.endTime')}
                    </label>
                    <input
                      type="time"
                      value={config.working_hours_end || '18:30'}
                      onChange={(e) => handleCustomChange('working_hours_end', e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg vuexy-input text-xs font-mono font-bold"
                    />
                  </div>
                </div>
              </div>
            )}
            <p className="text-[10px] text-slate-400">
              {t('whatsapp.workingHoursHelp')}
            </p>
          </div>

          {/* Smooth Animated Risk Meter */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] flex flex-col justify-between space-y-3 shadow-sm">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                  <AlertTriangle className={`w-4 h-4 ${riskInfo.color}`} />
                  {t('whatsapp.riskTitle')}
                </span>
                <span className={`text-[11px] font-extrabold px-2.5 py-0.5 rounded-lg border font-mono uppercase transition-all duration-300 ${riskInfo.badgeBg} ${riskInfo.badgeText}`}>
                  {riskInfo.title} (%{riskInfo.score})
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] leading-relaxed">
                {riskInfo.desc}
              </p>
            </div>

            <div className="space-y-1.5 pt-1">
              <div className="relative w-full h-3 rounded-full bg-slate-200 dark:bg-slate-700 overflow-visible p-0.5">
                <div 
                  className="w-full h-full rounded-full bg-gradient-to-r from-[#28C76F] via-[#FF9F43] to-[#EA5455] opacity-90"
                />
                <div 
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-white dark:bg-slate-900 border-2 rounded-full shadow-md transition-all duration-500 ease-out z-10 flex items-center justify-center"
                  style={{ 
                    left: `${Math.max(4, Math.min(96, riskInfo.score))}%`,
                    borderColor: riskInfo.color 
                  }}
                >
                  <div 
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: riskInfo.color }}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-[9px] font-bold text-slate-400 font-mono px-0.5">
                <span className="text-[#28C76F]">{t('whatsapp.riskSafe')}</span>
                <span className="text-[#FF9F43]">{t('whatsapp.riskBalanced')}</span>
                <span className="text-[#EA5455]">{t('whatsapp.riskHigh')}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Save Actions */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-white/[0.05]">
          <div className="flex items-center gap-2">
            {saveSuccess ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#28C76F] bg-[#28C76F]/15 px-3 py-1.5 rounded-lg border border-[#28C76F]/30 animate-fade-in">
                <Check className="w-3.5 h-3.5" />
                <span>{t('whatsapp.policySavedSuccess')}</span>
              </span>
            ) : hasUnsavedChanges ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#FF9F43] bg-[#FF9F43]/15 px-3 py-1.5 rounded-lg border border-[#FF9F43]/30 animate-fade-in">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>{t('whatsapp.unsavedChangesDesc')}</span>
              </span>
            ) : (
              <span className="text-xs text-slate-400 dark:text-[#7E7F96]">
                {savedConfig.updated_at
                  ? `${t('whatsapp.synchronized')}: ${new Date(savedConfig.updated_at).toLocaleTimeString()}`
                  : t('whatsapp.synchronized')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {hasUnsavedChanges && (
              <Button
                variant="outline"
                onClick={handleRevertChanges}
                className="space-x-1.5 font-bold text-slate-600 dark:text-slate-300 cursor-pointer"
              >
                <Undo2 className="w-4 h-4" />
                <span>{t('whatsapp.revertChanges')}</span>
              </Button>
            )}

            <Button
              onClick={handleSaveAntiBan}
              disabled={isSavingAntiBan || !hasUnsavedChanges}
              className={`space-x-2 font-bold justify-center cursor-pointer transition-all duration-300 ${
                hasUnsavedChanges
                  ? 'bg-[#7367F0] hover:bg-[#5E50EE] text-white shadow-lg shadow-[#7367F0]/30 ring-2 ring-[#7367F0]/30'
                  : 'bg-slate-200 dark:bg-white/[0.08] text-slate-400 dark:text-slate-500 cursor-not-allowed'
              }`}
            >
              {isSavingAntiBan ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('whatsapp.saving')}</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>{hasUnsavedChanges ? t('whatsapp.savePolicy') : t('whatsapp.savedStatus')}</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </Card>

      {/* Anti-Ban Safeguard Guidelines */}
      <div className="grid grid-cols-1">
        <div>
          <Card className="p-6 space-y-4">
            <h3 className="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-[#28C76F]" />
              {t('whatsapp.guidelinesTitle')}
            </h3>

            <div className="space-y-2.5 text-xs text-slate-700 dark:text-slate-300 font-medium">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-1">
                <span className="font-bold text-[#28C76F]">{t('whatsapp.guideline1Title')}</span>
                <p className="text-slate-500 dark:text-[#7E7F96] text-[11px]">
                  {t('whatsapp.guideline1Desc')}
                </p>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-1">
                <span className="font-bold text-[#00CFE8]">{t('whatsapp.guideline2Title')}</span>
                <p className="text-slate-500 dark:text-[#7E7F96] text-[11px]">
                  {t('whatsapp.guideline2Desc')}
                </p>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-1">
                <span className="font-bold text-[#7367F0]">{t('whatsapp.guideline3Title')}</span>
                <p className="text-slate-500 dark:text-[#7E7F96] text-[11px]">
                  {t('whatsapp.guideline3Desc')}
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
      </div>
      )}

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
