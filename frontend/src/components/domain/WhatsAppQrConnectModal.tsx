import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { 
  Smartphone, 
  QrCode, 
  RefreshCw, 
  Loader2, 
  X, 
  CheckCircle2, 
  AlertTriangle,
  RotateCcw,
  Phone,
  KeyRound,
  Copy
} from 'lucide-react';
import { WhatsAppRepository } from '../../data/whatsapp/whatsappRepository';
import { WhatsAppSession } from '../../types';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { useToast } from '../../context/ToastContext';
import { useI18n } from '../../context/I18nContext';

export type QrModalState = 
  | 'INITIALIZING'
  | 'QR_READY'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'LOGGED_OUT'
  | 'ERROR';

export interface WhatsAppQrConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (session?: WhatsAppSession) => void;
  existingSessionId?: number;
  initialSessionName?: string;
}

export const WhatsAppQrConnectModal: React.FC<WhatsAppQrConnectModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  existingSessionId,
  initialSessionName,
}) => {
  const toast = useToast();
  const { t } = useI18n();

  // Lifecycle State Machine
  const [modalState, setModalState] = useState<QrModalState>('INITIALIZING');
  const [sessionId, setSessionId] = useState<number | null>(existingSessionId || null);
  const [sessionName, setSessionName] = useState<string>(initialSessionName || '');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [connectedPhone, setConnectedPhone] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // QR Expiry Countdown (25 seconds)
  const [secondsLeft, setSecondsLeft] = useState<number>(25);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  // Pairing-tab state ("Telefon No ile Bağlan")
  const [activeTab, setActiveTab] = useState<'qr' | 'pair'>('qr');
  const [pairingPhone, setPairingPhone] = useState<string>('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [isPairingLoading, setIsPairingLoading] = useState<boolean>(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingCopied, setPairingCopied] = useState<boolean>(false);

  const timerRef = useRef<any>(null);
  const fallbackPollRef = useRef<any>(null);
  const isMountedRef = useRef<boolean>(true);

  // Stable refs to break React effect dependency loops
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const hasInitializedRef = useRef<boolean>(false);
  const isInitializingRef = useRef<boolean>(false);
  const activeSessionIdRef = useRef<number | null>(existingSessionId || null);

  // Sync ref with existingSessionId prop if changed
  useEffect(() => {
    if (existingSessionId) {
      activeSessionIdRef.current = existingSessionId;
      setSessionId(existingSessionId);
    }
  }, [existingSessionId]);

  // Clean timer utilities
  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (fallbackPollRef.current) {
      clearInterval(fallbackPollRef.current);
      fallbackPollRef.current = null;
    }
  }, []);

  const resetCountdown = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setSecondsLeft(25);
    timerRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // Initialize or connect session (strictly idempotent)
  const initSession = useCallback(async () => {
    if (isInitializingRef.current) return;
    isInitializingRef.current = true;

    setModalState('INITIALIZING');
    setErrorMessage(null);
    setQrCode(null);
    setConnectedPhone(null);
    clearTimers();

    const targetSessionId = activeSessionIdRef.current || existingSessionId;

    try {
      if (targetSessionId) {
        // Reusing existing known session - READ ONLY, NEVER CREATE
        setSessionId(targetSessionId);
        activeSessionIdRef.current = targetSessionId;
        const qrRes = await WhatsAppRepository.getSessionQr(targetSessionId);
        if (!isMountedRef.current) return;

        if (qrRes.status === 'CONNECTED') {
          setConnectedPhone(qrRes.phone);
          setModalState('CONNECTED');
          clearTimers();
          if (onSuccessRef.current) onSuccessRef.current({ id: targetSessionId, phone_number: qrRes.phone } as any);
          return;
        }

        if (qrRes.qr_code) {
          setQrCode(qrRes.qr_code);
          setModalState('QR_READY');
          resetCountdown();
        } else {
          // Trigger refresh to get active QR for this session
          const refreshRes = await WhatsAppRepository.refreshSessionQr(targetSessionId);
          if (!isMountedRef.current) return;
          if (refreshRes.qr_code) {
            setQrCode(refreshRes.qr_code);
            setModalState('QR_READY');
            resetCountdown();
          } else if (refreshRes.error_message) {
            setModalState('ERROR');
            setErrorMessage(refreshRes.error_message);
          }
        }
      } else {
        // Create or resolve session via backend
        const nameToUse = initialSessionName?.trim() || 'Hat 1';
        setSessionName(nameToUse);

        const newSession = await WhatsAppRepository.createWhatsAppSession(nameToUse, 50);
        if (!isMountedRef.current) return;

        activeSessionIdRef.current = newSession.id;
        setSessionId(newSession.id);
        setSessionName(newSession.session_name);

        if (newSession.status === 'CONNECTED') {
          setConnectedPhone(newSession.phone_number || null);
          setModalState('CONNECTED');
          clearTimers();
          if (onSuccessRef.current) onSuccessRef.current(newSession);
          return;
        }

        if (newSession.qr_code) {
          setQrCode(newSession.qr_code);
          setModalState('QR_READY');
          resetCountdown();
        } else {
          // Gateway is generating QR, will receive via WebSocket or fallback poll
          setModalState('INITIALIZING');
        }
      }
    } catch (err: any) {
      if (!isMountedRef.current) return;
      setModalState('ERROR');
      setErrorMessage(err?.message || t('whatsapp.connectionErrorDesc') || 'Bağlantı başlatılamadı.');
    } finally {
      isInitializingRef.current = false;
    }
  }, [existingSessionId, initialSessionName, clearTimers, resetCountdown, t]);

  // Manual QR Refresh - strictly operates on current session_id
  const handleRefreshQr = useCallback(async () => {
    const targetSessionId = activeSessionIdRef.current || sessionId;
    if (!targetSessionId || isRefreshing) return;
    setIsRefreshing(true);
    try {
      const res = await WhatsAppRepository.refreshSessionQr(targetSessionId);
      if (!isMountedRef.current) return;

      if (res.status === 'CONNECTED') {
        setModalState('CONNECTED');
        clearTimers();
        toast.success(t('whatsapp.connectedState'), t('common.success'));
        if (onSuccessRef.current) onSuccessRef.current({ id: targetSessionId } as any);
        return;
      }

      if (res.qr_code) {
        setQrCode(res.qr_code);
        setModalState('QR_READY');
        resetCountdown();
      } else if (res.error_message) {
        setModalState('ERROR');
        setErrorMessage(res.error_message);
      }
    } catch (err: any) {
      toast.error(err?.message || t('whatsapp.refreshingQr') || 'QR kod yenilenemedi', t('common.error'));
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [sessionId, isRefreshing, resetCountdown, clearTimers, toast, t]);

  // Pairing code — "Telefon No ile Bağlan" tabisi. Fail-closed: hata gerçek
  // mesajla gösterilir, sahte kod/sahte başarı asla üretilmez (AGENTS.md).
  const handleGetPairingCode = useCallback(async () => {
    const digits = pairingPhone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      setPairingError(t('whatsapp.pairingInvalidPhone'));
      return;
    }
    const targetSessionId = activeSessionIdRef.current || sessionId;
    if (!targetSessionId) {
      // Oturum henüz hazırlanamadı — QR akışıyla aynı init tekrar denenir.
      await initSession();
      if (!activeSessionIdRef.current) return;
    }
    const sid = activeSessionIdRef.current || sessionId;
    if (!sid) return;

    setIsPairingLoading(true);
    setPairingError(null);
    setPairingCode(null);
    setPairingCopied(false);
    try {
      const res = await WhatsAppRepository.requestPairingCode(sid, pairingPhone.trim());
      if (!isMountedRef.current) return;
      setPairingCode(res.pairing_code);
    } catch (err: any) {
      if (!isMountedRef.current) return;
      setPairingError(err?.message || t('whatsapp.pairingCodeErrorTitle'));
    } finally {
      if (isMountedRef.current) setIsPairingLoading(false);
    }
  }, [pairingPhone, sessionId, initSession, t]);

  const handleCopyPairingCode = useCallback(async () => {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(pairingCode);
      setPairingCopied(true);
      toast.success(t('whatsapp.codeCopied'), t('common.success'));
      setTimeout(() => setPairingCopied(false), 2500);
    } catch {
      // Clipboard erişilemezse kullanıcı kodu elle seçip kopyalayabilir.
    }
  }, [pairingCode, toast, t]);

  // Mount & Modal Lifecycle effect - runs initSession EXACTLY ONCE per open cycle
  useEffect(() => {
    isMountedRef.current = true;
    if (isOpen) {
      if (!hasInitializedRef.current) {
        hasInitializedRef.current = true;
        initSession();
      }
    } else {
      // Reset initialization state on modal close
      hasInitializedRef.current = false;
      isInitializingRef.current = false;
      activeSessionIdRef.current = existingSessionId || null;
      clearTimers();
      setModalState('INITIALIZING');
      setQrCode(null);
      setConnectedPhone(null);
      setErrorMessage(null);
      setActiveTab('qr');
      setPairingPhone('');
      setPairingCode(null);
      setPairingError(null);
      setIsPairingLoading(false);
    }
    return () => {
      isMountedRef.current = false;
      clearTimers();
    };
  }, [isOpen, initSession, clearTimers, existingSessionId]);

  // Real-time WebSocket Event Listener
  useEffect(() => {
    if (!isOpen) return;

    const handleWsEvent = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (!detail) return;

      const targetMatches = 
        (sessionId && detail.session_id && String(detail.session_id) === String(sessionId)) ||
        (sessionName && detail.session_name && detail.session_name === sessionName);

      if (!targetMatches && detail.session_id) return;

      // 1. QR Code Updated
      if (detail.event === 'session_qr_updated' || detail.event_type === 'QR_UPDATED') {
        const newQr = detail.qr_code;
        if (newQr) {
          setQrCode(newQr);
          setModalState('QR_READY');
          resetCountdown();
        }
      }

      // 1b. Pairing code re-issued by the gateway after a socket restart.
      // The old 8-digit code dies with the expired QR; swap it for the fresh
      // one automatically so the user never enters a dead code
      // ("Cihaza bağlanamadı" fix — fail-closed: gateway error clears code).
      if (detail.event === 'session_pairing_code_updated') {
        if (detail.pairing_code) {
          setPairingCode(String(detail.pairing_code));
          setPairingError(null);
          setPairingCopied(false);
          setIsPairingLoading(false);
          toast.info(t('whatsapp.pairingCodeRefreshed'), t('common.info'));
        } else if (detail.error) {
          setPairingCode(null);
          setPairingError(String(detail.error));
          setIsPairingLoading(false);
        }
      }

      // 2. Session Connected
      if (detail.event === 'session_connected' || detail.event_type === 'CONNECTED') {
        const phone = detail.phone || detail.phone_number;
        setConnectedPhone(phone || null);
        setModalState('CONNECTED');
        setQrCode(null);
        clearTimers();
        toast.success(t('whatsapp.connectedState'), t('common.success'));
        if (onSuccessRef.current) {
          onSuccessRef.current({ 
            id: sessionId || detail.session_id, 
            phone_number: phone, 
            session_name: sessionName 
          } as any);
        }
      }

      // 3. Temporary Disconnect
      if (detail.event === 'session_disconnected' || detail.event_type === 'DISCONNECTED') {
        if (modalState !== 'CONNECTED' && modalState !== 'LOGGED_OUT') {
          setModalState('DISCONNECTED');
        }
      }

      // 4. Logged Out
      if (detail.event === 'session_logged_out' || detail.event_type === 'LOGGED_OUT') {
        setModalState('LOGGED_OUT');
        setQrCode(null);
        clearTimers();
      }

      // 5. Connection Error
      if (detail.event === 'connection_error' || detail.event_type === 'CONNECTION_ERROR') {
        setModalState('ERROR');
        setErrorMessage(detail.error || detail.error_message || t('whatsapp.connectionErrorDesc'));
      }
    };

    window.addEventListener('tezlify:ws_event', handleWsEvent);
    return () => {
      window.removeEventListener('tezlify:ws_event', handleWsEvent);
    };
  }, [isOpen, sessionId, sessionName, modalState, resetCountdown, clearTimers, t, toast]);

  // Gentle Fallback Polling (Every 4 seconds if in INITIALIZING without QR)
  useEffect(() => {
    if (!isOpen || !sessionId) return;

    if (modalState === 'INITIALIZING' && !qrCode) {
      fallbackPollRef.current = setInterval(async () => {
        try {
          const res = await WhatsAppRepository.getSessionQr(sessionId);
          if (!isMountedRef.current) return;
          if (res.status === 'CONNECTED') {
            setConnectedPhone(res.phone);
            setModalState('CONNECTED');
            if (fallbackPollRef.current) clearInterval(fallbackPollRef.current);
            if (onSuccessRef.current) onSuccessRef.current({ id: sessionId, phone_number: res.phone } as any);
          } else if (res.qr_code) {
            setQrCode(res.qr_code);
            setModalState('QR_READY');
            resetCountdown();
            if (fallbackPollRef.current) clearInterval(fallbackPollRef.current);
          } else if (res.error_message) {
            // Gateway failed permanently (e.g. WhatsApp terminated the
            // connection before issuing a QR) — surface the real reason.
            setErrorMessage(res.error_message);
            setModalState('ERROR');
            if (fallbackPollRef.current) clearInterval(fallbackPollRef.current);
          }
        } catch {
          // Silent catch in fallback poll
        }
      }, 4000);
    } else {
      if (fallbackPollRef.current) {
        clearInterval(fallbackPollRef.current);
        fallbackPollRef.current = null;
      }
    }

    return () => {
      if (fallbackPollRef.current) {
        clearInterval(fallbackPollRef.current);
        fallbackPollRef.current = null;
      }
    };
  }, [isOpen, sessionId, modalState, qrCode, resetCountdown]);

  // Keyboard accessibility: Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === 'undefined') return null;

  // Format QR source
  const qrImageSrc = qrCode
    ? (qrCode.startsWith('data:image') || qrCode.startsWith('http')
        ? qrCode
        : `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=4&data=${encodeURIComponent(qrCode)}`)
    : null;

  return createPortal(
    <div 
      className="fixed inset-0 z-[99999] bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in select-none"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
    >
      <div 
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#2F3349] p-6 text-center space-y-4 shadow-2xl border border-slate-200/80 dark:border-white/[0.1] animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-1 border-b border-slate-100 dark:border-white/[0.06]">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#28C76F]/15 text-[#28C76F] flex items-center justify-center font-bold">
              <QrCode className="w-4 h-4" />
            </div>
            <div className="text-left">
              <h3 id="qr-modal-title" className="text-sm font-extrabold text-slate-800 dark:text-white">
                {t('whatsapp.qrModalTitle')}
              </h3>
              {sessionName && (
                <span className="text-[10px] font-mono font-semibold text-slate-400">
                  {sessionName}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('whatsapp.closeModal') || 'Kapat'}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab switcher — QR Kod ile Tara | Telefon No ile Bağlan */}
        {modalState !== 'CONNECTED' && (
          <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-white/[0.06]" role="tablist" aria-label={t('whatsapp.qrModalTitle')}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'qr'}
              onClick={() => setActiveTab('qr')}
              className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                activeTab === 'qr'
                  ? 'bg-white dark:bg-[#2F3349] text-[#7367F0] shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              <QrCode className="w-3.5 h-3.5" />
              <span>{t('whatsapp.tabQrCode')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'pair'}
              onClick={() => setActiveTab('pair')}
              className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                activeTab === 'pair'
                  ? 'bg-white dark:bg-[#2F3349] text-[#28C76F] shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              <Phone className="w-3.5 h-3.5" />
              <span>{t('whatsapp.tabPairingCode')}</span>
            </button>
          </div>
        )}

        {/* State A: INITIALIZING */}
        {activeTab === 'qr' && modalState === 'INITIALIZING' && (
          <div className="py-12 flex flex-col items-center justify-center space-y-3">
            <Loader2 className="w-10 h-10 animate-spin text-[#7367F0]" />
            <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
              {t('whatsapp.qrPreparing')}
            </p>
            <p className="text-[11px] text-slate-400 max-w-[220px]">
              {t('whatsapp.connectingStateDesc')}
            </p>
          </div>
        )}

        {/* State B: QR_READY */}
        {activeTab === 'qr' && modalState === 'QR_READY' && (
          <div className="space-y-3.5 animate-fade-in">
            {/* 3-Step Instruction Box */}
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-left text-xs space-y-1.5">
              <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200 font-semibold">
                <span className="w-4 h-4 rounded-full bg-[#7367F0]/15 text-[#7367F0] text-[10px] flex items-center justify-center font-bold shrink-0">1</span>
                <span>{t('whatsapp.qrModalStep1')}</span>
              </div>
              <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200 font-semibold">
                <span className="w-4 h-4 rounded-full bg-[#7367F0]/15 text-[#7367F0] text-[10px] flex items-center justify-center font-bold shrink-0">2</span>
                <span>{t('whatsapp.qrModalStep2')}</span>
              </div>
              <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200 font-semibold">
                <span className="w-4 h-4 rounded-full bg-[#7367F0]/15 text-[#7367F0] text-[10px] flex items-center justify-center font-bold shrink-0">3</span>
                <span>{t('whatsapp.qrModalStep3')}</span>
              </div>
            </div>

            {/* QR Image Box with Countdown and Expire Overlay */}
            <div className="relative p-3 bg-white rounded-2xl mx-auto flex flex-col items-center justify-center shadow-md border border-slate-200/90 w-full max-w-[260px]">
              {/* Header Status & Countdown */}
              <div className="w-full flex items-center justify-between mb-1.5 px-1 text-[11px] font-semibold">
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200/60">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  {t('whatsapp.qrLiveBadge')}
                </span>
                <span className={`tabular-nums ${secondsLeft <= 5 ? 'text-rose-500 font-bold animate-pulse' : 'text-slate-400'}`}>
                  {secondsLeft} {t('whatsapp.qrSecLeft')}
                </span>
              </div>

              {/* QR Image */}
              <div className="relative w-52 h-52 flex items-center justify-center bg-white">
                {qrImageSrc ? (
                  <img
                    src={qrImageSrc}
                    alt="WhatsApp QR Code"
                    className="w-full h-full object-contain select-none"
                    style={{ imageRendering: 'pixelated' }}
                  />
                ) : (
                  <Loader2 className="w-8 h-8 animate-spin text-[#7367F0]" />
                )}

                {/* Expired Overlay when countdown reaches 0 */}
                {secondsLeft === 0 && (
                  <div 
                    onClick={handleRefreshQr}
                    className="absolute inset-0 bg-slate-900/85 backdrop-blur-[2px] rounded-lg flex flex-col items-center justify-center p-3 text-white text-center cursor-pointer transition-all hover:bg-slate-900/90 group"
                  >
                    <RefreshCw className="w-8 h-8 mb-2 text-emerald-400 group-hover:rotate-180 transition-transform duration-500" />
                    <span className="text-xs font-bold">{t('whatsapp.qrExpired')}</span>
                    <span className="text-[10px] text-slate-300 mt-1">{t('whatsapp.qrExpiredDesc')}</span>
                  </div>
                )}
              </div>

              {/* Manual Refresh Button */}
              <button
                type="button"
                onClick={handleRefreshQr}
                disabled={isRefreshing}
                aria-label={t('whatsapp.refreshQr')}
                className="mt-2 w-full py-1.5 px-3 rounded-lg text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-[#7367F0]' : ''}`} />
                <span>{isRefreshing ? t('whatsapp.refreshingQr') : t('whatsapp.refreshQr')}</span>
              </button>
            </div>
          </div>
        )}

        {/* Pairing tab: Telefon No ile Bağlan */}
        {activeTab === 'pair' && modalState !== 'CONNECTED' && (
          <div className="space-y-3.5 animate-fade-in text-left">
            {!pairingCode ? (
              <div className="space-y-3">
                <div>
                  <label htmlFor="pairing-phone-input" className="block text-[11px] font-bold text-slate-600 dark:text-slate-300 mb-1">
                    {t('whatsapp.pairingCodeInputLabel')}
                  </label>
                  <div className="relative">
                    <Phone className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      id="pairing-phone-input"
                      type="tel"
                      inputMode="tel"
                      value={pairingPhone}
                      onChange={(e) => { setPairingPhone(e.target.value); setPairingError(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !isPairingLoading) handleGetPairingCode(); }}
                      placeholder={t('whatsapp.pairingCodeInputPlaceholder')}
                      className="w-full pl-8 pr-3 py-2 rounded-xl border border-slate-200 dark:border-white/[0.12] bg-white dark:bg-[#25293C] text-sm font-semibold text-slate-800 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#28C76F]/40 focus:border-[#28C76F] transition-all"
                    />
                  </div>
                  {pairingError && (
                    <p className="mt-1.5 text-[11px] font-semibold text-[#EA5455]">{pairingError}</p>
                  )}
                </div>
                <Button
                  onClick={handleGetPairingCode}
                  disabled={isPairingLoading}
                  className="w-full font-bold bg-[#28C76F] hover:bg-[#24B263] text-white shadow-md shadow-[#28C76F]/30 cursor-pointer disabled:opacity-60"
                >
                  {isPairingLoading ? (
                    <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" />{t('whatsapp.gettingPairingCode')}</>
                  ) : (
                    <><KeyRound className="w-4 h-4 mr-1.5" />{t('whatsapp.getPairingCodeBtn')}</>
                  )}
                </Button>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  {t('whatsapp.pairingCodeValidNote')}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* 4-Step Instruction Box */}
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-xs space-y-1.5">
                  <h4 className="text-[11px] font-extrabold text-slate-700 dark:text-white mb-1">
                    {t('whatsapp.pairingCodeTitle')}
                  </h4>
                  {[1, 2, 3, 4].map((n) => (
                    <div key={n} className="flex items-center gap-2 text-slate-700 dark:text-slate-200 font-semibold">
                      <span className="w-4 h-4 rounded-full bg-[#28C76F]/15 text-[#28C76F] text-[10px] flex items-center justify-center font-bold shrink-0">{n}</span>
                      <span>{t(`whatsapp.pairingCodeStep${n}`)}</span>
                    </div>
                  ))}
                </div>

                {/* Big mono code + copy */}
                <div className="p-4 bg-white dark:bg-[#25293C] rounded-2xl mx-auto flex flex-col items-center shadow-md border border-slate-200/90 dark:border-white/[0.08]">
                  <div className="flex items-center gap-1.5">
                    {pairingCode.split('').map((ch, i) => (
                      <span
                        key={i}
                        className="w-8 h-10 flex items-center justify-center rounded-lg bg-slate-100 dark:bg-white/[0.06] border border-slate-200 dark:border-white/[0.1] font-mono text-lg font-extrabold text-slate-800 dark:text-white"
                      >
                        {ch}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 mt-3 w-full">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleCopyPairingCode}
                      className="flex-1 text-xs font-bold cursor-pointer"
                    >
                      {pairingCopied ? <CheckCircle2 className="w-3.5 h-3.5 mr-1 text-[#28C76F]" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
                      {pairingCopied ? t('whatsapp.codeCopied') : t('whatsapp.copyCodeBtn')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleGetPairingCode}
                      disabled={isPairingLoading}
                      className="text-xs font-bold cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 mr-1 ${isPairingLoading ? 'animate-spin' : ''}`} />
                      {t('whatsapp.pairingCodeAgainBtn')}
                    </Button>
                  </div>
                </div>
                <p className="text-center text-[11px] text-slate-400 animate-pulse">
                  {t('whatsapp.awaitingQrScan')}
                </p>
              </div>
            )}
          </div>
        )}

        {/* State C: CONNECTING */}
        {activeTab === 'qr' && modalState === 'CONNECTING' && (
          <div className="py-10 flex flex-col items-center justify-center space-y-3 animate-fade-in">
            <Loader2 className="w-10 h-10 animate-spin text-[#28C76F]" />
            <h4 className="text-sm font-extrabold text-slate-800 dark:text-white">
              {t('whatsapp.connectingState')}
            </h4>
            <p className="text-xs text-slate-400 max-w-[220px]">
              {t('whatsapp.connectingStateDesc')}
            </p>
          </div>
        )}

        {/* State D: CONNECTED */}
        {modalState === 'CONNECTED' && (
          <div className="py-6 flex flex-col items-center justify-center space-y-4 animate-scale-in">
            <div className="w-16 h-16 rounded-full bg-[#28C76F]/15 text-[#28C76F] flex items-center justify-center shadow-lg shadow-[#28C76F]/20">
              <CheckCircle2 className="w-10 h-10" />
            </div>
            <div>
              <h4 className="text-base font-extrabold text-slate-800 dark:text-white">
                {t('whatsapp.connectedState')}
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {t('whatsapp.connectedStateDesc')}
              </p>
              {connectedPhone && (
                <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-white/[0.06] border border-slate-200 dark:border-white/[0.1]">
                  <Smartphone className="w-4 h-4 text-[#28C76F]" />
                  <span className="font-mono text-sm font-extrabold text-slate-800 dark:text-white">
                    {connectedPhone}
                  </span>
                </div>
              )}
            </div>

            <Button
              onClick={onClose}
              className="w-full font-bold bg-[#28C76F] hover:bg-[#24B263] text-white shadow-md shadow-[#28C76F]/30 cursor-pointer"
            >
              {t('whatsapp.doneBtn')}
            </Button>
          </div>
        )}

        {/* State E: DISCONNECTED */}
        {modalState === 'DISCONNECTED' && (
          <div className="py-6 flex flex-col items-center justify-center space-y-4 animate-fade-in">
            <div className="w-12 h-12 rounded-full bg-[#FF9F43]/15 text-[#FF9F43] flex items-center justify-center">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div>
              <h4 className="text-sm font-extrabold text-slate-800 dark:text-white">
                {t('whatsapp.disconnected')}
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-[240px]">
                {t('whatsapp.disconnectedNotice')}
              </p>
            </div>
            <div className="flex items-center gap-2 w-full pt-2">
              <Button
                variant="outline"
                onClick={onClose}
                className="flex-1 text-xs font-bold cursor-pointer"
              >
                {t('whatsapp.closeModal')}
              </Button>
              <Button
                onClick={initSession}
                className="flex-1 text-xs font-bold bg-[#7367F0] hover:bg-[#685DD8] text-white cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                {t('whatsapp.retryConnection')}
              </Button>
            </div>
          </div>
        )}

        {/* State F: LOGGED_OUT */}
        {modalState === 'LOGGED_OUT' && (
          <div className="py-6 flex flex-col items-center justify-center space-y-4 animate-fade-in">
            <div className="w-12 h-12 rounded-full bg-[#EA5455]/15 text-[#EA5455] flex items-center justify-center">
              <X className="w-6 h-6" />
            </div>
            <div>
              <h4 className="text-sm font-extrabold text-slate-800 dark:text-white">
                {t('whatsapp.loggedOutNotice')}
              </h4>
              <p className="text-xs text-slate-400 mt-1">
                {t('whatsapp.connectWithQrDesc')}
              </p>
            </div>
            <Button
              onClick={initSession}
              className="w-full font-bold bg-[#7367F0] hover:bg-[#685DD8] text-white shadow-md shadow-[#7367F0]/30 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4 mr-1.5" />
              {t('whatsapp.loggedOutAction')}
            </Button>
          </div>
        )}

        {/* State G: ERROR */}
        {modalState === 'ERROR' && (
          <div className="py-6 flex flex-col items-center justify-center space-y-4 animate-fade-in">
            <div className="w-12 h-12 rounded-full bg-[#EA5455]/15 text-[#EA5455] flex items-center justify-center">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div>
              <h4 className="text-sm font-extrabold text-slate-800 dark:text-white">
                {t('whatsapp.connectionError')}
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-[240px]">
                {errorMessage || t('whatsapp.connectionErrorDesc')}
              </p>
            </div>
            <div className="flex items-center gap-2 w-full pt-2">
              <Button
                variant="outline"
                onClick={onClose}
                className="flex-1 text-xs font-bold cursor-pointer"
              >
                {t('whatsapp.closeModal')}
              </Button>
              <Button
                onClick={initSession}
                className="flex-1 text-xs font-bold bg-[#7367F0] hover:bg-[#685DD8] text-white cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                {t('whatsapp.retryConnection')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
