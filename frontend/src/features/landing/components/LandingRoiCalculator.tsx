import React, { useState } from 'react';
import { 
  Calculator, 
  TrendingUp, 
  Clock, 
  Users, 
  MessageSquare, 
  Sparkles, 
  ArrowRight, 
  Check, 
  BadgePercent,
  Coins
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

interface LandingRoiCalculatorProps {
  onGetStarted: () => void;
}

export const LandingRoiCalculator: React.FC<LandingRoiCalculatorProps> = ({ onGetStarted }) => {
  const { t } = useI18n();

  const [targetLeads, setTargetLeads] = useState<number>(2500);
  const [dealValue, setDealValue] = useState<number>(7500);

  // Dynamic B2B Outreach Benchmarks:
  // - 92% of scraped businesses yield valid E.164 mobile numbers with active WhatsApp accounts
  // - 7% reply rate from personalized Spintax WhatsApp messages
  // - 10% sales conversion from warm replies into paid customers
  // - Manual search rate: 10 leads/hour vs Tezlify: ~500 leads/minute
  const verifiedPhones = Math.round(targetLeads * 0.92);
  const estimatedReplies = Math.round(targetLeads * 0.07);
  const estimatedDeals = Math.max(1, Math.round(estimatedReplies * 0.10));
  const estimatedRevenue = estimatedDeals * dealValue;
  const hoursSaved = Math.round(targetLeads / 20); // ~125 hours saved for 2500 leads

  // Recommended plan logic
  const recommendedPlan = 
    targetLeads <= 1000 
      ? { name: t('landing.calcPlanStarter'), price: t('landing.calcPlanStarterPrice'), badge: t('landing.calcPlanStarterBadge') }
      : targetLeads <= 5000
      ? { name: t('landing.calcPlanPro'), price: t('landing.calcPlanProPrice'), badge: t('landing.calcPlanProBadge') }
      : { name: t('landing.calcPlanAgency'), price: t('landing.calcPlanAgencyPrice'), badge: t('landing.calcPlanAgencyBadge') };

  return (
    <section id="roi-calculator" className="py-20 sm:py-32 select-none relative overflow-hidden">
      {/* Ambient background glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-6xl h-96 bg-gradient-to-r from-[#7367F0]/10 via-[#00CFE8]/10 to-transparent blur-3xl pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-bold bg-[#28C76F]/10 text-[#28C76F] dark:bg-[#28C76F]/20 dark:text-[#52e591] mb-4 border border-[#28C76F]/20">
            <Calculator className="w-3.5 h-3.5" />
            <span>{t('landing.calcBadge')}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight">
            <span className="font-serif italic font-normal text-shimmer">
              {t('landing.calcTitle')}
            </span>
          </h2>

          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-400">
            {t('landing.calcSubtitle')}
          </p>
        </div>

        {/* Main Calculator Card */}
        <div className="landing-glass-card rounded-3xl p-6 sm:p-10 border border-slate-200/80 dark:border-white/[0.1] shadow-2xl">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
            
            {/* Left Controls (lg:col-span-6) */}
            <div className="lg:col-span-6 space-y-8">
              {/* Slider 1: Target Leads */}
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs sm:text-sm font-bold">
                  <span className="text-slate-700 dark:text-slate-200">
                    {t('landing.calcSliderLabel')}
                  </span>
                  <span className="text-base sm:text-lg font-black font-mono text-[#7367F0] px-3 py-0.5 rounded-xl bg-[#7367F0]/10">
                    {targetLeads.toLocaleString()} {t('landing.calcBusinessesUnit')}
                  </span>
                </div>

                <input
                  type="range"
                  min={500}
                  max={10000}
                  step={250}
                  value={targetLeads}
                  onChange={(e) => setTargetLeads(Number(e.target.value))}
                  className="w-full h-2.5 bg-slate-200 dark:bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#7367F0]"
                />

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setTargetLeads(1000)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                      targetLeads === 1000
                        ? 'bg-[#7367F0] text-white shadow-sm'
                        : 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-white/[0.08]'
                    }`}
                  >
                    {t('landing.calcPresetBoutique')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTargetLeads(2500)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                      targetLeads === 2500
                        ? 'bg-[#7367F0] text-white shadow-sm'
                        : 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-white/[0.08]'
                    }`}
                  >
                    {t('landing.calcPresetGrowth')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTargetLeads(6000)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                      targetLeads >= 5000
                        ? 'bg-[#7367F0] text-white shadow-sm'
                        : 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-white/[0.08]'
                    }`}
                  >
                    {t('landing.calcPresetAgency')}
                  </button>
                </div>
              </div>

              {/* Slider 2: Average Deal Value */}
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs sm:text-sm font-bold">
                  <span className="text-slate-700 dark:text-slate-200">
                    {t('landing.calcDealSizeLabel')}
                  </span>
                  <span className="text-base sm:text-lg font-black font-mono text-[#28C76F] px-3 py-0.5 rounded-xl bg-[#28C76F]/10">
                    ₺{dealValue.toLocaleString()}
                  </span>
                </div>

                <input
                  type="range"
                  min={2000}
                  max={40000}
                  step={1000}
                  value={dealValue}
                  onChange={(e) => setDealValue(Number(e.target.value))}
                  className="w-full h-2.5 bg-slate-200 dark:bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#28C76F]"
                />

                <div className="flex justify-between text-[11px] text-slate-400">
                  <span>{t('landing.calcDealMicro')}</span>
                  <span>{t('landing.calcDealMid')}</span>
                  <span>{t('landing.calcDealEnterprise')}</span>
                </div>
              </div>

              {/* Smart Plan Recommendation Card */}
              <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-[#7367F0]/10 via-indigo-600/5 to-transparent border border-[#7367F0]/25 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-[#FF9F43]" />
                    {t('landing.recommendedPlan')}
                  </div>
                  <div className="text-sm sm:text-base font-extrabold text-slate-900 dark:text-white mt-0.5 flex items-center gap-2">
                    <span>{recommendedPlan.name}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#7367F0] text-white">
                      {recommendedPlan.badge}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 font-semibold mt-0.5">
                    {recommendedPlan.price}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onGetStarted}
                  className="px-4 py-2.5 rounded-xl bg-[#7367F0] hover:bg-[#685DD8] text-white text-xs font-bold shadow-md shadow-[#7367F0]/30 transition-all cursor-pointer flex items-center justify-center gap-1.5 shrink-0 active:scale-95"
                >
                  <span>{t('landing.startWithThisPlan')}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Right Metrics Display (lg:col-span-6) */}
            <div className="lg:col-span-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Metric 1: Verified Mobile Phones */}
              <div className="p-5 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] shadow-sm space-y-2">
                <div className="flex items-center justify-between">
                  <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-500">
                    <Users className="w-5 h-5" />
                  </div>
                  <span className="text-[11px] font-bold text-blue-500 font-mono">{t('landing.calcAccuracyRate')}</span>
                </div>
                <div className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                  {verifiedPhones.toLocaleString()}
                </div>
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {t('landing.metricVerifiedPhones')}
                </div>
              </div>

              {/* Metric 2: Estimated WhatsApp Replies */}
              <div className="p-5 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] shadow-sm space-y-2">
                <div className="flex items-center justify-between">
                  <div className="p-2.5 rounded-xl bg-[#00CFE8]/10 text-[#00CFE8]">
                    <MessageSquare className="w-5 h-5" />
                  </div>
                  <span className="text-[11px] font-bold text-[#00CFE8] font-mono">{t('landing.calcReplyRate')}</span>
                </div>
                <div className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                  ~{estimatedReplies.toLocaleString()}
                </div>
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {t('landing.metricReplies')}
                </div>
              </div>

              {/* Metric 3: Potential Revenue Growth (Highlights in Green) */}
              <div className="p-5 rounded-2xl bg-gradient-to-br from-[#28C76F]/15 to-emerald-500/5 border border-[#28C76F]/30 shadow-sm space-y-2 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <div className="p-2.5 rounded-xl bg-[#28C76F]/20 text-[#28C76F]">
                    <Coins className="w-5 h-5" />
                  </div>
                  <span className="text-xs font-bold text-[#28C76F] px-2.5 py-0.5 rounded-full bg-[#28C76F]/20">
                    ~{estimatedDeals} {t('landing.calcNewDealsUnit')}
                  </span>
                </div>
                <div className="text-3xl sm:text-4xl font-black text-slate-900 dark:text-white tracking-tight">
                  ₺{estimatedRevenue.toLocaleString()}
                  <span className="text-xs font-normal text-slate-400 ml-1.5">{t('landing.calcRevenueSuffix')}</span>
                </div>
                <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                  {t('landing.metricRevenue')}
                </div>
              </div>

              {/* Metric 4: Time Saved */}
              <div className="p-5 rounded-2xl bg-white dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] shadow-sm space-y-2 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-500">
                    <Clock className="w-5 h-5" />
                  </div>
                  <span className="text-xs font-bold text-amber-500">{t('landing.calcManualLaborSaving')}</span>
                </div>
                <div className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                  +{hoursSaved} {t('landing.metricTimeSavedUnit')}
                </div>
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {t('landing.metricTimeSaved')}
                </div>
              </div>
            </div>

          </div>

          {/* Footnote Disclaimer */}
          <div className="mt-8 pt-4 border-t border-slate-100 dark:border-white/[0.06] text-center text-[11px] text-slate-400">
            {t('landing.calcFootnote')}
          </div>
        </div>
      </div>
    </section>
  );
};
