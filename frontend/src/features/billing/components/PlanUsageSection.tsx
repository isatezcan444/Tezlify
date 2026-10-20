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
  ExternalLink,
  ChevronRight,
  X,
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
      <Card className="p-8 text-center text-text-muted animate-pulse">
        <RefreshCw className="w-8 h-8 mx-auto mb-3 animate-spin text-brand-primary" />
        <p className="text-sm font-medium">Paket ve kota bilgileri yükleniyor...</p>
      </Card>
    );
  }

  if (!usage) {
    return (
      <Card className="p-6 text-center text-text-muted">
        <AlertCircle className="w-8 h-8 mx-auto mb-2 text-warning" />
        <p className="text-sm">Kota bilgileri bulunamadı.</p>
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
    <div className="w-full space-y-6">
      {/* Top Banner: Current Plan Overview */}
      <Card className="p-5 sm:p-6 bg-gradient-to-r from-card to-card-hover border-border shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start sm:items-center gap-3">
            <div className="p-3 bg-brand-primary/10 rounded-xl text-brand-primary shrink-0">
              <CreditCard className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-lg font-bold text-text-primary tracking-tight">
                  {usage.plan_name}
                </h3>
                <Badge variant={getBadgeVariant(usage.plan_tier)}>
                  {usage.plan_tier}
                </Badge>
              </div>
              <p className="text-xs sm:text-sm text-text-muted mt-0.5">
                {t('billing.subtitle')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap justify-between md:justify-end">
            <div className="text-left md:text-right">
              <div className="text-xs text-text-muted flex items-center md:justify-end gap-1">
                <Calendar className="w-3.5 h-3.5" />
                {t('billing.renewalDate')}
              </div>
              <div className="text-xs sm:text-sm font-semibold text-text-primary">
                {new Date(usage.period_end).toLocaleDateString()}
                <span className="ml-1 text-xs text-brand-primary font-normal">
                  ({t('billing.daysLeft', { days: String(usage.days_until_renewal) })})
                </span>
              </div>
            </div>

            <Button
              onClick={() => setShowPlansModal(true)}
              variant="default"
              className="gap-1.5 shadow-sm whitespace-nowrap"
            >
              <Sparkles className="w-4 h-4 text-warning" />
              <span>{t('billing.upgradePlan')}</span>
            </Button>
          </div>
        </div>
      </Card>

      {/* Quota Progress Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Metric 1: Monthly Lead Scraper Quota */}
        <Card className="p-4 sm:p-5 border-border space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-muted flex items-center gap-1.5">
              <Users className="w-4 h-4 text-brand-primary" />
              {t('billing.leadQuota')}
            </span>
            <span className="text-xs font-mono font-bold text-text-primary">
              %{usage.leads.percentage}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <div className="text-xl sm:text-2xl font-black text-text-primary">
              {usage.leads.used.toLocaleString()}
              <span className="text-xs font-normal text-text-muted ml-1">
                / {usage.leads.limit >= 900000 ? t('billing.unlimited') : usage.leads.limit.toLocaleString()}
              </span>
            </div>
            <span className="text-xs text-success font-medium">
              {t('billing.remaining', { count: String(usage.leads.remaining) })}
            </span>
          </div>
          {/* Progress bar */}
          <div className="w-full bg-border/60 rounded-full h-2 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                usage.leads.percentage > 85 ? 'bg-danger' : usage.leads.percentage > 60 ? 'bg-warning' : 'bg-brand-primary'
              }`}
              style={{ width: `${Math.min(100, Math.max(2, usage.leads.percentage))}%` }}
            />
          </div>
        </Card>

        {/* Metric 2: Daily WhatsApp Messages */}
        <Card className="p-4 sm:p-5 border-border space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-muted flex items-center gap-1.5">
              <MessageSquare className="w-4 h-4 text-success" />
              {t('billing.waDailyQuota')}
            </span>
            <span className="text-xs font-mono font-bold text-text-primary">
              %{usage.whatsapp_daily.percentage}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <div className="text-xl sm:text-2xl font-black text-text-primary">
              {usage.whatsapp_daily.used.toLocaleString()}
              <span className="text-xs font-normal text-text-muted ml-1">
                / {usage.whatsapp_daily.limit >= 900000 ? t('billing.unlimited') : usage.whatsapp_daily.limit.toLocaleString()}
              </span>
            </div>
            <span className="text-xs text-success font-medium">
              {t('billing.remaining', { count: String(usage.whatsapp_daily.remaining) })}
            </span>
          </div>
          {/* Progress bar */}
          <div className="w-full bg-border/60 rounded-full h-2 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                usage.whatsapp_daily.percentage > 85 ? 'bg-danger' : usage.whatsapp_daily.percentage > 60 ? 'bg-warning' : 'bg-success'
              }`}
              style={{ width: `${Math.min(100, Math.max(2, usage.whatsapp_daily.percentage))}%` }}
            />
          </div>
        </Card>

        {/* Metric 3: Concurrent Active Campaigns */}
        <Card className="p-4 sm:p-5 border-border space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-muted flex items-center gap-1.5">
              <Zap className="w-4 h-4 text-warning" />
              {t('billing.campaignsQuota')}
            </span>
            <span className="text-xs font-mono font-bold text-text-primary">
              %{usage.active_campaigns.percentage}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <div className="text-xl sm:text-2xl font-black text-text-primary">
              {usage.active_campaigns.used}
              <span className="text-xs font-normal text-text-muted ml-1">
                / {usage.active_campaigns.limit >= 900000 ? t('billing.unlimited') : usage.active_campaigns.limit}
              </span>
            </div>
            <span className="text-xs text-brand-primary font-medium">
              {usage.active_campaigns.remaining} Aktif Kapasite
            </span>
          </div>
          {/* Progress bar */}
          <div className="w-full bg-border/60 rounded-full h-2 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                usage.active_campaigns.percentage > 85 ? 'bg-danger' : 'bg-warning'
              }`}
              style={{ width: `${Math.min(100, Math.max(2, usage.active_campaigns.percentage))}%` }}
            />
          </div>
        </Card>
      </div>

      {/* Feature Entitlements Card */}
      <Card className="p-4 sm:p-5 border-border">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">
          {t('billing.featuresIncluded')}
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-card-hover border border-border/50">
            {usage.features.webhooks ? (
              <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
            ) : (
              <X className="w-4 h-4 text-danger shrink-0" />
            )}
            <span className="text-xs font-medium text-text-primary">
              {t('billing.featureWebhooks')}
            </span>
          </div>

          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-card-hover border border-border/50">
            {usage.features.api_access ? (
              <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
            ) : (
              <X className="w-4 h-4 text-danger shrink-0" />
            )}
            <span className="text-xs font-medium text-text-primary">
              {t('billing.featureApi')}
            </span>
          </div>

          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-card-hover border border-border/50">
            {usage.features.export_csv ? (
              <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
            ) : (
              <X className="w-4 h-4 text-danger shrink-0" />
            )}
            <span className="text-xs font-medium text-text-primary">
              {t('billing.featureCsv')}
            </span>
          </div>

          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-card-hover border border-border/50">
            <ShieldCheck className="w-4 h-4 text-brand-primary shrink-0" />
            <span className="text-xs font-medium text-text-primary">
              {t('billing.featureAntiBan')}
            </span>
          </div>
        </div>
      </Card>

      {/* Upgrade / Change Plan Modal */}
      {showPlansModal && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-card border border-border rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border pb-4">
              <div>
                <h3 className="text-xl font-bold text-text-primary flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-warning" />
                  {t('billing.changePlanTitle')}
                </h3>
                <p className="text-xs text-text-muted mt-1">
                  {t('billing.changePlanDesc')}
                </p>
              </div>
              <button
                onClick={() => setShowPlansModal(false)}
                className="p-1.5 text-text-muted hover:text-text-primary rounded-lg hover:bg-card-hover"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Plans Comparison Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(plansData?.plans || []).map((plan: PlanInfo) => {
                const isCurrent = plan.id === usage.plan_tier;
                return (
                  <div
                    key={plan.id}
                    className={`rounded-xl p-5 border flex flex-col justify-between transition-all ${
                      isCurrent
                        ? 'border-brand-primary bg-brand-primary/5 shadow-md ring-1 ring-brand-primary'
                        : 'border-border bg-card hover:border-brand-primary/50'
                    }`}
                  >
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-text-primary text-base">
                          {plan.name}
                        </h4>
                        {isCurrent && (
                          <Badge variant="default" className="text-[10px] px-2 py-0.5">
                            {t('billing.currentPlanBadge')}
                          </Badge>
                        )}
                      </div>

                      <div className="flex items-baseline gap-1">
                        <span className="text-3xl font-black text-text-primary">
                          ₺{plan.price_try}
                        </span>
                        <span className="text-xs text-text-muted">
                          {t('billing.perMonth')}
                        </span>
                      </div>

                      <p className="text-xs text-text-muted min-h-[32px]">
                        {plan.description}
                      </p>

                      <hr className="border-border/60" />

                      <ul className="space-y-2 text-xs">
                        {plan.features_list.map((feat, i) => (
                          <li key={i} className="flex items-center gap-2 text-text-primary">
                            <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                            <span>{feat}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="pt-6 mt-4 border-t border-border/40">
                      <Button
                        onClick={() => handleChangePlan(plan.id)}
                        disabled={isCurrent || switchingTier !== null}
                        variant={isCurrent ? 'outline' : 'default'}
                        className="w-full gap-1.5"
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
                            <ChevronRight className="w-4 h-4" />
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
