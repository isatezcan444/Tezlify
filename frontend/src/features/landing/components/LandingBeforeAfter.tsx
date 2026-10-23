import React from 'react';
import { 
  X, 
  Check, 
  Sparkles, 
  ArrowRight, 
  Flame, 
  ShieldCheck, 
  Search, 
  MessageSquare, 
  Inbox, 
  TrendingUp, 
  Scale 
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

interface LandingBeforeAfterProps {
  onGetStarted: () => void;
}

export const LandingBeforeAfter: React.FC<LandingBeforeAfterProps> = ({ onGetStarted }) => {
  const { t } = useI18n();

  const comparisonRows = [
    {
      icon: Search,
      title: t('landing.compItem1Title'),
      oldDesc: t('landing.compItem1Old'),
      newDesc: t('landing.compItem1New'),
    },
    {
      icon: MessageSquare,
      title: t('landing.compItem2Title'),
      oldDesc: t('landing.compItem2Old'),
      newDesc: t('landing.compItem2New'),
    },
    {
      icon: Inbox,
      title: t('landing.compItem3Title'),
      oldDesc: t('landing.compItem3Old'),
      newDesc: t('landing.compItem3New'),
    },
    {
      icon: Scale,
      title: t('landing.compItem4Title'),
      oldDesc: t('landing.compItem4Old'),
      newDesc: t('landing.compItem4New'),
    },
    {
      icon: TrendingUp,
      title: t('landing.compItem5Title'),
      oldDesc: t('landing.compItem5Old'),
      newDesc: t('landing.compItem5New'),
    },
  ];

  return (
    <section id="comparison" className="py-20 sm:py-32 select-none relative overflow-hidden">
      {/* Subtle ambient lighting */}
      <div className="absolute top-1/3 left-1/4 -translate-x-1/2 w-96 h-96 bg-[#EA5455]/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 w-96 h-96 bg-[#28C76F]/10 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl sm:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight">
            <span className="font-serif italic font-normal text-shimmer">
              {t('landing.comparisonTitle')}
            </span>
          </h2>

          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-400 leading-relaxed">
            {t('landing.comparisonSubtitle')}
          </p>
        </div>

        {/* Side-by-Side Dual Matrix Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch">

          {/* LEFT: Old & Traditional Way */}
          <div className="rounded-3xl p-6 sm:p-8 border border-rose-500/20 bg-rose-500/[0.02] dark:bg-rose-950/[0.08] backdrop-blur-md flex flex-col justify-between relative shadow-lg">
            <div>
              {/* Header */}
              <div className="flex items-center justify-between pb-6 border-b border-rose-500/15">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-rose-500/15 text-rose-500 flex items-center justify-center">
                    <X className="w-5 h-5 stroke-[2.5]" />
                  </div>
                  <div>
                    <h3 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white">
                      {t('landing.oldWayTitle')}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {t('landing.oldWaySubtitle')}
                    </p>
                  </div>
                </div>

                <span className="px-3 py-1 rounded-xl text-[11px] font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                  {t('landing.oldWayBadge')}
                </span>
              </div>

              {/* Rows */}
              <div className="mt-6 space-y-6">
                {comparisonRows.map((row, idx) => (
                  <div key={idx} className="flex items-start gap-3.5 group">
                    <div className="w-6 h-6 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0 mt-0.5">
                      <X className="w-3.5 h-3.5 stroke-[2.5]" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-bold text-slate-700 dark:text-slate-300">
                        {row.title}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        {row.oldDesc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom Summary Pill */}
            <div className="mt-8 pt-4 border-t border-rose-500/15 flex items-center justify-center text-center">
              <span className="text-xs font-semibold text-rose-600 dark:text-rose-400">
                {t('landing.compOldBottomSummary')}
              </span>
            </div>
          </div>

          {/* RIGHT: The Tezlify Way (High Polish, Gradient Glow) */}
          <div className="rounded-3xl p-6 sm:p-8 border-2 border-[#28C76F]/40 bg-gradient-to-b from-[#28C76F]/[0.08] via-transparent to-[#7367F0]/[0.05] dark:from-[#28C76F]/[0.12] dark:to-transparent backdrop-blur-xl flex flex-col justify-between relative shadow-2xl shadow-[#28C76F]/10">
            <div>
              {/* Header */}
              <div className="flex items-center justify-between pb-6 border-b border-[#28C76F]/20">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-[#28C76F]/20 text-[#28C76F] flex items-center justify-center shadow-md shadow-[#28C76F]/20">
                    <Sparkles className="w-5 h-5 text-[#28C76F]" />
                  </div>
                  <div>
                    <h3 className="text-lg sm:text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                      <span>{t('landing.newWayTitle')}</span>
                    </h3>
                    <p className="text-xs text-[#28C76F] dark:text-[#52e591] font-semibold">
                      {t('landing.newWaySubtitle')}
                    </p>
                  </div>
                </div>

                <span className="px-3.5 py-1 rounded-xl text-[11px] font-black bg-[#28C76F] text-white shadow-md shadow-[#28C76F]/30 flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>{t('landing.newWayBadge')}</span>
                </span>
              </div>

              {/* Rows */}
              <div className="mt-6 space-y-6">
                {comparisonRows.map((row, idx) => (
                  <div key={idx} className="flex items-start gap-3.5 group">
                    <div className="w-6 h-6 rounded-lg bg-[#28C76F]/20 text-[#28C76F] flex items-center justify-center shrink-0 mt-0.5 shadow-sm shadow-[#28C76F]/20">
                      <Check className="w-3.5 h-3.5 stroke-[3]" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                        <span>{row.title}</span>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 font-medium leading-relaxed">
                        {row.newDesc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom Highlight CTA */}
            <div className="mt-8 pt-4 border-t border-[#28C76F]/20 flex flex-col sm:flex-row items-center justify-between gap-3">
              <span className="text-xs font-extrabold text-[#28C76F] dark:text-[#52e591] flex items-center gap-1.5">
                <Flame className="w-4 h-4 text-[#FF9F43]" />
                <span>{t('landing.compNewBottomSummary')}</span>
              </span>

              <button
                type="button"
                onClick={onGetStarted}
                className="w-full sm:w-auto min-h-[44px] px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#28C76F] to-[#1f9d57] hover:from-[#24b263] hover:to-[#1a8549] text-white text-xs sm:text-sm font-bold shadow-lg shadow-[#28C76F]/25 transition-all cursor-pointer flex items-center justify-center gap-2 active:scale-95 shrink-0"
              >
                <span>{t('landing.comparisonCtaBtn')}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>

        </div>

      </div>
    </section>
  );
};
