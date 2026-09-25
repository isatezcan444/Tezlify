import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AlertTriangle, ChevronDown, Loader2, ArrowUp, RotateCcw } from 'lucide-react';
import { Message } from '../../../types';
import { ChatBubble } from './ChatBubble';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Skeleton } from '../../../components/ui/Skeleton';
import { WhatsAppIcon } from '../../../components/ui/whatsapp-icon';
import { useI18n } from '../../../context/I18nContext';
import { parseServerTime, formatMessageDate } from '../../../lib/utils';
import { finishWaLatency } from '../lib/whatsappLatency';

/** WhatsApp Web tarzı 'yazıyor...' balonu (üç zıplayan nokta). */
const TypingBubble: React.FC<{ label: string }> = ({ label }) => (
  <div
    className="inline-flex items-center space-x-1.5 px-3.5 py-2.5 rounded-2xl rounded-tl-sm bg-white dark:bg-[#1E2333] shadow-sm border border-slate-200/80 dark:border-white/[0.08]"
    aria-label={label}
  >
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-bounce"
        style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.9s' }}
      />
    ))}
  </div>
);

// ========================================================= PHASE 2.K.19 =======
// LOCAL-AUTHORITATIVE / GLOBAL-APPROXIMATE virtualization, integrated per the
// K.18 / K.18.1 forensic verdicts. Default OFF:
//
//   window.__K19_LOCAL_WINDOW__ === true  AND  rows > K19_MIN_ROWS  -> new model
//   everything else                                                -> EXACT legacy path
//
// Model (all points measured in K.18/K.18.1 before being wired here):
//   * mounted rows are the only authoritative heights (real DOM, ResizeObserver
//     feeds a cache — never a setState→render→RO loop);
//   * distant rows contribute an APPROXIMATE estimate that is never labelled
//     authoritative, so global scrollHeight is knowingly inexact (~5%);
//   * every geometry-affecting logical operation (scroll, prepend, async
//     resize, bottom) issues AT MOST ONE scroll write, applied in the same
//     synchronous block as its commit — i.e. before browser paint, the same
//     guarantee production's existing prepend restore relies on;
//   * offscreen-ABOVE changes are NOT inert (K.18.1): they route through the
//     same single pre-paint pin; below-viewport changes stay inert (0 writes);
//   * height cache is keyed by stable row key + content width; a width change
//     invalidates authority; identity churn (temp -> wa_message_id) orphans an
//     entry (never misattributes it) and is pruned.
// ==================================================================================
const K19_MIN_ROWS = 200;
const K19_OVERSCAN_ROWS = 25;
const K19_FALLBACK_HEIGHT = 72;      // APPROXIMATE ONLY — never authoritative
const K19_ROW_GAP = 4;               // window reproduces legacy space-y-1 (4px);
                                     // the bubble's own mb-3 (12px) is contained by the
                                     // flow-root wrapper, so a measured row = 12 + 4 gap.

const k19FlagOn = (): boolean =>
  typeof window !== 'undefined' &&
  (window as { __K19_LOCAL_WINDOW__?: boolean }).__K19_LOCAL_WINDOW__ === true;

const rowKeyOf = (msg: Message): string => String(msg.wa_message_id || msg.id);

interface ThreadRow { key: string; msg: Message; dateLabel: string; showDate: boolean }
interface K19Height { h: number; w: number; auth: boolean }
/** Minimal per-operation record: only the ≤1-write accounting the deferred-pin
 * plumbing needs. The forensic ledger was removed for the release candidate. */
interface K19Op { type: string; writes: number }

export interface ChatThreadProps {
  messages: Message[];
  loading?: boolean;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  leadName?: string;
  leadPhone?: string;
  /** Faz 6a: grup sohbetinde balonlarda katilimci adlari gosterilir. */
  isGroup?: boolean;
  onRetry?: (messageId: number | string) => Promise<void> | void;
  peerTyping?: boolean;
  /** Sorun 2 (LOADING ≠ EMPTY ≠ ERROR): bu sohbetin MESAJ hidrasyonu
   * basarisiz olduysa hata mesaji. Yalnizca BU sohbeti etkiler — diger
   * sohbetler ve liste etkilenmez; mevcut mesajlar varsa silinmez. */
  error?: string | null;
  /** Hidrasyon hatasindan sonra "tekrar dene". */
  onRetryLoad?: () => void;
  /** Eski sayfa (history pagination) basarisiz mi — mevcut mesajlar korunur. */
  pagingError?: boolean;
  /**
   * Identity of the conversation currently rendered. When it changes, THIS
   * instance resets itself for the new conversation instead of being destroyed
   * and rebuilt: the host pane keeps exactly one thread root for its whole
   * lifetime. Omitting it preserves the previous behaviour (no reset).
   */
  conversationKey?: string | number | null;
}

export const ChatThread: React.FC<ChatThreadProps> = ({
  messages,
  loading = false,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  leadName,
  isGroup = false,
  onRetry,
  peerTyping = false,
  error = null,
  onRetryLoad,
  pagingError = false,
  conversationKey = null,
}) => {
  const { t, language } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (messages.length) finishWaLatency('chat_request_to_commit_ms', messages[0].conversation_id);
  }, [messages]);

  const prevScrollHeightRef = useRef<number>(0);
  const prevScrollTopRef = useRef<number>(0);
  const isPrependingRef = useRef<boolean>(false);
  // Snapshot of the thread at the moment a prepend was requested. It lets the
  // restore effect tell a REAL prepend (older messages added at the front)
  // apart from any other change, so an unrelated event can never apply a
  // bogus scrollTop or leave the guard stuck.
  const pendingPrependRef = useRef<{ firstId: string | number | null; count: number } | null>(null);
  const prevMessagesCountRef = useRef<number>(messages.length);
  // P6-7: pagination must not fire before the thread has taken its initial
  // position. On mount `scrollTop` is still 0, so any scroll event raised while
  // the initial scroll is running looks exactly like "the user is at the top".
  const initialScrollDoneRef = useRef<boolean>(false);

  const [isNearBottom, setIsNearBottom] = useState<boolean>(true);
  const [showNewMessagePill, setShowNewMessagePill] = useState<boolean>(false);
  // Bumped by the conversation-switch reset below so the "open at the newest
  // message" effect re-runs for a conversation the instance was NOT mounted
  // with — the instance survives switches, so mount alone is no longer a
  // position event.
  const [convEpoch, setConvEpoch] = useState<number>(0);

  // Guarantee strictly chronological message order in the thread
  const sortedMessages = React.useMemo(() => {
    return [...messages].sort((a, b) => {
      const tA = new Date(a.created_at || a.external_timestamp || 0).getTime();
      const tB = new Date(b.created_at || b.external_timestamp || 0).getTime();
      if (tA !== tB) return tA - tB;
      const nA = typeof a.id === 'number' ? a.id : 0;
      const nB = typeof b.id === 'number' ? b.id : 0;
      return nA - nB;
    });
  }, [messages]);

  // ------------------------------------------------------------- K.19 state
  const rows = React.useMemo<ThreadRow[]>(() => {
    const out: ThreadRow[] = [];
    let lastDate = '';
    for (const msg of sortedMessages) {
      const dateLabel = formatMessageDate(msg.created_at || msg.external_timestamp, language, t('leads.today'), t('leads.yesterday'));
      const showDate = Boolean(dateLabel) && dateLabel !== lastDate;
      if (showDate) lastDate = dateLabel;
      out.push({ key: rowKeyOf(msg), msg, dateLabel, showDate });
    }
    return out;
  }, [sortedMessages, language, t]);

  const virtualize = k19FlagOn() && rows.length > K19_MIN_ROWS;
  const virtualizeRef = useRef(virtualize);
  virtualizeRef.current = virtualize;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const heightsRef = useRef<Map<string, K19Height>>(new Map());
  const elsRef = useRef<Map<string, HTMLElement>>(new Map());
  const [win, setWin] = useState<{ start: number; end: number }>({ start: 0, end: -1 });
  const winRef = useRef(win);
  // render-time mirror: geomOp must be able to tell, during a LAYOUT effect,
  // whether its setWin actually re-committed — a passive sync would lag.
  winRef.current = win;
  const scrollTopRef = useRef(0);
  const anchorRef = useRef<{ key: string; y: number } | null>(null);
  const busyRef = useRef(false);
  const programmaticRef = useRef(false);
  const pendingPrependK19Ref = useRef<{ wantY: number | null; atBottom: boolean; prevFirstKey: string | null } | null>(null);
  const pendingPinRef = useRef<{ op: K19Op; pinMode: 'anchor' | 'bottom' | null; wantY: number | null } | null>(null);
  // K.19.3-1A: distance-to-bottom as last OBSERVED (scroll event / pin completion /
  // RO settle) — i.e. the state BEFORE the next geometry mutation. RO routing must
  // use this operation-start snapshot, never live geometry (the browser has already
  // laid out the growth by the time the RO callback runs — K.19.2 S4b).
  const bottomDistRef = useRef<number>(Number.POSITIVE_INFINITY);
  // K.19.3-1B: RO deliveries arriving while a pin holds busyRef are not discarded;
  // they arm at most one controlled re-check after the pin completes.
  const pendingRORef = useRef(false);
  const roTickRef = useRef<(() => void) | null>(null);
  // K.21-B: flushSync only runs where it actually works (outside React
  // lifecycles). Callers inside a layout/passive effect mark the context so
  // geomOp takes the deferred state-update path there — the forensic run
  // proved flushSync never re-flushes mid-lifecycle anyway.
  const fsCtxRef = useRef<'handler' | 'layout' | 'passive'>('handler');

  const topsOf = useCallback((): number[] => {
    const r = rowsRef.current;
    const t = new Array<number>(r.length + 1);
    t[0] = 0;
    for (let i = 0; i < r.length; i++) {
      const e = heightsRef.current.get(r[i].key);
      t[i + 1] = t[i] + (e && e.auth ? e.h : K19_FALLBACK_HEIGHT + K19_ROW_GAP);
    }
    return t;
  }, []);

  const deriveRange = (t: number[], scrollTop: number, clientH: number) => {
    const n = rowsRef.current.length;
    if (!n) return { start: 0, end: -1 };
    const ov = K19_OVERSCAN_ROWS * (K19_FALLBACK_HEIGHT + K19_ROW_GAP);
    let start = -1;
    let end = -1;
    for (let i = 0; i < n; i++) {
      if (t[i + 1] > scrollTop - ov && t[i] < scrollTop + clientH + ov) {
        if (start < 0) start = i;
        end = i;
      }
    }
    if (start < 0) return { start: 0, end: Math.min(n - 1, Math.ceil(clientH / K19_FALLBACK_HEIGHT) + K19_OVERSCAN_ROWS) };
    return { start, end };
  };

  const measureMounted = (): number => {
    const cont = containerRef.current;
    if (!cont) return 0;
    const width = cont.clientWidth - 32;
    let changes = 0;
    for (const el of cont.querySelectorAll<HTMLElement>('[data-k]')) {
      const key = el.dataset.k as string;
      const h = el.offsetHeight + K19_ROW_GAP;
      const prev = heightsRef.current.get(key);
      if (!prev || !prev.auth || Math.abs(prev.h - h) > 0.5) {
        heightsRef.current.set(key, { h, w: width, auth: true });
        changes++;
      }
    }
    return changes;
  };

  const anchorInfo = (): { key: string; y: number; atBottom: boolean } | null => {
    const cont = containerRef.current;
    if (!cont) return null;
    const er = cont.getBoundingClientRect();
    const mounted = [...cont.querySelectorAll<HTMLElement>('[data-k]')];
    // The anchor must be a row that is REALLY in the viewport right now. When
    // the mounted window lags a user jump, every mounted row is off-screen and
    // any "anchor" picked from it is stale garbage — pinning it would CLOBBER
    // the user's own gesture (K.19.1 finding). No in-viewport row → no anchor.
    let pick: HTMLElement | null = null;
    for (const el of mounted) {
      const y = el.getBoundingClientRect().top - er.top;
      if (y >= 0 && y <= cont.clientHeight) { pick = el; break; }
    }
    const atBottom = cont.scrollHeight - cont.scrollTop - cont.clientHeight <= 2;
    if (!pick) return { key: '', y: 0, atBottom };
    return { key: pick.dataset.k as string, y: pick.getBoundingClientRect().top - er.top, atBottom };
  };

  const trackAnchor = () => {
    const a = anchorInfo();
    if (a && a.key) anchorRef.current = { key: a.key, y: a.y };
    else anchorRef.current = null;
  };

  /**
   * The single logical geometry operation (K.18.1 contract):
   *   measure → commit → AT MOST ONE scroll write, in the same synchronous
   * block as the commit — i.e. before paint. `wantY` = the anchor's measured
   * screen offset BEFORE this operation's geometry change (0px first-paint
   * requirement); `atBottom` = sampled at operation start (K.13 lesson).
   */
  /**
   * K.19.1 IDENTITY-ANCHORED WINDOW. Whenever an operation is going to PIN an
   * anchor (or the bottom), the window must be selected by message IDENTITY,
   * never by scanning estimate-space tops at a real-space scrollTop: at large
   * offsets the two spaces disagree enough that the pinned anchor would sit
   * outside the derived window, gets unmounted by the very commit, and the pin
   * can no longer execute (K.19 failure). The anchor is included by index
   * (identity → index), so "anchor mounted before pin" holds BY CONSTRUCTION.
   * Plain small-scroll window growth (pin: null) still uses the scrollTop-space
   * derivation above — unchanged from K.19.
   */
  const anchorCenteredRange = (anchorKey: string | null, toBottom: boolean): { start: number; end: number } | null => {
    const n = rowsRef.current.length;
    if (!n) return null;
    let ai: number;
    if (toBottom) ai = n - 1;
    else {
      if (!anchorKey) return null;
      const idx = rowsRef.current.findIndex((r) => r.key === anchorKey);
      if (idx < 0) return null;
      ai = idx;
    }
    const cont = containerRef.current;
    const visible = Math.ceil(((cont?.clientHeight || 600) * 1.35) / K19_FALLBACK_HEIGHT) + 2;
    // A bottom pin anchors on the LAST row, so the window must grow UPWARD;
    // an anchor pin sits near the viewport top, so it grows downward.
    return toBottom
      ? { start: Math.max(0, ai - visible), end: ai }
      : { start: Math.max(0, ai - 1), end: Math.min(n - 1, ai + visible) };
  };

  /**
   * K.19.3-1B: at most ONE controlled re-check per busy event, scheduled after the
   * pin releases. The flag is only consumed when the tick can actually run, so a
   * busy microtask cannot lose the pending geometry. Cache dedup (equal height →
   * no operation) guarantees the re-check never loops for the same change.
   */
  const maybeRORecheck = () => {
    if (!pendingRORef.current) return;
    queueMicrotask(() => {
      if (!pendingRORef.current || busyRef.current || !virtualizeRef.current) return;
      pendingRORef.current = false;
      roTickRef.current?.();
    });
  };

  /**
   * The measurement+write half of an operation. Runs AFTER the DOM has actually
   * committed the new window: either inline (event-handler path, where
   * flushSync re-flushes) or from the post-win layout effect (prepend path,
   * where flushSync cannot re-flush mid-commit). Still pre-paint either way,
   * and it holds the ≤1 scroll-write invariant.
   */
  const runPin = (op: K19Op, pinMode: 'anchor' | 'bottom' | null, wantY: number | null) => {
    const cont = containerRef.current;
    if (!cont) return;
    // Fill the cache from the rows the commit just mounted: mounted heights are
    // already what the browser paints, so recording them shifts nothing, and
    // the NEXT operation gets authoritative spacers for them.
    measureMounted();
    if (pinMode === 'bottom') {
      const delta = cont.scrollHeight - cont.clientHeight - cont.scrollTop;
      if (Math.abs(delta) > 0.5) { programmaticRef.current = true; cont.scrollTop = cont.scrollTop + delta; op.writes++; }
    } else if (pinMode === 'anchor' && wantY != null) {
      const a = anchorRef.current;
      const el = a && cont.querySelector<HTMLElement>(`[data-k="${CSS.escape(a.key)}"]`);
      if (el) {
        const y = el.getBoundingClientRect().top - cont.getBoundingClientRect().top;
        const delta = y - wantY;
        if (Math.abs(delta) > 0.5) { programmaticRef.current = true; cont.scrollTop = cont.scrollTop + delta; op.writes++; }
      }
    }
    trackAnchor();
    scrollTopRef.current = cont.scrollTop;
    bottomDistRef.current = cont.scrollHeight - cont.scrollTop - cont.clientHeight;
  };

  const geomOp = useCallback((type: K19Op['type'], opts: {
    wantY?: number | null; atBottom?: boolean; affected?: string[]; pin?: 'anchor' | 'bottom' | null;
  } = {}) => {
    if (!virtualizeRef.current || busyRef.current) return;
    const cont = containerRef.current;
    if (!cont) return;
    busyRef.current = true;
    const op: K19Op = { type, writes: 0 };
    try {
      measureMounted();
      // width invalidation: entries measured at a different content width lose
      // authority (never silently reused — K.16 invalidation contract).
      const width = cont.clientWidth - 32;
      for (const [k, e] of heightsRef.current) if (e.auth && e.w !== width) heightsRef.current.set(k, { ...e, auth: false });
      // identity prune: keys that no longer exist (temp -> wa_message_id churn)
      const live = new Set(rowsRef.current.map((r) => r.key));
      if (heightsRef.current.size > rowsRef.current.length) for (const k of [...heightsRef.current.keys()]) if (!live.has(k)) heightsRef.current.delete(k);

      const topsArr = topsOf();
      const total = topsArr[rowsRef.current.length] ?? 0;
      const pinMode = opts.pin ?? null;
      const targetScroll = pinMode === 'bottom'
        ? Math.max(0, total - cont.clientHeight)
        : (pinMode === 'anchor' && anchorRef.current && opts.wantY != null
            ? (() => {
                const ai = rowsRef.current.findIndex((r) => r.key === anchorRef.current!.key);
                if (ai < 0) return cont.scrollTop;              // stale/unknown anchor: never jump on NaN
                return Math.max(0, topsArr[ai] - opts.wantY!);
              })()
            : cont.scrollTop);
      const range = deriveRange(topsArr, targetScroll, cont.clientHeight);
      // K.19.1: pin operations take the IDENTITY-centered window instead, so the
      // row about to be pinned is guaranteed mounted by the same commit.
      const centered = pinMode === 'bottom'
        ? anchorCenteredRange(null, true)
        : pinMode === 'anchor' && anchorRef.current
          ? anchorCenteredRange(anchorRef.current.key, false)
          : null;
      const finalRange = centered ?? range;
      const nextWin = { start: Math.max(0, finalRange.start), end: finalRange.end };
      const fsCtx = fsCtxRef.current; fsCtxRef.current = 'handler';
      // K.21-B: flushSync runs only where it actually works (outside React
      // lifecycles — scroll handlers and RO callbacks). Inside a layout or
      // passive effect React cannot re-flush mid-commit and the validated
      // control proved those calls never committed inline anyway; there a
      // plain state update takes the IDENTICAL deferred-pin path (pre-paint
      // via the post-win layout effect) without the dev warning.
      if (fsCtx === 'handler') flushSync(() => setWin(nextWin));   // commit pre-paint
      else setWin(nextWin);   // layout/passive: deferred pin, same frame, pre-paint
      if (winRef.current.start === nextWin.start && winRef.current.end === nextWin.end) {
        runPin(op, pinMode, opts.wantY ?? null);
      } else {
        // geomOp was called from inside a layout effect (prepend): React cannot
        // re-flush mid-commit, so the new window lands in the SAME frame but in
        // the next commit pass. Finish the pin from the post-win layout effect —
        // busy stays held so no RO/scroll op interleaves the deferred pin.
        pendingPinRef.current = { op, pinMode, wantY: opts.wantY ?? null };
        queueMicrotask(() => {
          // deadlock valve: if the win commit somehow never ran, settle late
          // rather than freezing all geometry operations.
          const p = pendingPinRef.current;
          if (p && p.op === op) {
            pendingPinRef.current = null;
            try { runPin(p.op, p.pinMode, p.wantY); } finally { busyRef.current = false; maybeRORecheck(); }
          }
        });
      }
    } finally {
      if (!pendingPinRef.current || pendingPinRef.current.op !== op) { busyRef.current = false; maybeRORecheck(); }
    }
  }, [topsOf]);

  // --------------------------- ResizeObserver: store + async logical ops ----
  // RO NEVER writes scroll and never setStates straight from the callback; a
  // GENUINE height change (vs cache) opens one async-resize operation whose
  // single pin runs pre-paint. Equal height → no operation (dedup).
  // K.19.3: bottom routing uses bottomDistRef (state sampled BEFORE the mutation,
  // since live geometry at RO time already reflects it), and busy-window
  // deliveries arm at most one re-check instead of being discarded.
  useEffect(() => {
    if (!virtualize || win.start > win.end) return;
    const cont = containerRef.current;
    if (!cont) return;
    const roTick = () => {
      if (!virtualizeRef.current) return;
      if (busyRef.current) { pendingRORef.current = true; return; }
      let aboveChanged = false;
      let belowChanged = false;
      let firstRecord = false;
      const a = anchorInfo();
      const width = cont.clientWidth - 32;
      for (const el of cont.querySelectorAll<HTMLElement>('[data-k]')) {
        const key = el.dataset.k as string;
        const h = el.offsetHeight + K19_ROW_GAP;
        const prev = heightsRef.current.get(key);
        if (!prev || !prev.auth) {
          // first record of this row: cache it, no viewport effect, no operation
          // K.22.1: a genuine FIRST record is geometry the cache never described —
          // this row mounted (and painted) after the last operation's commit. Away
          // from the bottom it cannot move the viewport, so it stays a silent
          // cache-fill. In bottom-mode the content just grew UNDER a fixed bottom
          // (K.22 blocker: append 3px / init 101px), so consume the wave as ONE
          // bottom operation through the EXISTING pin path — runPin writes only
          // when |delta|>0.5, and once recorded the entry never first-records
          // again, so a settled geometry cannot re-op (loop guard by design).
          heightsRef.current.set(key, { h, w: width, auth: true });
          firstRecord = true;
          continue;
        }
        if (Math.abs(prev.h - h) > 0.5) {
          heightsRef.current.set(key, { h, w: width, auth: true });
          const er = cont.getBoundingClientRect();
          if (a && el.getBoundingClientRect().top - er.top < a.y) aboveChanged = true; else belowChanged = true;
        }
      }
      if (!aboveChanged && !belowChanged) {
        // K.22.1 micro-fix (see first-record branch): bottom-mode first-record wave
        // = content grew under a fixed bottom → exactly one existing-path re-pin.
        if (firstRecord && bottomDistRef.current < 120) geomOp('async-resize', { pin: 'bottom', affected: [] });
        return;
      }
      // ROUTING decision uses the pre-mutation snapshot. The snapshot is refreshed
      // only AFTER the dispatch (an inert below-change still moves the
      // distance-to-bottom for FUTURE operations; runPin re-samples after writes).
      // "At bottom" uses the SAME production near-bottom contract (<120px) the
      // non-virtualized path applies to new-message pinning — not a ≤2 exact-hit
      // (a settling async decode can leave a small residual that would otherwise
      // permanently drop the user out of bottom-follow mode, K.19.3 A/B probes).
      const wasAtBottom = bottomDistRef.current < 120;
      if (wasAtBottom) geomOp('async-resize', { pin: 'bottom', affected: [] });
      else if (aboveChanged && anchorRef.current) geomOp('async-resize', { pin: 'anchor', wantY: anchorRef.current.y, affected: [] });
      const c3 = containerRef.current;
      if (c3 && !busyRef.current) bottomDistRef.current = c3.scrollHeight - c3.scrollTop - c3.clientHeight;
      // below-only changes away from bottom are inert for the viewport: cache updated, no write
    };
    roTickRef.current = roTick;
    const ro = new ResizeObserver(() => roTick());
    for (const el of cont.querySelectorAll<HTMLElement>('[data-k]')) ro.observe(el);
    return () => { ro.disconnect(); if (roTickRef.current === roTick) roTickRef.current = null; };
  }, [virtualize, win.start, win.end, geomOp]);

  // -------------------------------------------------------------- scroll ----
  const handleScroll = () => {
    if (virtualizeRef.current) handleScrollK19();
    else handleScrollLegacy();
  };

  const handleScrollK19 = () => {
    const cont = containerRef.current;
    if (!cont) return;
    const { scrollTop, scrollHeight, clientHeight } = cont;
    scrollTopRef.current = scrollTop;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceToBottom < 120;
    bottomDistRef.current = distanceToBottom;   // K.19.3: operation-start bottom snapshot for the NEXT geometry change
    setIsNearBottom(nearBottom);
    if (nearBottom) setShowNewMessagePill(false);
    trackAnchor();
    if (programmaticRef.current) { programmaticRef.current = false; return; }   // our own pin's echo
    if (scrollTop < 60 && hasMore && !loadingOlder && initialScrollDoneRef.current) { handleLoadOlder(); return; }
    const topsArr = topsOf();
    const r = deriveRange(topsArr, scrollTop, clientHeight);
    if (r.start !== winRef.current.start || r.end !== winRef.current.end) {
      // window growth: rows entering are mounted by this commit and measured by
      // it; if any measured-above row was an estimate, anchor may move → pin.
      const a = anchorRef.current;
      geomOp('scroll', a ? { pin: 'anchor', wantY: a.y } : { pin: null });
    }
  };

  const handleScrollLegacy = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceToBottom < 120;
    setIsNearBottom(nearBottom);
    if (nearBottom) { setShowNewMessagePill(false); }
    if (scrollTop < 60 && hasMore && !loadingOlder && initialScrollDoneRef.current) {
      handleLoadOlder();
    }
  };

  const handleLoadOlder = () => {
    if (!onLoadOlder || loadingOlder || !containerRef.current) return;
    if (virtualizeRef.current) {
      const a = anchorInfo();
      let wantY: number | null = null;
      if (a && a.key) {
        const cur = anchorRef.current && anchorRef.current.key === a.key ? anchorRef.current : { key: a.key, y: a.y };
        anchorRef.current = cur;
        wantY = cur.y;
      } else {
        // K.19.1: no row is in the viewport (user flung the scrollbar far). The
        // only sound identity is the OLDEST loaded row pinned to the viewport
        // top — never fall back to a bottom pin, which teleports the user.
        const first = rowsRef.current[0];
        if (first) { anchorRef.current = { key: first.key, y: 0 }; wantY = 0; }
      }
      pendingPrependK19Ref.current = {
        wantY,
        atBottom: !!a && a.atBottom,
        prevFirstKey: rowsRef.current[0]?.key ?? null,
      };
      try { onLoadOlder(); } catch (err) {
        pendingPrependK19Ref.current = null;
        console.error('[ChatThread] onLoadOlder failed:', err);
      }
      return;
    }
    const first = sortedMessages[0];
    pendingPrependRef.current = {
      firstId: first ? (first.wa_message_id || first.id) : null,
      count: sortedMessages.length,
    };
    isPrependingRef.current = true;
    prevScrollHeightRef.current = containerRef.current.scrollHeight;
    prevScrollTopRef.current = containerRef.current.scrollTop;
    try {
      onLoadOlder();
    } catch (err) {
      // F-10: a synchronous throw must never leave the guard set.
      isPrependingRef.current = false;
      pendingPrependRef.current = null;
      console.error('[ChatThread] onLoadOlder failed:', err);
    }
  };

  // Legacy restore (flag-off / non-virtualized path only): height-delta restore.
  useLayoutEffect(() => {
    if (virtualizeRef.current) return;
    if (!isPrependingRef.current) return;
    const pending = pendingPrependRef.current;
    const first = sortedMessages[0];
    const firstId = first ? (first.wa_message_id || first.id) : null;
    const didPrepend =
      Boolean(pending) &&
      sortedMessages.length > pending!.count &&
      firstId !== pending!.firstId;
    if (didPrepend && containerRef.current) {
      const newScrollHeight = containerRef.current.scrollHeight;
      const heightDiff = newScrollHeight - prevScrollHeightRef.current;
      containerRef.current.scrollTop = prevScrollTopRef.current + heightDiff;
      isPrependingRef.current = false;
      pendingPrependRef.current = null;
      return;
    }
    if (!loadingOlder) {
      isPrependingRef.current = false;
      pendingPrependRef.current = null;
    }
  }, [sortedMessages, loadingOlder]);

  // K.19 prepend: older page landed → ONE logical op; new rows above the
  // viewport are estimates, but the pin is anchored on the anchor's REAL
  // measured position after commit → 0px first paint (K.18.1 P50/P100).
  useLayoutEffect(() => {
    if (!virtualize) return;
    const pend = pendingPrependK19Ref.current;
    if (!pend) return;
    const firstKey = rows[0]?.key ?? null;
    if (firstKey && firstKey !== pend.prevFirstKey && rows.length > 0) {
      pendingPrependK19Ref.current = null;
      fsCtxRef.current = 'layout';   // K.21 §1: this geomOp runs inside a layout effect (commit phase)
      if (pend.atBottom) geomOp('prepend', { pin: 'bottom' });
      else if (pend.wantY != null && anchorRef.current) geomOp('prepend', { pin: 'anchor', wantY: pend.wantY });
      else geomOp('prepend', { pin: 'bottom' });
    } else if (!loadingOlder) {
      pendingPrependK19Ref.current = null;
    }
  }, [rows, loadingOlder, virtualize, geomOp]);

  // K.19.1 DEFERRED PIN: when geomOp ran from a layout effect, React committed
  // the new window in the NEXT pass (flushSync cannot re-flush mid-commit). This
  // effect fires with that commit — DOM already shows the identity-centered
  // window, still before paint — and performs the operation's single scroll write.
  useLayoutEffect(() => {
    if (!virtualize) return;
    const p = pendingPinRef.current;
    if (!p) return;
    pendingPinRef.current = null;
    try {
      runPin(p.op, p.pinMode, p.wantY);
    } finally {
      busyRef.current = false;
      maybeRORecheck();
    }
  }, [win, virtualize]);

  const newestKey = sortedMessages.length ? rowKeyOf(sortedMessages[sortedMessages.length - 1]) : null;
  const prevNewestKeyRef = useRef<string | null>(newestKey);

  // ------------------------------------------------------ conversation reset
  // Switching conversations must NOT destroy and rebuild this subtree. A
  // rebuild is a deletion, and a deletion that does not complete leaves the
  // stale root in the pane — production showed one extra ChatThread per
  // clicked conversation, each frozen on its own chat. Here the instance stays
  // mounted for the pane's whole lifetime and clears its own per-conversation
  // state instead, which is exactly the state a fresh mount would have started
  // with. This is a render-phase state adjustment (React's documented
  // "adjust state when a prop changes" pattern): React re-renders before
  // committing, so no intermediate state ever paints.
  const prevConversationKeyRef = useRef(conversationKey);
  if (conversationKey !== prevConversationKeyRef.current) {
    prevConversationKeyRef.current = conversationKey;
    // legacy scroll/prepend guards
    isPrependingRef.current = false;
    pendingPrependRef.current = null;
    prevScrollHeightRef.current = 0;
    prevScrollTopRef.current = 0;
    initialScrollDoneRef.current = false;
    // inbound detection must not read the switch as a new message
    prevMessagesCountRef.current = messages.length;
    prevNewestKeyRef.current = newestKey;
    setIsNearBottom(true);
    setShowNewMessagePill(false);
    // K.19 geometry model
    heightsRef.current.clear();
    elsRef.current.clear();
    scrollTopRef.current = 0;
    anchorRef.current = null;
    busyRef.current = false;
    programmaticRef.current = false;
    pendingPrependK19Ref.current = null;
    pendingPinRef.current = null;
    bottomDistRef.current = Number.POSITIVE_INFINITY;
    pendingRORef.current = false;
    winRef.current = { start: 0, end: -1 };
    setWin({ start: 0, end: -1 });
    setConvEpoch((n) => n + 1);
  }

  // Smart Auto-Scroll when new messages arrive at the end
  useEffect(() => {
    const isNewMessageAdded =
      sortedMessages.length > prevMessagesCountRef.current &&
      newestKey !== prevNewestKeyRef.current;
    prevMessagesCountRef.current = sortedMessages.length;
    prevNewestKeyRef.current = newestKey;

    if (isNewMessageAdded && !isPrependingRef.current) {
      if (isNearBottom) {
        if (virtualizeRef.current) { fsCtxRef.current = 'passive'; geomOp('new-message', { pin: 'bottom' }); }
        else bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        setShowNewMessagePill(false);
      } else {
        setShowNewMessagePill(true);
      }
    }
  }, [sortedMessages, isNearBottom, geomOp]);

  // Initial scroll to bottom on mount, on load finishing, on a conversation
  // switch (convEpoch) — the instance is reused across switches — and on the
  // chat first getting content. The last one is not redundant: a message can
  // arrive in an empty chat with no `loading` transition (realtime inbound),
  // and nothing else would take the thread to its newest message there.
  const hasContent = sortedMessages.length > 0;
  useEffect(() => {
    if (!loading && sortedMessages.length > 0 && isNearBottom) {
      if (virtualizeRef.current) { fsCtxRef.current = 'passive'; geomOp('initial', { pin: 'bottom', affected: [] }); }
      else bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
    initialScrollDoneRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, virtualize, convEpoch, hasContent]);

  const scrollToBottom = () => {
    if (virtualizeRef.current) geomOp('bottom', { pin: 'bottom' });
    else bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowNewMessagePill(false);
  };

  // ------------------------------------------------------------- render ----
  const renderRowBody = (row: ThreadRow) => (
    <>
      {row.showDate && (
        <div className="flex items-center justify-center my-4">
          <span className="px-3 py-1 rounded-full text-[10px] font-bold bg-slate-200/80 dark:bg-white/[0.08] text-slate-500 dark:text-slate-400 select-none shadow-xs">
            {row.dateLabel}
          </span>
        </div>
      )}
      <ChatBubble message={row.msg} isGroup={isGroup} chatTitle={leadName} onRetry={onRetry} />
    </>
  );

  const registerRow = useCallback((key: string, el: HTMLElement | null) => {
    if (el) elsRef.current.set(key, el);
    else elsRef.current.delete(key);
  }, []);

  if (loading) {
    return (
      <div className="flex-1 min-w-0 p-4 space-y-4 overflow-y-auto overflow-x-hidden">
        <div className="flex justify-start">
          <Skeleton className="w-48 h-12 rounded-2xl rounded-tl-sm" />
        </div>
        <div className="flex justify-end">
          <Skeleton className="w-56 h-14 rounded-2xl rounded-tr-sm" />
        </div>
        <div className="flex justify-start">
          <Skeleton className="w-64 h-16 rounded-2xl rounded-tl-sm" />
        </div>
      </div>
    );
  }

  if (!sortedMessages || sortedMessages.length === 0) {
    // Sorun 2: hidrasyon GERÇEKTEN basarisiz olduysa "mesaj yok" DEGIL —
    // ayri error state + retry. Bu yalnizca BU sohbetin durumudur.
    if (error) {
      return (
        <div className="relative flex-1 min-w-0 flex flex-col items-center justify-center p-6 min-h-0">
          <EmptyState
            icon={AlertTriangle}
            title={t('whatsapp.messagesLoadFailed')}
            description={error}
            action={
              onRetryLoad
                ? { label: t('whatsapp.retryBtn'), onClick: onRetryLoad, icon: RotateCcw }
                : undefined
            }
          />
          {peerTyping && (
            <div className="absolute bottom-3 left-4">
              <TypingBubble label={t('whatsapp.peerTyping')} />
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="relative flex-1 min-w-0 flex flex-col items-center justify-center p-6 min-h-0">
        <EmptyState
          icon={WhatsAppIcon}
          title={t('leads.noMessagesTitle')}
          description={t('leads.noMessagesDesc')}
        />
        {peerTyping && (
          <div className="absolute bottom-3 left-4">
            <TypingBubble label={t('whatsapp.peerTyping')} />
          </div>
        )}
      </div>
    );
  }

  const pagingBanner = pagingError ? (
    <div className="shrink-0 flex items-center justify-center gap-2 px-4 py-2 bg-rose-500/10 border-b border-rose-500/20 text-rose-600 dark:text-rose-400 text-[11px] font-bold">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
      <span>{t('whatsapp.messagesLoadFailed')}</span>
      {onLoadOlder && (
        <button
          type="button"
          onClick={handleLoadOlder}
          className="underline underline-offset-2 hover:opacity-80 cursor-pointer"
        >
          {t('leads.loadOlderMessages')}
        </button>
      )}
    </div>
  ) : null;

  const loadOlderButton = (
    <div className="flex justify-center my-2">
      <button
        type="button"
        onClick={handleLoadOlder}
        disabled={loadingOlder}
        className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-bold text-[#7367F0] bg-[#7367F0]/10 hover:bg-[#7367F0]/20 border border-[#7367F0]/20 transition-all cursor-pointer disabled:opacity-50"
      >
        {loadingOlder ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>{t('leads.loadingOlderMessages')}</span>
          </>
        ) : (
          <>
            <ArrowUp className="w-3.5 h-3.5" />
            <span>{t('leads.loadOlderMessages')}</span>
          </>
        )}
      </button>
    </div>
  );

  const pill = showNewMessagePill ? (
    <div className="absolute bottom-4 right-4 z-10 animate-bounce">
      <button
        type="button"
        onClick={scrollToBottom}
        className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-full bg-[#25D366] hover:bg-[#1EBE5D] text-white text-xs font-bold shadow-lg shadow-[#25D366]/30 transition-all cursor-pointer"
      >
        <span>{t('leads.newMessageAlert')}</span>
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
    </div>
  ) : null;

  // ------------------------------------------------------ LEGACY rendering
  // Byte-identical DOM + behaviour to the pre-K.19 production component.
  if (!virtualize) {
    return (
      <div className="relative flex-1 min-w-0 flex flex-col min-h-0">
        {pagingBanner}
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="flex-1 min-w-0 p-4 overflow-y-auto overflow-x-hidden space-y-1 scroll-smooth"
        >
          {hasMore && loadOlderButton}
          {rows.map((row) => (
            <React.Fragment key={row.key}>{renderRowBody(row)}</React.Fragment>
          ))}
          {peerTyping && (
            <div className="flex justify-start pt-1">
              <TypingBubble label={t('whatsapp.peerTyping')} />
            </div>
          )}
          <div ref={bottomRef} className="h-1" />
        </div>
        {pill}
      </div>
    );
  }

  // ---------------------------------- LOCAL-AUTHORITATIVE window rendering
  const topsArr = topsOf();
  const total = topsArr[rows.length] ?? 0;
  const topSpacer = topsArr[win.start] ?? 0;
  const bottomSpacer = Math.max(0, total - (topsArr[win.end + 1] ?? total));
  const mountedRows = win.end >= win.start ? rows.slice(win.start, win.end + 1) : [];

  return (
    <div className="relative flex-1 min-w-0 flex flex-col min-h-0">
      {pagingBanner}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{ overflowAnchor: 'none' }}
        className="flex-1 min-w-0 p-4 overflow-y-auto overflow-x-hidden scroll-smooth"
      >
        {win.start <= 0 && hasMore && loadOlderButton}
        <div aria-hidden style={{ height: `${topSpacer}px` }} />
        {mountedRows.map((row) => (
          <div
            key={row.key}
            data-k={row.key}
            ref={(el) => registerRow(row.key, el)}
            className="flow-root"
            style={{ marginBottom: `${K19_ROW_GAP}px` }}
          >
            {renderRowBody(row)}
          </div>
        ))}
        <div aria-hidden style={{ height: `${bottomSpacer}px` }} />
        {peerTyping && (
          <div className="flex justify-start pt-1">
            <TypingBubble label={t('whatsapp.peerTyping')} />
          </div>
        )}
        <div ref={bottomRef} className="h-1" />
      </div>
      {pill}
    </div>
  );
};
