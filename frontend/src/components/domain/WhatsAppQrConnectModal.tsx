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
  RotateCcw
} from 'lucide-react';
import { ApiClient } from '../../api/client';
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

  const timerRef = useRef<any>(null);
  const fallbackPollRef = useRef<any>(null);
  const isMountedRef = useRef<boolean>(true);

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

  // Initialize or connect session
  const initSession = useCallback(async () => {
    setModalState('INITIALIZING');
    setErrorMessage(null);
    setQrCode(null);
    setConnectedPhone(null);
    clearTimers();

    try {
      if (existingSessionId) {
        // Reusing existing session
        setSessionId(existingSessionId);
        const qrRes = await ApiClient.getSessionQr(existingSessionId);
        if (!isMountedRef.current) return;

        if (qrRes.status === 'CONNECTED') {
          setConnectedPhone(qrRes.phone);
          setModalState('CONNECTED');
          if (onSuccess) onSuccess({ id: existingSessionId, phone_number: qrRes.phone } as any);
          return;
        }

        if (qrRes.qr_code) {
          setQrCode(qrRes.qr_code);
          setModalState('QR_READY');
          resetCountdown();
        } else {
          // Trigger refresh to get active QR
          const refreshRes = await ApiClient.refreshSessionQr(existingSessionId);
          if (!isMountedRef.current) return;
          if (refreshRes.qr_code) {
            setQrCode(refreshRes.qr_code);
            setModalState('QR_READY');
            resetCountdown();
          }
        }
      } else {
        // Create new Baileys session
        const nameToUse = initialSessionName?.trim() || `Hat ${Math.floor(1000 + Math.random() * 9000)}`;
        setSessionName(nameToUse);

        const newSession = await ApiClient.createWhatsAppSession(nameToUse, 50);
        if (!isMountedRef.current) return;

        setSessionId(newSession.id);
        setSessionName(newSession.session_name);

        if (newSession.status === 'CONNECTED') {
          setConnectedPhone(newSession.phone_number || null);
          setModalState('CONNECTED');
          if (onSuccess) onSuccess(newSession);
          return;
        }

        if (newSession.qr_code) {
          setQrCode(newSession.qr_code);
          setModalState('QR_READY');
          resetCountdown();
        } else {
          // Gateway is still generating QR, will receive via WebSocket or fallback poll
          setModalState('INITIALIZING');
        }
      }
    } catch (err: any) {
      if (!isMountedRef.current) return;
      setModalState('ERROR');
      setErrorMessage(err?.message || t('whatsapp.connectionErrorDesc') || 'Bağlantı başlatılamadı.');
    }
  }, [existingSessionId, initialSessionName, clearTimers, resetCountdown, onSuccess, t]);

  // Manual QR Refresh
  const handleRefreshQr = useCallback(async () => {
    if (!sessionId || isRefreshing) return;
    setIsRefreshing(true);
    try {
      const res = await ApiClient.refreshSessionQr(sessionId);
      if (!isMountedRef.current) return;

      if (res.status === 'CONNECTED') {
        setModalState('CONNECTED');
        toast.success(t('whatsapp.connectedState'), t('common.success'));
        if (onSuccess) onSuccess({ id: sessionId } as any);
        return;
      }

      if (res.qr_code) {
        setQrCode(res.qr_code);
        setModalState('QR_READY');
        resetCountdown();
      }
    } catch (err: any) {
      toast.error(err?.message || t('whatsapp.refreshingQr') || 'QR kod yenilenemedi', t('common.error'));
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [sessionId, isRefreshing, resetCountdown, toast, t, onSuccess]);

  // Mount effect
  useEffect(() => {
    isMountedRef.current = true;
    if (isOpen) {
      initSession();
    }
    return () => {
      isMountedRef.current = false;
      clearTimers();
    };
  }, [isOpen, initSession, clearTimers]);

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

      // 2. Session Connected
      if (detail.event === 'session_connected' || detail.event_type === 'CONNECTED') {
        const phone = detail.phone || detail.phone_number;
        setConnectedPhone(phone || null);
        setModalState('CONNECTED');
        setQrCode(null);
        clearTimers();
        toast.success(t('whatsapp.connectedState'), t('common.success'));
        if (onSuccess) {
          onSuccess({ 
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
  }, [isOpen, sessionId, sessionName, modalState, resetCountdown, clearTimers, onSuccess, t, toast]);

  // Gentle Fallback Polling (Every 4 seconds if in INITIALIZING without QR)
  useEffect(() => {
    if (!isOpen || !sessionId) return;

    if (modalState === 'INITIALIZING' && !qrCode) {
      fallbackPollRef.current = setInterval(async () => {
        try {
          const res = await ApiClient.getSessionQr(sessionId);
          if (!isMountedRef.current) return;
          if (res.status === 'CONNECTED') {
            setConnectedPhone(res.phone);
            setModalState('CONNECTED');
            if (fallbackPollRef.current) clearInterval(fallbackPollRef.current);
            if (onSuccess) onSuccess({ id: sessionId, phone_number: res.phone } as any);
          } else if (res.qr_code) {
            setQrCode(res.qr_code);
            setModalState('QR_READY');
            resetCountdown();
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
  }, [isOpen, sessionId, modalState, qrCode, resetCountdown, onSuccess]);

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

        {/* State A: INITIALIZING */}
        {modalState === 'INITIALIZING' && (
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
        {modalState === 'QR_READY' && (
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

        {/* State C: CONNECTING */}
        {modalState === 'CONNECTING' && (
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
