import React, { useState } from 'react';
import { ChevronDown, HelpCircle, Sparkles } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

export const LandingFAQ: React.FC = () => {
  const { t } = useI18n();
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  const faqs = [
    {
      q: t('landing.faq1Q'),
      a: t('landing.faq1A'),
    },
    {
      q: t('landing.faq2Q'),
      a: t('landing.faq2A'),
    },
    {
      q: t('landing.faq3Q'),
      a: t('landing.faq3A'),
    },
    {
      q: t('landing.faq4Q'),
      a: t('landing.faq4A'),
    },
    {
      q: t('landing.faq5Q'),
      a: t('landing.faq5A'),
    },
  ];

  return (
    <section id="faq" className="py-20 sm:py-32 select-none relative border-t border-slate-200/80 dark:border-white/[0.08]">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-[#7367F0]/10 text-[#7367F0] dark:bg-[#7367F0]/20 dark:text-[#A59DF8] mb-4">
            <HelpCircle className="w-3.5 h-3.5" />
            <span>{t('landing.navFaq')}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            {t('landing.faqTitle')}
          </h2>

          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-400">
            {t('landing.faqSubtitle')}
          </p>
        </div>

        {/* Accordion List */}
        <div className="space-y-4">
          {faqs.map((f, idx) => {
            const isOpen = openIdx === idx;

            return (
              <div
                key={idx}
                className="landing-glass-card rounded-2xl overflow-hidden border border-slate-200/80 dark:border-white/[0.08] transition-all"
              >
                <button
                  type="button"
                  id={`faq-question-${idx}`}
                  aria-expanded={isOpen}
                  aria-controls={`faq-answer-${idx}`}
                  onClick={() => setOpenIdx(isOpen ? null : idx)}
                  className="w-full p-4 sm:p-6 text-left flex items-center justify-between gap-3 sm:gap-4 cursor-pointer"
                >
                  <span className="text-sm sm:text-base font-bold text-slate-900 dark:text-white leading-snug">
                    {f.q}
                  </span>
                  <div
                    className={`p-1.5 rounded-lg bg-slate-100 dark:bg-white/[0.05] text-slate-500 transition-transform duration-200 shrink-0 ${
                      isOpen ? 'rotate-180 text-[#7367F0]' : ''
                    }`}
                  >
                    <ChevronDown className="w-4 h-4" />
                  </div>
                </button>

                {isOpen && (
                  <div
                    id={`faq-answer-${idx}`}
                    role="region"
                    aria-labelledby={`faq-question-${idx}`}
                    className="px-4 sm:px-6 pb-5 sm:pb-6 text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed border-t border-slate-100 dark:border-white/[0.04] pt-4 animate-fade-in"
                  >
                    {f.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
