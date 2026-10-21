import React, { useState } from 'react';
import { Check, Sparkles, ArrowRight, Zap } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

interface LandingPricingProps {
  onSelectPlan: (tier: string) => void;
}

export const LandingPricing: React.FC<LandingPricingProps> = ({ onSelectPlan }) => {
  const { t } = useI18n();
  const [isAnnual, setIsAnnual] = useState(false);

  const plans = [
    {
      id: 'STARTER',
      name: t('landing.starterTitle'),
      desc: t('landing.starterDesc'),
      priceMonthly: '1.490',
      priceAnnual: '1.190',
      features: [
        t('landing.planStarterFeat1'),
        t('landing.planStarterFeat2'),
        t('landing.planStarterFeat3'),
        t('landing.planStarterFeat4'),
        t('landing.planStarterFeat5'),
        t('landing.planStarterFeat6'),
      ],
      popular: false,
      buttonVariant: 'secondary',
    },
    {
      id: 'PRO',
      name: t('landing.proTitle'),
      desc: t('landing.proDesc'),
      priceMonthly: '3.490',
      priceAnnual: '2.790',
      features: [
        t('landing.planProFeat1'),
        t('landing.planProFeat2'),
        t('landing.planProFeat3'),
        t('landing.planProFeat4'),
        t('landing.planProFeat5'),
        t('landing.planProFeat6'),
        t('landing.planProFeat7'),
        t('landing.planProFeat8'),
      ],
      popular: true,
      buttonVariant: 'primary',
    },
    {
      id: 'AGENCY',
      name: t('landing.enterpriseTitle'),
      desc: t('landing.enterpriseDesc'),
      priceMonthly: '7.990',
      priceAnnual: '6.390',
      features: [
        t('landing.planAgencyFeat1'),
        t('landing.planAgencyFeat2'),
        t('landing.planAgencyFeat3'),
        t('landing.planAgencyFeat4'),
        t('landing.planAgencyFeat5'),
        t('landing.planAgencyFeat6'),
        t('landing.planAgencyFeat7'),
      ],
      popular: false,
      buttonVariant: 'secondary',
    },
  ];

  return (
    <section id="pricing" className="py-20 sm:py-32 select-none relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-[#7367F0]/10 text-[#7367F0] dark:bg-[#7367F0]/20 dark:text-[#A59DF8] mb-4">
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t('landing.navPricing')}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            {t('landing.pricingTitle')}
          </h2>

          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-400">
            {t('landing.pricingSubtitle')}
          </p>

          {/* Billing Switcher (Monthly / Annual) */}
          <div className="mt-8 inline-flex items-center p-1.5 rounded-2xl bg-slate-100 dark:bg-[#2F3349] border border-slate-200/80 dark:border-white/[0.08] shadow-inner max-w-full">
            <button
              type="button"
              onClick={() => setIsAnnual(false)}
              className={`px-3.5 sm:px-5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                !isAnnual
                  ? 'bg-white dark:bg-[#25293C] text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {t('landing.billingMonthly')}
            </button>

            <button
              type="button"
              onClick={() => setIsAnnual(true)}
              className={`flex items-center gap-1.5 sm:gap-2 px-3.5 sm:px-5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                isAnnual
                  ? 'bg-white dark:bg-[#25293C] text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <span>{t('landing.billingAnnual')}</span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-[#28C76F]/10 text-[#28C76F] border border-[#28C76F]/20">
                {t('landing.annualDiscountBadge')}
              </span>
            </button>
          </div>
        </div>

        {/* Pricing Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-stretch">
          {plans.map((p) => {
            const price = isAnnual ? p.priceAnnual : p.priceMonthly;

            return (
              <div
                key={p.id}
                className={`rounded-3xl p-6 sm:p-8 flex flex-col justify-between transition-all duration-300 relative landing-card-glow ${
                  p.popular
                    ? 'landing-glass-card border-2 border-[#7367F0] dark:border-[#7367F0] shadow-2xl shadow-[#7367F0]/15 md:scale-[1.02] z-10'
                    : 'landing-glass-card border border-slate-200/80 dark:border-white/[0.08]'
                }`}
              >
                {/* Popular Ribbon */}
                {p.popular && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-[11px] font-black uppercase tracking-wider bg-gradient-to-r from-[#7367F0] to-indigo-600 text-white shadow-md shadow-[#7367F0]/40 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3" />
                    <span>{t('landing.mostPopular')}</span>
                  </div>
                )}

                <div>
                  <h3 className="text-xl font-extrabold text-slate-900 dark:text-white">
                    {p.name}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 min-h-[32px]">
                    {p.desc}
                  </p>

                  {/* Price */}
                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="text-sm font-bold text-slate-500">₺</span>
                    <span className="text-4xl sm:text-5xl font-black text-slate-900 dark:text-white tracking-tight">
                      {price}
                    </span>
                    <span className="text-xs font-semibold text-slate-400">
                      {t('billing.perMonth')}
                    </span>
                  </div>

                  {/* Feature Checklist */}
                  <div className="mt-8 space-y-3.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                      {t('billing.featuresIncluded')}
                    </div>
                    {p.features.map((feat, fIdx) => (
                      <div key={fIdx} className="flex items-start gap-2.5 text-xs text-slate-700 dark:text-slate-300">
                        <div className="p-0.5 rounded-full bg-[#28C76F]/10 text-[#28C76F] mt-0.5 shrink-0">
                          <Check className="w-3.5 h-3.5 stroke-[3]" />
                        </div>
                        <span>{feat}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Card CTA Button */}
                <div className="mt-8 pt-4 border-t border-slate-100 dark:border-white/[0.05]">
                  <button
                    type="button"
                    onClick={() => onSelectPlan(p.id)}
                    className={`w-full h-12 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer active:scale-95 ${
                      p.popular
                        ? 'bg-[#7367F0] hover:bg-[#685DD8] text-white shadow-lg shadow-[#7367F0]/30 hover:shadow-xl'
                        : 'border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#2F3349] hover:bg-slate-50 dark:hover:bg-[#363B53] text-slate-800 dark:text-slate-200'
                    }`}
                  >
                    <span>{t('landing.getStarted')}</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
