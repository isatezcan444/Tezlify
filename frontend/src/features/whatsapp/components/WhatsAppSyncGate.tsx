import React from 'react';
import { AlertTriangle, Loader2, MessageCircle } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { useI18n } from '../../../context/I18nContext';
import { SessionSyncState } from '../../../types';
import { resolveSyncDisplayCounts } from '../lib/whatsappSync';

/**
 * WhatsApp Web paritesi — QR sonrasi "senkron kapisi".
 *
 * WhatsApp Web, telefon eslestirildikten sonra sohbet listesini HEMEN acmaz:
 * tum sohbetler ve kisiler inene kadar tam ekran bir senkron ekrani gosterir.
 * Ayni davranis burada uygulanir — kapi acilmadan canli sohbetler render
 * EDILMEZ, boylece bir sohbete tiklamak "o an indirme" (on-demand provider
 * cagrisi) yuzunden gecikme uretemez.
 *
 * Kurallar:
 * - Ilerleme YALNIZCA gercek job/gateway sayaclarindan gelir; sahte timer,
 *   sahte yuzde, yapay bekleme YOK (AGENTS.md §1.1 truthfulness).
 * - Kullanici asla kapida kilitli kalmaz: hata halinde ve uzun suren senkron
 *   sonrasi "yine de devam et" cikisi sunulur (ust bilesen `showEscape` ile
 *   kontrol eder).
 */
export interface WhatsAppSyncGateProps {
  /** Gercek senkron durumu (backend job'i ve/veya gateway history sync). */
  sync: SessionSyncState | null;
  /** Kacis cikisi gorunsun mu (hata ya da uzun suren senkron). */
  showEscape?: boolean;
  onContinueAnyway?: () => void;
  /** Yalnizca hata durumunda gosterilir. */
  onRetry?: () => void;
}

export const WhatsAppSyncGate: React.FC<WhatsAppSyncGateProps> = ({
  sync,
  showEscape = false,
  onContinueAnyway,
  onRetry,
}) => {
  const { t } = useI18n();

  const isError = sync?.phase === 'error';
  const progress = Math.max(0, Math.min(100, Math.round(sync?.progress || 0)));
  const counts = resolveSyncDisplayCounts(sync);

  // F-9: dinamik asama anahtari cozulmezse ham anahtar yolu gosterilmez.
  const stageKey = `whatsapp.syncStage.${sync?.stage || 'starting'}`;
  const stageLabel = t(stageKey);
  const resolvedStage = stageLabel === stageKey ? t('whatsapp.syncingChats') : stageLabel;

  return (
    <div
      className="flex-1 h-full flex flex-col items-center justify-center px-6 py-10 text-center select-none"
      role="status"
      aria-live="polite"
    >
      {/* Marka isareti — WhatsApp Web'in eslesme sonrasi ekrani gibi sade. */}
      <div className="w-16 h-16 rounded-full flex items-center justify-center bg-[#7367F0]/10 dark:bg-[#7367F0]/15">
        <MessageCircle className="w-8 h-8 text-[#7367F0] dark:text-[#a29bfe]" strokeWidth={1.75} />
      </div>

      <h2 className="mt-5 text-xl sm:text-2xl font-extrabold tracking-tight text-slate-800 dark:text-white">
        {t('whatsapp.syncGateTitle')}
      </h2>
      <p className="mt-1.5 text-xs text-slate-400 dark:text-[#7E7F96] font-medium">
        {t('whatsapp.syncGateEncryption')}
      </p>

      {/* Ayirici — gorsel olarak WhatsApp Web ekranindaki cizgi. */}
      <div className="mt-6 w-full max-w-xs h-px bg-slate-200/80 dark:bg-white/[0.08]" />

      {isError ? (
        <div className="mt-6 w-full max-w-xs">
          <div className="flex items-start space-x-2 rounded-xl border border-[#EA5455]/30 bg-[#EA5455]/5 px-3 py-2.5 text-left">
            <AlertTriangle className="w-4 h-4 text-[#EA5455] shrink-0 mt-0.5" strokeWidth={2.2} />
            <div className="min-w-0">
              <p className="text-[11px] font-bold text-[#EA5455]">
                {t('whatsapp.syncFailedTitle')}
              </p>
              {/* Hata metni MASKELENMEZ; varsa gercek mesaj gosterilir. */}
              {sync?.error && (
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400 break-words">
                  {sync.error}
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-center space-x-2">
            {onRetry && (
              <Button size="sm" onClick={onRetry}>
                {t('whatsapp.syncRetry')}
              </Button>
            )}
            {onContinueAnyway && (
              <Button size="sm" variant="ghost" onClick={onContinueAnyway}>
                {t('whatsapp.syncGateContinueAnyway')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-6 w-full max-w-xs">
          <div className="flex items-center justify-center space-x-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#7367F0] shrink-0" />
            <span className="text-[11px] font-bold text-[#7367F0] dark:text-[#a29bfe]">
              {resolvedStage}
            </span>
            <span className="text-[10px] font-extrabold text-[#7367F0]">{progress}%</span>
          </div>

          <div className="mt-2 h-1.5 rounded-full bg-[#7367F0]/15 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#7367F0] to-[#a29bfe] transition-all duration-700"
              style={{ width: `${Math.max(4, progress)}%` }}
            />
          </div>

          {/* G-6: `*_synced` kumulatif sayaclardir; gercek tekil varlik
              sayilari tercih edilir (bkz. resolveSyncDisplayCounts). */}
          <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
            {`${t('whatsapp.syncingContactsCount', { count: counts.contacts })} · ${t(
              'whatsapp.syncingChatsCount',
              { count: counts.chats },
            )} · ${t('whatsapp.syncingMessagesCount', { count: counts.messages })}`}
          </p>

          <p className="mt-3 text-[10px] text-slate-400 dark:text-[#7E7F96] leading-relaxed">
            {t('whatsapp.syncGateDescription')}
          </p>

          {showEscape && onContinueAnyway && (
            <button
              type="button"
              onClick={onContinueAnyway}
              className="mt-4 text-[10px] font-bold text-slate-500 dark:text-slate-400 underline underline-offset-2 hover:text-slate-800 dark:hover:text-white transition-colors cursor-pointer"
            >
              {t('whatsapp.syncGateContinueAnyway')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default WhatsAppSyncGate;
