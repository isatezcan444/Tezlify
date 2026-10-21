import React, { useState, useEffect } from 'react';
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
  TrendingUp,
  Check
} from 'lucide-react';
import { Card, Button, Badge } from '../../../components/ui';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { ApiClient as Api } from '../../../api/client';
import { QuotaUsageSummary, PlanListResponse, PlanInfo } from '../../../types';

export const PlanUsageSection: React.FC = () => {
  const { t } = useI18n();
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
      const msg = err instanceof Error ? err.message : 'Veriler yüklenemedi';
      toast.error(t('toast.errorTitle'), msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

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
      const msg = err instanceof Error ? err.message : 'Paket güncellenemedi';
      toast.error(t('toast.errorTitle'), msg);
    } finally {
      setSwitchingTier(null);
    }
  };

  if (loading && !usage) {
    return (
      <Card className="p-12 text-center text-slate-400 dark:text-slate-500 animate-pulse">
        <RefreshCw className="w-8 h-8 mx-auto mb-3 animate-spin text-[#7367F0]" />
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Paket ve kota bilgileri yükleniyor...
        </p>
      </Card>
    );
  }

  if (!usage) {
    return (
      <Card className="p-8 text-center text-slate-500">
        <AlertCircle className="w-8 h-8 mx-auto mb-2 text-[#FF9F43]" />
        <p className="text-sm font-bold text-slate-700 dark:text-slate-300">
          Kota bilgileri bulunamadı.
        </p>
        <Button onClick={loadData} variant="outline" className="mt-4">
          Tekrar Dene
        </Button>
      </Card>
    );
  }

  const getBadgeVariant = (tier: string) => {
    const map: Record<string, 'default' | 'success' | 'warning' | 'info' | 'secondary'> = {
      FREE: 'secondary',
      STARTER: 'default',
      PRO: 'success',
      AGENCY: 'warning',
      DEVELOPER_PRO: 'info',
    };
    return map[tier.toUpperCase()] || 'default';
  };

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
                  Aktif Abonelik
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
                <span>{new Date(usage.period_end).toLocaleDateString()}</span>
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

      {/* Quota Progress Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Metric 1: Monthly Lead Scraper Quota */}
        <div className="landing-glass-card rounded-3xl p-6 flex flex-col justify-between border border-slate-200/80 dark:border-white/[0.08] relative overflow-hidden group">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="p-2.5 rounded-2xl bg-[#7367F0]/10 text-[#7367F0] flex items-center gap-2">
                <Users className="w-5 h-5" />
                <span className="text-xs font-bold uppercase tracking-wider">
                  Lead Arama
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
              <span className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                {usage.leads.used.toLocaleString()}
              </span>
              <span className="text-sm font-semibold text-slate-400">
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
              <span className="text-slate-400">Aylık Sıfırlanır</span>
              <span className="text-[#28C76F]">
                {t('billing.remaining', { count: String(usage.leads.remaining) })}
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
                  WhatsApp Gönderim
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
              <span className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                {usage.whatsapp_daily.used.toLocaleString()}
              </span>
              <span className="text-sm font-semibold text-slate-400">
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
              <span className="text-slate-400">Her Gece 00:00 Yenilenir</span>
              <span className="text-[#28C76F]">
                {t('billing.remaining', { count: String(usage.whatsapp_daily.remaining) })}
              </span>
            </div>
          </div>
        </div>

        {/* Metric 3: Active Campaigns / Tasks */}
        <div className="landing-glass-card rounded-3xl p-6 flex flex-col justify-between border border-slate-200/80 dark:border-white/[0.08] relative overflow-hidden group">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="p-2.5 rounded-2xl bg-[#FF9F43]/10 text-[#FF9F43] flex items-center gap-2">
                <Zap className="w-5 h-5" />
                <span className="text-xs font-bold uppercase tracking-wider">
                  Eşzamanlı Görev
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
              <span className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                {usage.active_campaigns.used}
              </span>
              <span className="text-sm font-semibold text-slate-400">
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
              <span className="text-slate-400">Kapasite Durumu</span>
              <span className="text-[#FF9F43]">
                {usage.active_campaigns.remaining} Aktif Slot
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
            Aktif Paket Hakları
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
              <div className="text-[10px] text-slate-400">Slack & Zapier Aktarımı</div>
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
              <div className="text-[10px] text-slate-400">Geliştirici & Form Uçları</div>
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
              <div className="text-[10px] text-slate-400">Excel & CSV Dışa Aktarımı</div>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.06]">
            <ShieldCheck className="w-5 h-5 text-[#7367F0] shrink-0" />
            <div>
              <div className="text-xs font-bold text-slate-800 dark:text-white">
                {t('billing.featureAntiBan')}
              </div>
              <div className="text-[10px] text-[#28C76F] font-semibold">Fail-Closed Mesai Koruması</div>
            </div>
          </div>
        </div>
      </div>

      {/* In-Page Direct Plan Selection Matrix */}
      <div className="space-y-4 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-lg font-black text-slate-900 dark:text-white">
              Tüm Planları Karşılaştır & Anında Değiştir
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              İhtiyaçlarınıza göre üst pakete geçebilir veya paketinizi güncelleyebilirsiniz.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {(plansData?.plans || []).map((plan: PlanInfo) => {
            const isCurrent = plan.id === usage.plan_tier;
            return (
              <div
                key={plan.id}
                className={`rounded-3xl p-6 flex flex-col justify-between transition-all duration-300 relative ${
                  isCurrent
                    ? 'landing-glass-card border-2 border-[#7367F0] shadow-xl shadow-[#7367F0]/20'
                    : 'landing-glass-card border border-slate-200/80 dark:border-white/[0.08]'
                }`}
              >
                {isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-[#7367F0] text-white shadow-md">
                    {t('billing.currentPlanBadge')}
                  </div>
                )}

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h5 className="font-extrabold text-slate-900 dark:text-white text-base">
                      {plan.name}
                    </h5>
                    <span className="text-xs font-mono font-bold text-slate-400">
                      {plan.id}
                    </span>
                  </div>

                  <div className="flex items-baseline gap-1">
                    <span className="text-sm font-bold text-slate-400">₺</span>
                    <span className="text-3xl font-black text-slate-900 dark:text-white">
                      {plan.price_try}
                    </span>
                    <span className="text-xs text-slate-400">
                      {t('billing.perMonth')}
                    </span>
                  </div>

                  <p className="text-xs text-slate-500 dark:text-slate-400 min-h-[32px]">
                    {plan.description}
                  </p>

                  <div className="border-t border-slate-100 dark:border-white/[0.05] pt-3">
                    <ul className="space-y-2 text-xs">
                      {plan.features_list.map((feat, i) => (
                        <li key={i} className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                          <Check className="w-3.5 h-3.5 text-[#28C76F] stroke-[3] shrink-0" />
                          <span>{feat}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="pt-6 mt-4 border-t border-slate-100 dark:border-white/[0.05]">
                  <button
                    type="button"
                    onClick={() => handleChangePlan(plan.id)}
                    disabled={isCurrent || switchingTier !== null}
                    className={`w-full h-11 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all cursor-pointer active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed ${
                      isCurrent
                        ? 'border border-[#7367F0]/40 bg-[#7367F0]/10 text-[#7367F0]'
                        : 'bg-[#7367F0] hover:bg-[#685DD8] text-white shadow-md shadow-[#7367F0]/30'
                    }`}
                  >
                    {switchingTier === plan.id ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>{t('billing.switchingPlan')}</span>
                      </>
                    ) : isCurrent ? (
                      <span>{t('billing.currentPlanBadge')}</span>
                    ) : (
                      <>
                        <span>{t('billing.selectPlan')}</span>
                        <ChevronRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
