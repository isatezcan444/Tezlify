import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  CreditCard,
  Zap,
  CheckCircle2,
  AlertCircle,
  Calendar,
  Sparkles,
  Users,
  MessageSquare,
  ShieldCheck,
  RefreshCw,
  ChevronRight,
  X,
  Clock,
  ArrowUpRight,
  Check,
  Layers,
  Flame,
  FileSpreadsheet
} from 'lucide-react';
import { Card, Button, Badge } from '../../../components/ui';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { ApiClient as Api } from '../../../api/client';
import { QuotaUsageSummary, PlanListResponse, PlanInfo } from '../../../types';

export const PlanUsageSection: React.FC = () => {
  const { t, language } = useI18n();
  const toast = useToast();

  const [usage, setUsage] = useState<QuotaUsageSummary | null>(null);
  const [plansData, setPlansData] = useState<PlanListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPlansModal, setShowPlansModal] = useState(false);
  const [switchingTier, setSwitchingTier] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const [u, p] = await Promise.all([
        Api.getBillingUsage(),
        Api.getBillingPlans(),
      ]);
      setUsage(u);
      setPlansData(p);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error loading billing data';
      toast.error(t('toast.errorTitle'), msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showPlansModal) {
        setShowPlansModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showPlansModal]);

  const handleChangePlan = async (tier: string) => {
    try {
      setSwitchingTier(tier);
      const updated = await Api.changeBillingPlan(tier);
      setUsage(updated);
      const p = await Api.getBillingPlans();
      setPlansData(p);
      setShowPlansModal(false);
      toast.success(t('billing.currentPlan'), t('billing.planChangedSuccess'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Plan change failed';
      toast.error(t('toast.errorTitle'), msg);
    } finally {
      setSwitchingTier(null);
    }
  };

  if (loading && !usage) {
    return (
      <Card className="w-full p-12 text-center text-slate-400 dark:text-slate-500 animate-pulse">
        <RefreshCw className="w-8 h-8 mx-auto mb-3 animate-spin text-[#7367F0]" />
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          {t('billing.planQuotaLoading')}
        </p>
      </Card>
    );
  }

  if (!usage) {
    return (
      <Card className="w-full p-8 text-center text-slate-500">
        <AlertCircle className="w-8 h-8 mx-auto mb-2 text-[#FF9F43]" />
        <p className="text-sm font-bold text-slate-700 dark:text-slate-300">
          {t('billing.planQuotaNotFound')}
        </p>
        <Button onClick={loadData} variant="outline" className="mt-4">
          {t('billing.retryBtn')}
        </Button>
      </Card>
    );
  }

  return (
    <div className="w-full space-y-6 animate-fade-in select-none">
      {/* Top Hero Banner: Luxury Plan Overview */}
      <div className="relative rounded-3xl p-6 sm:p-8 bg-gradient-to-r from-[#7367F0]/15 via-indigo-600/10 to-[#00CFE8]/10 border border-[#7367F0]/25 shadow-xl overflow-hidden">
        {/* Ambient Top Glow */}
        <div className="absolute top-0 right-0 w-80 h-80 bg-[#7367F0]/20 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-start sm:items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-[#7367F0] text-white flex items-center justify-center shadow-lg shadow-[#7367F0]/40 shrink-0">
              <CreditCard className="w-7 h-7" />
            </div>

            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
                  {usage.plan_name}
                </h3>
                <span className="px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider bg-[#7367F0] text-white shadow-sm">
                  {usage.plan_tier}
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#28C76F]/15 text-[#28C76F] border border-[#28C76F]/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#28C76F] animate-pulse" />
                  {t('billing.activeSubscriptionBadge')}
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 mt-1 max-w-xl">
                {t('billing.subtitle')}
              </p>
            </div>
          </div>

          {/* Renewal Counter & Action */}
          <div className="flex items-center gap-4 flex-wrap sm:flex-nowrap justify-between lg:justify-end">
            <div className="p-3.5 rounded-2xl bg-white/80 dark:bg-[#25293C]/80 border border-slate-200/80 dark:border-white/[0.08] backdrop-blur">
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-[#FF9F43]" />
                {t('billing.renewalDate')}
              </div>
              <div className="text-sm font-extrabold text-slate-800 dark:text-white mt-0.5 flex items-center gap-2">
                <span>{new Date(usage.period_end).toLocaleDateString(language === 'tr' ? 'tr-TR' : 'en-US')}</span>
                <span className="text-xs font-bold text-[#7367F0]">
                  ({t('billing.daysLeft', { days: String(usage.days_until_renewal) })})
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowPlansModal(true)}
              className="px-5 py-3 rounded-2xl bg-[#7367F0] hover:bg-[#685DD8] text-white font-bold text-xs sm:text-sm shadow-lg shadow-[#7367F0]/30 hover:shadow-xl transition-all flex items-center gap-2 cursor-pointer active:scale-95"
            >
              <Sparkles className="w-4 h-4 text-amber-300" />
              <span>{t('billing.upgradePlan')}</span>
              <ArrowUpRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Quota Progress Cards Grid: 4 Balanced Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {/* Metric 1: Monthly Lead Scraper Quota */}
        <div className="landing-glass-card rounded-3xl p-6 flex flex-col justify-between border border-slate-200/80 dark:border-white/[0.08] relative overflow-hidden group">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="p-2.5 rounded-2xl bg-[#7367F0]/10 text-[#7367F0] flex items-center gap-2">
                <Users className="w-5 h-5" />
                <span className="text-xs font-bold uppercase tracking-wider">
                  {t('billing.leadQuotaShort')}
                </span>
              </div>
              <span className="text-sm font-black font-mono text-[#7367F0] px-2.5 py-0.5 rounded-full bg-[#7367F0]/10">
                %{usage.leads.percentage}
              </span>
            </div>

            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
              {t('billing.leadQuota')}
            </div>

            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                {usage.leads.used.toLocaleString()}
              </span>
              <span className="text-xs sm:text-sm font-semibold text-slate-400">
                / {usage.leads.limit >= 900000 ? t('billing.unlimited') : usage.leads.limit.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="mt-6 space-y-2">
            <div className="w-full bg-slate-200 dark:bg-white/10 rounded-full h-2.5 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 bg-gradient-to-r ${
                  usage.leads.percentage > 85
                    ? 'from-[#EA5455] to-rose-600'
                    : usage.leads.percentage > 60
                    ? 'from-[#FF9F43] to-amber-500'
                    : 'from-[#7367F0] to-[#00CFE8]'
                }`}
                style={{ width: `${Math.min(100, Math.max(2, usage.leads.percentage))}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs font-bold">
              <span className="text-slate-400">{t('billing.resetMonthly')}</span>
              <span className="text-[#28C76F]">
                {t('billing.remaining', {
                  count: usage.leads.remaining >= 900000 ? t('billing.unlimited') : usage.leads.remaining.toLocaleString(),
                })}
              </span>
            </div>
          </div>
        </div>

        {/* Metric 2: Daily WhatsApp Message Quota */}
        <div className="landing-glass-card rounded-3xl p-6 flex flex-col justify-between border border-slate-200/80 dark:border-white/[0.08] relative overflow-hidden group">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="p-2.5 rounded-2xl bg-[#28C76F]/10 text-[#28C76F] flex items-center gap-2">
                <MessageSquare className="w-5 h-5" />
                <span className="text-xs font-bold uppercase tracking-wider">
                  {t('billing.waDailyShort')}
                </span>
              </div>
              <span className="text-sm font-black font-mono text-[#28C76F] px-2.5 py-0.5 rounded-full bg-[#28C76F]/10">
                %{usage.whatsapp_daily.percentage}
              </span>
            </div>

            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
              {t('billing.waDailyQuota')}
            </div>

            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                {usage.whatsapp_daily.used.toLocaleString()}
              </span>
              <span className="text-xs sm:text-sm font-semibold text-slate-400">
                / {usage.whatsapp_daily.limit >= 900000 ? t('billing.unlimited') : usage.whatsapp_daily.limit.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="mt-6 space-y-2">
            <div className="w-full bg-slate-200 dark:bg-white/10 rounded-full h-2.5 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 bg-gradient-to-r ${
                  usage.whatsapp_daily.percentage > 85
                    ? 'from-[#EA5455] to-rose-600'
                    : usage.whatsapp_daily.percentage > 60
                    ? 'from-[#FF9F43] to-amber-500'
                    : 'from-[#28C76F] to-emerald-400'
                }`}
                style={{ width: `${Math.min(100, Math.max(2, usage.whatsapp_daily.percentage))}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs font-bold">
              <span className="text-slate-400">{t('billing.resetDaily')}</span>
              <span className="text-[#28C76F]">
                {t('billing.remaining', {
                  count: usage.whatsapp_daily.remaining >= 900000 ? t('billing.unlimited') : usage.whatsapp_daily.remaining.toLocaleString(),
                })}
              </span>
            </div>
          </div>
        </div>

        {/* Metric 3: Daily AI Copy Generations */}
        <div className="landing-glass-card rounded-3xl p-6 flex flex-col justify-between border border-slate-200/80 dark:border-white/[0.08] relative overflow-hidden group">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="p-2.5 rounded-2xl bg-indigo-500/10 text-indigo-500 dark:text-indigo-400 flex items-center gap-2">
                <Sparkles className="w-5 h-5" />
                <span className="text-xs font-bold uppercase tracking-wider">
                  {t('billing.aiDailyShort')}
                </span>
              </div>
              <span className="text-sm font-black font-mono text-indigo-500 dark:text-indigo-400 px-2.5 py-0.5 rounded-full bg-indigo-500/10">
                %{usage.ai_daily.percentage}
              </span>
            </div>

            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
              {t('billing.aiDailyQuota')}
            </div>

            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                {usage.ai_daily.used.toLocaleString()}
              </span>
              <span className="text-xs sm:text-sm font-semibold text-slate-400">
                / {usage.ai_daily.limit >= 900000 ? t('billing.unlimited') : usage.ai_daily.limit.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="mt-6 space-y-2">
            <div className="w-full bg-slate-200 dark:bg-white/10 rounded-full h-2.5 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 bg-gradient-to-r ${
                  usage.ai_daily.percentage > 85
                    ? 'from-[#EA5455] to-rose-600'
                    : usage.ai_daily.percentage > 60
                    ? 'from-[#FF9F43] to-amber-500'
                    : 'from-[#7367F0] via-purple-500 to-pink-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(2, usage.ai_daily.percentage))}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs font-bold">
              <span className="text-slate-400">{t('billing.resetDaily')}</span>
              <span className="text-[#28C76F]">
                {t('billing.remaining', {
                  count: usage.ai_daily.remaining >= 900000 ? t('billing.unlimited') : usage.ai_daily.remaining.toLocaleString(),
                })}
              </span>
            </div>
          </div>
        </div>

        {/* Metric 4: Concurrent Active Tasks / Campaigns */}
        <div className="landing-glass-card rounded-3xl p-6 flex flex-col justify-between border border-slate-200/80 dark:border-white/[0.08] relative overflow-hidden group">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="p-2.5 rounded-2xl bg-[#FF9F43]/10 text-[#FF9F43] flex items-center gap-2">
                <Zap className="w-5 h-5" />
                <span className="text-xs font-bold uppercase tracking-wider">
                  {t('billing.campaignsShort')}
                </span>
              </div>
              <span className="text-sm font-black font-mono text-[#FF9F43] px-2.5 py-0.5 rounded-full bg-[#FF9F43]/10">
                %{usage.active_campaigns.percentage}
              </span>
            </div>

            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
              {t('billing.campaignsQuota')}
            </div>

            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                {usage.active_campaigns.used}
              </span>
              <span className="text-xs sm:text-sm font-semibold text-slate-400">
                / {usage.active_campaigns.limit >= 900000 ? t('billing.unlimited') : usage.active_campaigns.limit}
              </span>
            </div>
          </div>

          <div className="mt-6 space-y-2">
            <div className="w-full bg-slate-200 dark:bg-white/10 rounded-full h-2.5 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700 bg-gradient-to-r from-[#FF9F43] to-amber-500"
                style={{ width: `${Math.min(100, Math.max(2, usage.active_campaigns.percentage))}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs font-bold">
              <span className="text-slate-400">{t('billing.capacityStatus')}</span>
              <span className="text-[#FF9F43]">
                {t('billing.activeSlots', {
                  count: usage.active_campaigns.remaining >= 900000 ? t('billing.unlimited') : String(usage.active_campaigns.remaining),
                })}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Feature Badges & Platform Powers */}
      <div className="landing-glass-card rounded-3xl p-6 sm:p-7 border border-slate-200/80 dark:border-white/[0.08]">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#7367F0]" />
            {t('billing.featuresIncluded')}
          </h4>
          <span className="text-xs font-semibold text-slate-500">
            {t('billing.activePlanRights')}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.06]">
            {usage.features.webhooks ? (
              <CheckCircle2 className="w-5 h-5 text-[#28C76F] shrink-0" />
            ) : (
              <X className="w-5 h-5 text-[#EA5455] shrink-0" />
            )}
            <div>
              <div className="text-xs font-bold text-slate-800 dark:text-white">
                {t('billing.featureWebhooks')}
              </div>
              <div className="text-[10px] text-slate-400">{t('billing.subdescWebhooks')}</div>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.06]">
            {usage.features.api_access ? (
              <CheckCircle2 className="w-5 h-5 text-[#28C76F] shrink-0" />
            ) : (
              <X className="w-5 h-5 text-[#EA5455] shrink-0" />
            )}
            <div>
              <div className="text-xs font-bold text-slate-800 dark:text-white">
                {t('billing.featureApi')}
              </div>
              <div className="text-[10px] text-slate-400">{t('billing.subdescApi')}</div>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.06]">
            {usage.features.export_csv ? (
              <CheckCircle2 className="w-5 h-5 text-[#28C76F] shrink-0" />
            ) : (
              <X className="w-5 h-5 text-[#EA5455] shrink-0" />
            )}
            <div>
              <div className="text-xs font-bold text-slate-800 dark:text-white">
                {t('billing.featureCsv')}
              </div>
              <div className="text-[10px] text-slate-400">{t('billing.subdescCsv')}</div>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.06]">
            <ShieldCheck className="w-5 h-5 text-[#7367F0] shrink-0" />
            <div>
              <div className="text-xs font-bold text-slate-800 dark:text-white">
                {t('billing.featureAntiBan')}
              </div>
              <div className="text-[10px] text-[#28C76F] font-semibold">{t('billing.subdescAntiBan')}</div>
            </div>
          </div>
        </div>
      </div>

      {/* In-Page Direct Plan Selection Matrix */}
      <div className="space-y-4 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">
              {t('billing.comparePlansTitle')}
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {t('billing.comparePlansSubtitle')}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 sm:gap-6">
          {(plansData?.plans || []).map((plan: PlanInfo) => {
            const isCurrent = plan.id === usage.plan_tier;
            const isPro = plan.id === 'PRO';
            return (
              <div
                key={plan.id}
                className={`rounded-3xl p-5 sm:p-6 flex flex-col justify-between transition-all duration-300 relative ${
                  isCurrent
                    ? 'landing-glass-card border-2 border-[#7367F0] shadow-xl shadow-[#7367F0]/20'
                    : isPro
                    ? 'landing-glass-card border-2 border-indigo-400/50 dark:border-[#7367F0]/50 shadow-lg'
                    : 'landing-glass-card border border-slate-200/80 dark:border-white/[0.08]'
                }`}
              >
                {isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-[#7367F0] text-white shadow-md whitespace-nowrap">
                    {t('billing.currentPlanBadge')}
                  </div>
                )}

                {!isCurrent && isPro && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-gradient-to-r from-amber-500 to-[#FF9F43] text-white shadow-md whitespace-nowrap">
                    {t('billing.popularBadge')}
                  </div>
                )}

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h5 className="font-extrabold text-slate-900 dark:text-white text-base">
                      {plan.name}
                    </h5>
                    <span className="text-[11px] font-mono font-bold text-slate-400 uppercase">
                      {plan.id}
                    </span>
                  </div>

                  <div className="flex items-baseline gap-1">
                    <span className="text-sm font-bold text-slate-400">₺</span>
                    <span className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                      {plan.price_try.toLocaleString()}
                    </span>
                    <span className="text-xs text-slate-400">
                      {t('billing.perMonth')}
                    </span>
                  </div>

                  <p className="text-xs text-slate-500 dark:text-slate-400 min-h-[36px] line-clamp-2">
                    {plan.description}
                  </p>

                  <div className="border-t border-slate-100 dark:border-white/[0.05] pt-3">
                    <ul className="space-y-2 text-xs">
                      {plan.features_list.map((feat, i) => (
                        <li key={i} className="flex items-start gap-2 text-slate-700 dark:text-slate-300">
                          <Check className="w-3.5 h-3.5 text-[#28C76F] stroke-[3] shrink-0 mt-0.5" />
                          <span className="text-[11px] leading-tight">{feat}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="pt-5 mt-4 border-t border-slate-100 dark:border-white/[0.05]">
                  <button
                    type="button"
                    onClick={() => handleChangePlan(plan.id)}
                    disabled={isCurrent || switchingTier !== null}
                    className={`w-full h-10 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed ${
                      isCurrent
                        ? 'border border-[#7367F0]/40 bg-[#7367F0]/10 text-[#7367F0]'
                        : 'bg-[#7367F0] hover:bg-[#685DD8] text-white shadow-md shadow-[#7367F0]/30'
                    }`}
                  >
                    {switchingTier === plan.id ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>{t('billing.switchingPlan')}</span>
                      </>
                    ) : isCurrent ? (
                      <span>{t('billing.currentPlanBadge')}</span>
                    ) : (
                      <>
                        <span>{t('billing.selectPlan')}</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Portaled Interactive Plan Upgrade Modal */}
      {showPlansModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[99999] bg-slate-950/75 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 overflow-y-auto animate-fade-in">
          <div className="relative w-full max-w-5xl my-auto rounded-3xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="p-6 sm:p-7 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between relative bg-gradient-to-r from-[#7367F0]/10 via-transparent to-transparent">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#7367F0] text-white flex items-center justify-center shadow-md shadow-[#7367F0]/30">
                  <Sparkles className="w-5 h-5 text-amber-300" />
                </div>
                <div>
                  <h3 className="text-xl font-black text-slate-900 dark:text-white">
                    {t('billing.changePlanTitle')}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('billing.changePlanDesc')}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowPlansModal(false)}
                className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-white/[0.06] hover:bg-slate-200 dark:hover:bg-white/[0.12] text-slate-500 dark:text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
                title={t('billing.closeModal')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body: Plans Comparison Grid */}
            <div className="p-6 sm:p-7 overflow-y-auto space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                {(plansData?.plans || []).map((plan: PlanInfo) => {
                  const isCurrent = plan.id === usage.plan_tier;
                  const isPro = plan.id === 'PRO';
                  return (
                    <div
                      key={plan.id}
                      className={`rounded-2xl p-4 flex flex-col justify-between transition-all relative ${
                        isCurrent
                          ? 'border-2 border-[#7367F0] bg-[#7367F0]/5 shadow-lg shadow-[#7367F0]/15'
                          : isPro
                          ? 'border-2 border-indigo-400/50 dark:border-[#7367F0]/50 bg-slate-50 dark:bg-[#2F3349]/50'
                          : 'border border-slate-200/80 dark:border-white/[0.08] bg-slate-50 dark:bg-[#2F3349]/40'
                      }`}
                    >
                      {isCurrent && (
                        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-[#7367F0] text-white shadow-sm whitespace-nowrap">
                          {t('billing.currentPlanBadge')}
                        </div>
                      )}

                      {!isCurrent && isPro && (
                        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-gradient-to-r from-amber-500 to-[#FF9F43] text-white shadow-sm whitespace-nowrap">
                          {t('billing.popularBadge')}
                        </div>
                      )}

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h6 className="font-extrabold text-slate-900 dark:text-white text-sm">
                            {plan.name}
                          </h6>
                        </div>

                        <div className="flex items-baseline gap-1">
                          <span className="text-xs font-bold text-slate-400">₺</span>
                          <span className="text-2xl font-black text-slate-900 dark:text-white">
                            {plan.price_try.toLocaleString()}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {t('billing.perMonth')}
                          </span>
                        </div>

                        <div className="p-2.5 rounded-xl bg-white dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.04] space-y-1.5 text-[11px]">
                          <div className="flex items-center justify-between font-semibold">
                            <span className="text-slate-400">{t('billing.leadQuotaShort')}</span>
                            <span className="text-slate-800 dark:text-slate-200 font-bold">
                              {plan.monthly_lead_scrape_limit >= 900000 ? t('billing.unlimitedBadge') : plan.monthly_lead_scrape_limit.toLocaleString()}
                            </span>
                          </div>
                          <div className="flex items-center justify-between font-semibold">
                            <span className="text-slate-400">{t('billing.waDailyShort')}</span>
                            <span className="text-slate-800 dark:text-slate-200 font-bold">
                              {plan.daily_whatsapp_outreach_limit >= 900000 ? t('billing.unlimitedBadge') : plan.daily_whatsapp_outreach_limit.toLocaleString()}
                            </span>
                          </div>
                          <div className="flex items-center justify-between font-semibold">
                            <span className="text-slate-400">{t('billing.campaignsShort')}</span>
                            <span className="text-slate-800 dark:text-slate-200 font-bold">
                              {plan.max_active_campaigns >= 900000 ? t('billing.unlimitedBadge') : plan.max_active_campaigns}
                            </span>
                          </div>
                        </div>

                        <ul className="space-y-1.5 text-[11px] pt-1">
                          {plan.features_list.slice(0, 4).map((feat, i) => (
                            <li key={i} className="flex items-start gap-1.5 text-slate-600 dark:text-slate-300">
                              <Check className="w-3 h-3 text-[#28C76F] stroke-[3] shrink-0 mt-0.5" />
                              <span className="line-clamp-1">{feat}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div className="pt-4 mt-3 border-t border-slate-200/60 dark:border-white/[0.06]">
                        <button
                          type="button"
                          onClick={() => handleChangePlan(plan.id)}
                          disabled={isCurrent || switchingTier !== null}
                          className={`w-full h-9 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed ${
                            isCurrent
                              ? 'border border-[#7367F0]/40 bg-[#7367F0]/10 text-[#7367F0]'
                              : 'bg-[#7367F0] hover:bg-[#685DD8] text-white shadow-sm'
                          }`}
                        >
                          {switchingTier === plan.id ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>{t('billing.switchingPlan')}</span>
                            </>
                          ) : isCurrent ? (
                            <span>{t('billing.currentPlanBadge')}</span>
                          ) : (
                            <>
                              <span>{t('billing.selectPlan')}</span>
                              <ChevronRight className="w-3.5 h-3.5" />
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 sm:p-5 border-t border-slate-100 dark:border-white/[0.06] bg-slate-50 dark:bg-[#2F3349]/50 flex items-center justify-between text-xs">
              <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-[#28C76F]" />
                <span>{t('billing.instantActivation')}</span>
              </span>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowPlansModal(false)}
              >
                {t('billing.closeModal')}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
