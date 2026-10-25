import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
  X, 
  Flame, 
  ShieldCheck, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  Sparkles,
  TrendingUp,
  Award
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { WhatsAppApi } from '../api/whatsappApi';
import { WhatsAppSession, WhatsAppWarmupStatus } from '../../../types';
import { Button, Badge } from '../../../components/ui';

export interface WarmupModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: WhatsAppSession | null;
  onWarmupUpdated?: (updatedSession: WhatsAppSession) => void;
}

const SCHEDULE_STEPS = [
  { day: 1, limit: 10, noteTr: 'Başlangıç & Hat Isınması', noteEn: 'Initial line warming' },
  { day: 2, limit: 20, noteTr: 'Kontrollü Artış', noteEn: 'Controlled ramp-up' },
  { day: 3, limit: 35, noteTr: 'Güven Hacmi Genişlemesi', noteEn: 'Trust volume expansion' },
  { day: 4, limit: 50, noteTr: 'Stabil Gönderim', noteEn: 'Stable outreach' },
  { day: 5, limit: 75, noteTr: 'Yüksek Hacme Hazırlık', noteEn: 'Pre-graduation ramp' },
  { day: 6, limit: 100, noteTr: 'Mezuniyet (Tam Kapasite)', noteEn: 'Graduated (Full speed)' },
];

const TARGET_LIMIT_OPTIONS = [50, 75, 100, 150, 200];

export const WarmupModal: React.FC<WarmupModalProps> = ({
  isOpen,
  onClose,
  session,
  onWarmupUpdated,
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isEnabled, setIsEnabled] = useState<boolean>(false);
  const [targetLimit, setTargetLimit] = useState<number>(100);
  const [statusData, setStatusData] = useState<WhatsAppWarmupStatus | null>(null);

  // Load status on open
  useEffect(() => {
    if (!isOpen || !session) return;

    let isMounted = true;
    setIsLoading(true);

    WhatsAppApi.getWarmupStatus(session.id)
      .then((data) => {
        if (!isMounted) return;
        setStatusData(data);
        setIsEnabled(data.is_warmup_enabled);
        setTargetLimit(data.target_limit || 100);
      })
      .catch((err) => {
        if (!isMounted) return;
        // Fallback to session props if available
        setIsEnabled(session.is_warmup_enabled ?? false);
        setTargetLimit(session.warmup_target_limit ?? 100);
        console.warn('[WarmupModal] Failed to fetch warmup status:', err);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, session]);

  // Handle ESC key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSaving, onClose]);

  if (!isOpen || !session || typeof document === 'undefined') return null;

  const currentDay = statusData?.current_day ?? session.warmup_current_day ?? 1;
  const dailyLimit = statusData?.daily_limit ?? session.warmup_daily_limit ?? 10;
  const sentToday = statusData?.sent_today ?? session.daily_sent_count ?? 0;
  const remainingToday = statusData?.remaining_today ?? Math.max(0, dailyLimit - sentToday);
  const isGraduated = statusData?.graduated_at != null || (session.warmup_graduated_at != null);

  const usagePercent = dailyLimit > 0 ? Math.min(100, Math.round((sentToday / dailyLimit) * 100)) : 0;

  const handleSave = async () => {
    if (!session) return;
    setIsSaving(true);
    try {
      const res = await WhatsAppApi.toggleWarmup(session.id, isEnabled, targetLimit);
      toast.success(t('whatsapp.warmupSavedSuccess'));
      if (onWarmupUpdated) {
        onWarmupUpdated({
          ...session,
          is_warmup_enabled: res.is_warmup_enabled,
          warmup_current_day: res.current_day,
          warmup_daily_limit: res.daily_limit,
          warmup_target_limit: res.target_limit,
          warmup_graduated_at: res.graduated_at,
          warm_up_day: res.current_day,
          daily_sent_count: res.sent_today,
          max_daily_limit: res.daily_limit,
        });
      }
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.errorOccurred');
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-150"
      data-testid="warmup-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving) {
          onClose();
        }
      }}
    >
      <div
        className="relative w-full max-w-xl bg-white dark:bg-[#25293C] rounded-2xl shadow-2xl border border-slate-200/80 dark:border-white/[0.08] overflow-hidden transform animate-in zoom-in-95 duration-150 p-6 space-y-5"
        data-testid="warmup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="warmup-title"
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#FF9F43]/15 text-[#FF9F43] flex items-center justify-center font-bold shrink-0">
              <Flame className="w-5 h-5 text-[#FF9F43]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3
                  id="warmup-title"
                  className="text-base font-extrabold text-slate-900 dark:text-white leading-snug"
                >
                  {t('whatsapp.warmupModalTitle')}
                </h3>
                {isGraduated ? (
                  <Badge variant="success" className="text-[10px] uppercase font-mono font-bold flex items-center gap-1">
                    <Award className="w-3 h-3" />
                    {t('whatsapp.warmupGraduated')}
                  </Badge>
                ) : isEnabled ? (
                  <Badge variant="warning" className="text-[10px] uppercase font-mono font-bold flex items-center gap-1">
                    <Sparkles className="w-3 h-3" />
                    {t('whatsapp.warmupActive')}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] uppercase font-mono font-bold">
                    {t('whatsapp.warmupDisabled')}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-[#7E7F96] mt-0.5">
                {session.session_name} {session.phone_number ? `(${session.phone_number})` : ''} • {t('whatsapp.warmupModalSubtitle')}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="p-1 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-50 -mr-1 -mt-1"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toggle Switch */}
        <div className="flex items-center justify-between p-4 rounded-xl bg-slate-50 dark:bg-[#2F3349] border border-slate-200/70 dark:border-white/[0.05]">
          <div className="space-y-0.5 pr-4">
            <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-[#7367F0]" />
              {t('whatsapp.warmupToggleLabel')}
            </span>
            <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] leading-relaxed">
              {t('whatsapp.warmupToggleDesc')}
            </p>
          </div>

          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={(e) => setIsEnabled(e.target.checked)}
              disabled={isLoading || isSaving}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#7367F0]" />
          </label>
        </div>

        {/* Target Daily Limit Selector */}
        <div className="space-y-2">
          <label className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center justify-between">
            <span>{t('whatsapp.warmupTargetLimitLabel')}</span>
            <span className="font-mono text-[#7367F0] font-extrabold">{targetLimit} {t('whatsapp.dailyUsage').toLowerCase()}</span>
          </label>
          <div className="grid grid-cols-5 gap-2">
            {TARGET_LIMIT_OPTIONS.map((limit) => (
              <button
                key={limit}
                type="button"
                onClick={() => setTargetLimit(limit)}
                disabled={isLoading || isSaving}
                className={`py-2 px-1 text-center rounded-lg font-mono text-xs font-bold transition-all cursor-pointer border ${
                  targetLimit === limit
                    ? 'bg-[#7367F0] text-white border-[#7367F0] shadow-sm shadow-[#7367F0]/30'
                    : 'bg-slate-50 dark:bg-[#2F3349] text-slate-700 dark:text-slate-300 border-slate-200/60 dark:border-white/[0.05] hover:border-[#7367F0]/50'
                }`}
              >
                {limit}
              </button>
            ))}
          </div>
        </div>

        {/* Live Metrics Card */}
        {isEnabled && (
          <div className="p-4 rounded-xl bg-gradient-to-br from-amber-500/10 to-orange-500/5 dark:from-amber-500/15 dark:to-orange-500/10 border border-amber-500/20 space-y-3">
            <div className="flex items-center justify-between text-xs font-bold">
              <span className="text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                <Flame className="w-4 h-4 text-[#FF9F43]" />
                {t('whatsapp.warmupCurrentDay')}: #{currentDay} / 6
              </span>
              <span className="font-mono text-slate-700 dark:text-slate-200">
                {sentToday} / {dailyLimit} {t('whatsapp.dailyUsage').toLowerCase()}
              </span>
            </div>

            {/* Quota bar */}
            <div className="h-2 w-full bg-slate-200/80 dark:bg-slate-700/80 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#FF9F43] to-[#28C76F] rounded-full transition-all duration-300"
                style={{ width: `${usagePercent}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-[#7E7F96]">
              <span>{t('whatsapp.warmupRemainingToday')}: <strong className="font-mono text-slate-800 dark:text-slate-200 font-bold">{remainingToday}</strong></span>
              <span>{t('whatsapp.warmupTodayLimit')}: <strong className="font-mono text-slate-800 dark:text-slate-200 font-bold">{dailyLimit}</strong></span>
            </div>
          </div>
        )}

        {/* 6-Day Schedule Timeline */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-300">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-[#7367F0]" />
              {t('whatsapp.warmupScheduleTitle')}
            </span>
            <span className="text-[10px] text-slate-400 font-mono font-medium">10 → 20 → 35 → 50 → 75 → 100+</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {SCHEDULE_STEPS.map((step) => {
              const isCurrent = isEnabled && currentDay === step.day;
              const isPast = isEnabled && currentDay > step.day;

              return (
                <div
                  key={step.day}
                  className={`p-2.5 rounded-xl border transition-all text-xs ${
                    isCurrent
                      ? 'bg-[#FF9F43]/15 border-[#FF9F43] shadow-sm shadow-[#FF9F43]/20 ring-1 ring-[#FF9F43]/50'
                      : isPast
                      ? 'bg-emerald-500/10 border-emerald-500/20 text-slate-700 dark:text-slate-300'
                      : 'bg-slate-50 dark:bg-[#2F3349] border-slate-200/60 dark:border-white/[0.05] text-slate-500 dark:text-slate-400 opacity-80'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-extrabold text-[11px] flex items-center gap-1">
                      {isPast ? (
                        <CheckCircle2 className="w-3 h-3 text-[#28C76F]" />
                      ) : isCurrent ? (
                        <Flame className="w-3 h-3 text-[#FF9F43]" />
                      ) : null}
                      {t('whatsapp.warmupDayItem', { day: step.day.toString() })}
                    </span>
                    <span className="font-mono font-extrabold text-[#7367F0] text-[11px]">
                      {step.limit}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-400 dark:text-[#7E7F96] truncate">
                    {step.day === 6 ? t('whatsapp.warmupDayGraduatedDesc') : t('whatsapp.warmupDayItemLimit', { limit: step.limit.toString() })}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Safety Education Alert */}
        <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200/70 dark:border-blue-900/40 flex items-start gap-2.5 text-xs text-blue-900 dark:text-blue-200">
          <ShieldCheck className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
          <p className="text-[11px] leading-relaxed">
            {t('whatsapp.warmupSafePauseNotice')}
          </p>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100 dark:border-white/[0.06]">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={isSaving}
          >
            {t('common.cancel')}
          </Button>

          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={isLoading || isSaving}
            className="shadow-md shadow-[#7367F0]/30"
          >
            {t('whatsapp.warmupSaveBtn')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
};
