import React from 'react';
import { AlertTriangle, Lock, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { useI18n } from '../../../context/I18nContext';
import { SessionSyncState, WhatsAppLoadingGate } from '../../../types';
import { resolveSyncDisplayCounts } from '../lib/whatsappSync';
import { WhatsAppIcon } from '../../../components/ui/whatsapp-icon';

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
 *
 * Faz 3: `loadingGate` prop'u tek-authority WhatsAppLoadingGate durumunu tasir
 * (bagli degilse eski `sync` davranisi korunur — geriye donuk uyumlu). Profil
 * fotograflari asamasi (`loading_profiles`) avatar sayaclariyla gosterilir.
 */
export interface WhatsAppSyncGateProps {
  /** Gercek senkron durumu (backend job'i ve/veya gateway history sync). */
  sync: SessionSyncState | null;
  /** Faz 3: tek-authority loading gate durumu (avatars dahil). */
  loadingGate?: WhatsAppLoadingGate | null;
  /** Kacis cikisi gorunsun mu (hata ya da uzun suren senkron). */
  showEscape?: boolean;
  onContinueAnyway?: () => void;
  /** Yalnizca hata durumunda gosterilir. */
  onRetry?: () => void;
}

export const WhatsAppSyncGate: React.FC<WhatsAppSyncGateProps> = ({
  sync,
  loadingGate,
  showEscape = false,
  onContinueAnyway,
  onRetry,
}) => {
  const { t } = useI18n();

  const isError = sync?.phase === 'error' || loadingGate?.phase === 'error';
  const progress = Math.max(
    0,
    Math.min(100, Math.round(loadingGate?.progress ?? sync?.progress ?? 0)),
  );
  const counts = resolveSyncDisplayCounts(sync);
  const avatarCounts = loadingGate?.counts;
  const isProfileStage = loadingGate?.phase === 'loading_profiles';

  // F-9: dinamik asama anahtari cozulmezse ham anahtar yolu gosterilmez.
  const stageKey = isProfileStage
    ? 'whatsapp.syncStage.loading_profiles'
    : `whatsapp.syncStage.${sync?.stage || 'starting'}`;
  const stageLabel = t(stageKey);
  const resolvedStage = stageLabel === stageKey ? t('whatsapp.syncingChats') : stageLabel;

  return (
    <div
      className="flex-1 w-full h-full min-h-[460px] flex flex-col items-center justify-center px-6 py-12 text-center select-none bg-[#111b21] text-[#e9edef]"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-[340px] flex flex-col items-center">
        {/* WhatsApp Logo Icon — WhatsApp Web tam eslesmesi */}
        <div className="text-[#8696a0] mb-8">
          <WhatsAppIcon className="w-16 h-16 opacity-80" />
        </div>

        {/* WhatsApp Web Tarzi Ince Ilerleme Cubugu */}
        <div className="w-full h-[3px] rounded-full bg-[#202c33] overflow-hidden mb-6">
          <div
            className="h-full rounded-full bg-[#00a884] transition-all duration-500 ease-out"
            style={{ width: `${Math.max(5, progress)}%` }}
          />
        </div>

        {/* Baslik ve Sifreleme Ibaresi */}
        <h2 className="text-xl font-bold tracking-tight text-[#e9edef]">
          {t('whatsapp.syncGateTitle')}
        </h2>

        <div className="mt-2 flex items-center justify-center space-x-1.5 text-xs text-[#8696a0]">
          <Lock className="w-3.5 h-3.5" />
          <span>{t('whatsapp.syncGateEncryption')}</span>
        </div>

        {/* Canli Asama ve Yuzde Durumu */}
        {!isError && (
          <div className="mt-6 flex flex-col items-center space-y-1 text-xs text-[#8696a0]">
            <div className="flex items-center space-x-2 font-medium">
              <span className="text-emerald-400 font-semibold">{resolvedStage}</span>
              <span className="text-[#8696a0]">·</span>
              <span className="font-mono text-emerald-400 font-bold">{progress}%</span>
            </div>

            <p className="text-[11px] text-[#667781] mt-1">
              {isProfileStage && avatarCounts
                ? t('whatsapp.syncingAvatarsCount', { count: avatarCounts.avatars_missing })
                : `${t('whatsapp.syncingContactsCount', { count: counts.contacts })} · ${t(
                    'whatsapp.syncingChatsCount',
                    { count: counts.chats },
                  )} · ${t('whatsapp.syncingMessagesCount', { count: counts.messages })}`}
            </p>
          </div>
        )}

        {isError && (
          <div className="mt-6 w-full">
            <div className="flex items-start space-x-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-left">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" strokeWidth={2.2} />
              <div className="min-w-0">
                <p className="text-xs font-bold text-rose-400">
                  {t('whatsapp.syncFailedTitle')}
                </p>
                {sync?.error && (
                  <p className="mt-1 text-[11px] text-rose-300/80 break-words">
                    {sync.error}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-4 flex items-center justify-center space-x-3">
              {onRetry && (
                <Button size="sm" onClick={onRetry} className="bg-[#00a884] hover:bg-[#00a884]/80 text-white font-bold text-xs">
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                  {t('whatsapp.syncRetry')}
                </Button>
              )}
              {onContinueAnyway && (
                <Button size="sm" variant="ghost" onClick={onContinueAnyway} className="text-[#8696a0] hover:text-[#e9edef] text-xs">
                  {t('whatsapp.syncGateContinueAnyway')}
                </Button>
              )}
            </div>
          </div>
        )}

        {showEscape && onContinueAnyway && !isError && (
          <button
            type="button"
            onClick={onContinueAnyway}
            className="mt-8 text-xs font-semibold text-[#8696a0] underline underline-offset-2 hover:text-[#e9edef] transition-colors cursor-pointer"
          >
            {t('whatsapp.syncGateContinueAnyway')}
          </button>
        )}
      </div>
    </div>
  );
};

export default WhatsAppSyncGate;
