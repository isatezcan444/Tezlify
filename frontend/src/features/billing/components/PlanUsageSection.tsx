import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  CreditCard,
  Zap,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Users,
  MessageSquare,
  ShieldCheck,
  RefreshCw,
  ChevronRight,
  X,
  Clock,
  Check
} from 'lucide-react';
import { Button, Badge } from '../../../components/ui';
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
      <div className="vuexy-card w-full p-10 text-center text-slate-400 dark:text-slate-500 animate-pulse">
        <RefreshCw className="w-7 h-7 mx-auto mb-3 animate-spin text-[#7367F0]" />
        <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
          {t('billing.planQuotaLoading')}
        </p>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="vuexy-card w-full p-8 text-center text-slate-500">
        <AlertCircle className="w-8 h-8 mx-auto mb-2 text-[#FF9F43]" />
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          {t('billing.planQuotaNotFound')}
        </p>
        <Button onClick={loadData} variant="outline" size="sm" className="mt-4">
          {t('billing.retryBtn')}
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full space-y-5 animate-fade-in select-none">
      {/* 1. Header: Soft, Clean Vuexy Hero Card */}
      <div className="vuexy-card p-5 sm:p-6 rounded-xl border border-slate-200/70 dark:border-white/[0.07] bg-white dark:bg-[#2F3349] shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
          <div className="flex items-start sm:items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-[#7367F0]/10 text-[#7367F0] flex items-center justify-center shrink-0">
              <CreditCard className="w-5 h-5" />
            </div>

            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                  {usage.plan_name}
                </h3>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  {t('billing.activeSubscriptionBadge')}
                </span>
                <span className="text-xs font-mono font-medium text-slate-400 uppercase">
                  {usage.plan_tier}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xl leading-relaxed">
                {t('billing.subtitle')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap justify-between lg:justify-end">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.04] border border-slate-100 dark:border-white/[0.05] text-xs">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-slate-500 dark:text-slate-400">{t('billing.renewalDate')}:</span>
              <span className="font-semibold text-slate-700 dark:text-slate-200">
                {new Date(usage.period_end).toLocaleDateString(language === 'tr' ? 'tr-TR' : 'en-US')}
              </span>
              <span className="text-[#7367F0] font-medium">
                ({t('billing.daysLeft', { days: String(usage.days_until_renewal) })})
              </span>
            </div>

            <Button
              onClick={() => setShowPlansModal(true)}
              className="text-xs font-semibold h-9 px-4 space-x-1.5 shadow-xs"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{t('billing.upgradePlan')}</span>
            </Button>
          </div>
        </div>
      </div>

      {/* 2. Quota Usage: 4 Soft, Clean Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Metric 1: Lead Discovery */}
        <div className="vuexy-card p-4 rounded-xl border border-slate-200/70 dark:border-white/[0.07] bg-white dark:bg-[#2F3349] flex flex-col justify-between space-y-3 hover:border-slate-300 dark:hover:border-white/[0.12] transition-colors">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-[#7367F0]/10 text-[#7367F0] flex items-center justify-center shrink-0">
                <Users className="w-4 h-4" />
              </div>
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
                {t('billing.leadQuotaShort')}
              </span>
            </div>
            <span className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-md bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300">
              %{usage.leads.percentage}
            </span>
          </div>

          <div>
            <div className="text-[11px] text-slate-400 mb-1">
              {t('billing.leadQuota')}
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl sm:text-2xl font-bold font-mono text-slate-900 dark:text-slate-100">
                {usage.leads.used.toLocaleString()}
              </span>
              <span className="text-xs text-slate-400 font-sans">
                / {usage.leads.limit >= 900000 ? t('billing.unlimited') : usage.leads.limit.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="space-y-1.5 pt-1">
            <div className="w-full h-1.5 bg-slate-100 dark:bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  usage.leads.percentage > 85
                    ? 'bg-rose-500'
                    : usage.leads.percentage > 60
                    ? 'bg-amber-500'
                    : 'bg-[#7367F0]'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, usage.leads.percentage))}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400">{t('billing.resetMonthly')}</span>
              <span className="font-medium text-slate-600 dark:text-slate-300">
                {t('billing.remainingUnit', {
                  count: usage.leads.remaining >= 900000 ? t('billing.unlimited') : usage.leads.remaining.toLocaleString(),
                })}
              </span>
            </div>
          </div>
        </div>

        {/* Metric 2: WhatsApp Messages */}
        <div className="vuexy-card p-4 rounded-xl border border-slate-200/70 dark:border-white/[0.07] bg-white dark:bg-[#2F3349] flex flex-col justify-between space-y-3 hover:border-slate-300 dark:hover:border-white/[0.12] transition-colors">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center shrink-0">
                <MessageSquare className="w-4 h-4" />
              </div>
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
                {t('billing.waDailyShort')}
              </span>
            </div>
            <span className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-md bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300">
              %{usage.whatsapp_daily.percentage}
            </span>
          </div>

          <div>
            <div className="text-[11px] text-slate-400 mb-1">
              {t('billing.waDailyQuota')}
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl sm:text-2xl font-bold font-mono text-slate-900 dark:text-slate-100">
                {usage.whatsapp_daily.used.toLocaleString()}
              </span>
              <span className="text-xs text-slate-400 font-sans">
                / {usage.whatsapp_daily.limit >= 900000 ? t('billing.unlimited') : usage.whatsapp_daily.limit.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="space-y-1.5 pt-1">
            <div className="w-full h-1.5 bg-slate-100 dark:bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  usage.whatsapp_daily.percentage > 85
                    ? 'bg-rose-500'
                    : usage.whatsapp_daily.percentage > 60
                    ? 'bg-amber-500'
                    : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, usage.whatsapp_daily.percentage))}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400">{t('billing.resetDaily')}</span>
              <span className="font-medium text-slate-600 dark:text-slate-300">
                {t('billing.remainingUnit', {
                  count: usage.whatsapp_daily.remaining >= 900000 ? t('billing.unlimited') : usage.whatsapp_daily.remaining.toLocaleString(),
                })}
              </span>
            </div>
          </div>
        </div>

        {/* Metric 3: AI Copy Generations */}
        <div className="vuexy-card p-4 rounded-xl border border-slate-200/70 dark:border-white/[0.07] bg-white dark:bg-[#2F3349] flex flex-col justify-between space-y-3 hover:border-slate-300 dark:hover:border-white/[0.12] transition-colors">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-500 dark:text-indigo-400 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
                {t('billing.aiDailyShort')}
              </span>
            </div>
            <span className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-md bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300">
              %{usage.ai_daily.percentage}
            </span>
          </div>

          <div>
            <div className="text-[11px] text-slate-400 mb-1">
              {t('billing.aiDailyQuota')}
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl sm:text-2xl font-bold font-mono text-slate-900 dark:text-slate-100">
                {usage.ai_daily.used.toLocaleString()}
              </span>
              <span className="text-xs text-slate-400 font-sans">
                / {usage.ai_daily.limit >= 900000 ? t('billing.unlimited') : usage.ai_daily.limit.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="space-y-1.5 pt-1">
            <div className="w-full h-1.5 bg-slate-100 dark:bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  usage.ai_daily.percentage > 85
                    ? 'bg-rose-500'
                    : usage.ai_daily.percentage > 60
                    ? 'bg-amber-500'
                    : 'bg-indigo-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, usage.ai_daily.percentage))}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400">{t('billing.resetDaily')}</span>
              <span className="font-medium text-slate-600 dark:text-slate-300">
                {t('billing.remainingUnit', {
                  count: usage.ai_daily.remaining >= 900000 ? t('billing.unlimited') : usage.ai_daily.remaining.toLocaleString(),
                })}
              </span>
            </div>
          </div>
        </div>

        {/* Metric 4: Concurrent Tasks */}
        <div className="vuexy-card p-4 rounded-xl border border-slate-200/70 dark:border-white/[0.07] bg-white dark:bg-[#2F3349] flex flex-col justify-between space-y-3 hover:border-slate-300 dark:hover:border-white/[0.12] transition-colors">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center shrink-0">
                <Zap className="w-4 h-4" />
              </div>
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
                {t('billing.campaignsShort')}
              </span>
            </div>
            <span className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-md bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300">
              %{usage.active_campaigns.percentage}
            </span>
          </div>

          <div>
            <div className="text-[11px] text-slate-400 mb-1">
              {t('billing.campaignsQuota')}
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl sm:text-2xl font-bold font-mono text-slate-900 dark:text-slate-100">
                {usage.active_campaigns.used}
              </span>
              <span className="text-xs text-slate-400 font-sans">
                / {usage.active_campaigns.limit >= 900000 ? t('billing.unlimited') : usage.active_campaigns.limit}
              </span>
            </div>
          </div>

          <div className="space-y-1.5 pt-1">
            <div className="w-full h-1.5 bg-slate-100 dark:bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 bg-amber-500"
                style={{ width: `${Math.min(100, Math.max(0, usage.active_campaigns.percentage))}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400">{t('billing.capacityStatus')}</span>
              <span className="font-medium text-amber-600 dark:text-amber-400">
                {t('billing.activeSlots', {
                  count: usage.active_campaigns.remaining >= 900000 ? t('billing.unlimited') : String(usage.active_campaigns.remaining),
                })}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Included Features Strip: Soft & Light */}
      <div className="vuexy-card p-4 rounded-xl border border-slate-200/70 dark:border-white/[0.07] bg-white dark:bg-[#2F3349]">
        <div className="flex items-center justify-between mb-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
          <span className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-[#7367F0]" />
            {t('billing.featuresIncluded')}
          </span>
          <span className="text-slate-400 font-normal normal-case">
            {t('billing.activePlanRights')}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.04]">
            {usage.features.webhooks ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            ) : (
              <X className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
                {t('billing.featureWebhooks')}
              </div>
              <div className="text-[10px] text-slate-400 truncate">{t('billing.subdescWebhooks')}</div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.04]">
            {usage.features.api_access ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            ) : (
              <X className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
                {t('billing.featureApi')}
              </div>
              <div className="text-[10px] text-slate-400 truncate">{t('billing.subdescApi')}</div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.04]">
            {usage.features.export_csv ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            ) : (
              <X className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
                {t('billing.featureCsv')}
              </div>
              <div className="text-[10px] text-slate-400 truncate">{t('billing.subdescCsv')}</div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.04]">
            <ShieldCheck className="w-4 h-4 text-[#7367F0] shrink-0" />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
                {t('billing.featureAntiBan')}
              </div>
              <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium truncate">
                {t('billing.subdescAntiBan')}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Plan Selection Matrix: Soft, Readable, Spacious Cards */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm sm:text-base font-bold text-slate-800 dark:text-slate-100">
              {t('billing.comparePlansTitle')}
            </h4>
            <p className="text-xs text-slate-400 mt-0.5">
              {t('billing.comparePlansSubtitle')}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {(plansData?.plans || [])
            .filter((p: PlanInfo) => p.id !== 'DEVELOPER_PRO' || usage.plan_tier === 'DEVELOPER_PRO')
            .map((plan: PlanInfo) => {
              const isCurrent = plan.id === usage.plan_tier;
              const isPro = plan.id === 'PRO';
              return (
                <div
                  key={plan.id}
                  className={`vuexy-card p-5 rounded-xl flex flex-col justify-between transition-all duration-200 relative ${
                    isCurrent
                      ? 'border-[#7367F0] ring-1 ring-[#7367F0]/30 bg-[#7367F0]/[0.02]'
                      : isPro
                      ? 'border-amber-400/50 dark:border-amber-500/30'
                      : 'border-slate-200/70 dark:border-white/[0.07]'
                  }`}
                >
                  {isCurrent && (
                    <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-[#7367F0] text-white shadow-xs whitespace-nowrap">
                      {t('billing.currentPlanBadge')}
                    </div>
                  )}

                  {!isCurrent && isPro && (
                    <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500 text-white shadow-xs whitespace-nowrap">
                      {t('billing.popularBadge')}
                    </div>
                  )}

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h5 className="font-bold text-slate-800 dark:text-slate-100 text-sm">
                        {plan.name}
                      </h5>
                      <span className="text-[10px] font-mono text-slate-400 uppercase">
                        {plan.id}
                      </span>
                    </div>

                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold font-mono text-slate-900 dark:text-slate-100">
                        ₺{plan.price_try.toLocaleString()}
                      </span>
                      <span className="text-xs text-slate-400 font-sans">
                        {t('billing.perMonth')}
                      </span>
                    </div>

                    <p className="text-xs text-slate-500 dark:text-slate-400 min-h-[42px] leading-relaxed">
                      {plan.description}
                    </p>

                    {/* Compact Aligned Quota Box */}
                    <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.04] space-y-1.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 text-[11px]">{t('billing.metricLeads')}</span>
                        <span className="font-semibold text-slate-700 dark:text-slate-200 font-mono text-[11px]">
                          {plan.monthly_lead_scrape_limit >= 900000 ? t('billing.unlimitedBadge') : plan.monthly_lead_scrape_limit.toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 text-[11px]">{t('billing.metricWa')}</span>
                        <span className="font-semibold text-slate-700 dark:text-slate-200 font-mono text-[11px]">
                          {plan.daily_whatsapp_outreach_limit >= 900000 ? t('billing.unlimitedBadge') : plan.daily_whatsapp_outreach_limit.toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 text-[11px]">{t('billing.metricCampaigns')}</span>
                        <span className="font-semibold text-slate-700 dark:text-slate-200 font-mono text-[11px]">
                          {plan.max_active_campaigns >= 900000 ? t('billing.unlimitedBadge') : plan.max_active_campaigns}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 text-[11px]">{t('billing.metricAi')}</span>
                        <span className="font-semibold text-slate-700 dark:text-slate-200 font-mono text-[11px]">
                          {plan.ai_daily_limit >= 900000 ? t('billing.unlimitedBadge') : plan.ai_daily_limit.toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {/* Features Snippet */}
                    <ul className="space-y-1.5 text-xs pt-1">
                      {plan.features_list.slice(0, 3).map((feat, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-slate-600 dark:text-slate-300">
                          <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                          <span className="text-[11px] leading-tight line-clamp-1">{feat}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="pt-4 mt-3 border-t border-slate-100 dark:border-white/[0.05]">
                    <Button
                      onClick={() => handleChangePlan(plan.id)}
                      disabled={isCurrent || switchingTier !== null}
                      variant={isCurrent ? 'outline' : 'default'}
                      size="sm"
                      className="w-full text-xs font-semibold h-9"
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
                    </Button>
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* 5. Portaled Interactive Comparison Table Modal */}
      {showPlansModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[99999] bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6 overflow-y-auto animate-fade-in">
          <div className="relative w-full max-w-4xl my-auto rounded-xl bg-white dark:bg-[#2F3349] border border-slate-200/80 dark:border-white/[0.08] shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between bg-slate-50/50 dark:bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-[#7367F0]/10 text-[#7367F0] flex items-center justify-center">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">
                    {t('billing.comparisonTableTitle')}
                  </h3>
                  <p className="text-xs text-slate-400">
                    {t('billing.changePlanDesc')}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowPlansModal(false)}
                className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] flex items-center justify-center transition-colors cursor-pointer"
                title={t('billing.closeModal')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body: Aligned Comparison Table */}
            <div className="p-5 overflow-y-auto">
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200/60 dark:border-white/[0.06]">
                      <th className="py-3 px-3 font-semibold text-slate-400 uppercase text-[10px]">
                        {t('billing.featuresIncluded')}
                      </th>
                      {(plansData?.plans || []).map((p: PlanInfo) => (
                        <th
                          key={p.id}
                          className={`py-3 px-3 text-center ${
                            p.id === usage.plan_tier ? 'text-[#7367F0] font-bold' : 'text-slate-700 dark:text-slate-200 font-semibold'
                          }`}
                        >
                          <div>{p.name}</div>
                          {p.id === usage.plan_tier && (
                            <span className="inline-block mt-0.5 px-2 py-0.5 rounded text-[9px] bg-[#7367F0]/10 text-[#7367F0]">
                              {t('billing.activePlanNote')}
                            </span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-white/[0.04]">
                    <tr>
                      <td className="py-3 px-3 font-medium text-slate-600 dark:text-slate-300">
                        {t('billing.metricPrice')}
                      </td>
                      {(plansData?.plans || []).map((p: PlanInfo) => (
                        <td key={p.id} className="py-3 px-3 text-center font-mono font-bold text-slate-800 dark:text-slate-100">
                          ₺{p.price_try.toLocaleString()} <span className="text-[10px] text-slate-400 font-sans font-normal">/ay</span>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 px-3 font-medium text-slate-600 dark:text-slate-300">
                        {t('billing.metricLeads')}
                      </td>
                      {(plansData?.plans || []).map((p: PlanInfo) => (
                        <td key={p.id} className="py-3 px-3 text-center font-mono">
                          {p.monthly_lead_scrape_limit >= 900000 ? t('billing.unlimitedBadge') : p.monthly_lead_scrape_limit.toLocaleString()}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 px-3 font-medium text-slate-600 dark:text-slate-300">
                        {t('billing.metricWa')}
                      </td>
                      {(plansData?.plans || []).map((p: PlanInfo) => (
                        <td key={p.id} className="py-3 px-3 text-center font-mono">
                          {p.daily_whatsapp_outreach_limit >= 900000 ? t('billing.unlimitedBadge') : p.daily_whatsapp_outreach_limit.toLocaleString()}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 px-3 font-medium text-slate-600 dark:text-slate-300">
                        {t('billing.metricCampaigns')}
                      </td>
                      {(plansData?.plans || []).map((p: PlanInfo) => (
                        <td key={p.id} className="py-3 px-3 text-center font-mono">
                          {p.max_active_campaigns >= 900000 ? t('billing.unlimitedBadge') : p.max_active_campaigns}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 px-3 font-medium text-slate-600 dark:text-slate-300">
                        {t('billing.metricAi')}
                      </td>
                      {(plansData?.plans || []).map((p: PlanInfo) => (
                        <td key={p.id} className="py-3 px-3 text-center font-mono">
                          {p.ai_daily_limit >= 900000 ? t('billing.unlimitedBadge') : p.ai_daily_limit.toLocaleString()}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 px-3 font-medium text-slate-600 dark:text-slate-300">
                        {t('billing.metricWebhooks')}
                      </td>
                      {(plansData?.plans || []).map((p: PlanInfo) => (
                        <td key={p.id} className="py-3 px-3 text-center">
                          {p.webhooks_enabled ? (
                            <Check className="w-4 h-4 text-emerald-500 mx-auto" />
                          ) : (
                            <span className="text-slate-300 dark:text-slate-600">-</span>
                          )}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 px-3 font-medium text-slate-600 dark:text-slate-300">
                        {t('billing.metricApi')}
                      </td>
                      {(plansData?.plans || []).map((p: PlanInfo) => (
                        <td key={p.id} className="py-3 px-3 text-center">
                          {p.api_access_enabled ? (
                            <Check className="w-4 h-4 text-emerald-500 mx-auto" />
                          ) : (
                            <span className="text-slate-300 dark:text-slate-600">-</span>
                          )}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 px-3 font-medium text-slate-600 dark:text-slate-300">
                        {t('billing.metricAntiBan')}
                      </td>
                      {(plansData?.plans || []).map((p: PlanInfo) => (
                        <td key={p.id} className="py-3 px-3 text-center">
                          <Check className="w-4 h-4 text-emerald-500 mx-auto" />
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 px-3 font-semibold text-slate-700 dark:text-slate-200">
                        {t('billing.action')}
                      </td>
                      {(plansData?.plans || []).map((p: PlanInfo) => {
                        const isCurrent = p.id === usage.plan_tier;
                        return (
                          <td key={p.id} className="py-3 px-2 text-center">
                            <Button
                              onClick={() => handleChangePlan(p.id)}
                              disabled={isCurrent || switchingTier !== null}
                              variant={isCurrent ? 'outline' : 'default'}
                              size="sm"
                              className="text-xs font-semibold h-8 w-full"
                            >
                              {switchingTier === p.id ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin mx-auto" />
                              ) : isCurrent ? (
                                t('billing.currentPlanBadge')
                              ) : (
                                t('billing.selectPlan')
                              )}
                            </Button>
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-100 dark:border-white/[0.06] bg-slate-50/50 dark:bg-white/[0.02] flex items-center justify-between text-xs">
              <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
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
