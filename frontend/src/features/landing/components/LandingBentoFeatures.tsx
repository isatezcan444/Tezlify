import React from 'react';
import { 
  MapPin, 
  ShieldCheck, 
  MessageSquare, 
  Webhook, 
  CheckCircle2, 
  Clock, 
  Sliders, 
  Sparkles,
  ArrowRight,
  Zap
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

export const LandingBentoFeatures: React.FC = () => {
  const { t } = useI18n();

  return (
    <section id="features" className="py-20 sm:py-32 select-none relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl sm:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            {t('landing.bentoTitle')}
          </h2>

          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-400">
            {t('landing.bentoSubtitle')}
          </p>
        </div>

        {/* Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-6">
          {/* Card 1: Google Maps Scraper (lg:col-span-7) */}
          <div className="lg:col-span-7 landing-glass-card landing-card-glow rounded-3xl p-6 sm:p-8 flex flex-col justify-between overflow-hidden relative group">
            <div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-extrabold bg-blue-500/10 text-blue-500 mb-4">
                <MapPin className="w-3.5 h-3.5" />
                <span>{t('landing.bento1Badge')}</span>
              </div>

              <h3 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight">
                {t('landing.bento1Title')}
              </h3>

              <p className="mt-3 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
                {t('landing.bento1Desc')}
              </p>
            </div>

            {/* Visual Element: Mini Radar / District Progress */}
            <div className="mt-6 p-4 rounded-2xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] space-y-3">
              <div className="flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-300">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#28C76F] animate-ping" />
                  {t('landing.bentoVisualDistricts')}
                </span>
                <span className="font-mono text-[#7367F0]">{t('landing.bentoVisualLeadsFound')}</span>
              </div>

              <div className="space-y-2 text-[11px]">
                <div>
                  <div className="flex justify-between text-slate-500 dark:text-slate-400 mb-1">
                    <span>{t('landing.bentoVisualDistrict1')}</span>
                    <span className="font-bold text-[#28C76F]">{t('landing.bentoVisualDistrict1Status')}</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
                    <div className="w-full h-full bg-[#28C76F] rounded-full" />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-slate-500 dark:text-slate-400 mb-1">
                    <span>{t('landing.bentoVisualDistrict2')}</span>
                    <span className="font-bold text-[#7367F0]">{t('landing.bentoVisualDistrict2Status')}</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
                    <div className="w-[78%] h-full bg-[#7367F0] rounded-full animate-pulse" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: Anti-Ban Protection (lg:col-span-5) */}
          <div className="lg:col-span-5 landing-glass-card landing-card-glow rounded-3xl p-6 sm:p-8 flex flex-col justify-between overflow-hidden relative group">
            <div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-extrabold bg-emerald-500/10 text-emerald-500 mb-4">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>{t('landing.bento2Badge')}</span>
              </div>

              <h3 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight">
                {t('landing.bento2Title')}
              </h3>

              <p className="mt-3 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
                {t('landing.bento2Desc')}
              </p>
            </div>

            {/* Visual Element: Anti-Ban Control Widget */}
            <div className="mt-6 p-4 rounded-2xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-[#FF9F43]" />
                  {t('landing.bentoVisualHoursLabel')}
                </span>
                <span className="font-bold text-[#28C76F] px-2 py-0.5 rounded bg-[#28C76F]/10 text-[10px]">
                  {t('landing.bentoVisualHoursValue')}
                </span>
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-[#7367F0]" />
                  {t('landing.bentoVisualJitterLabel')}
                </span>
                <span className="font-mono text-slate-700 dark:text-slate-300 font-bold text-[11px]">
                  {t('landing.bentoVisualJitterValue')}
                </span>
              </div>
            </div>
          </div>

          {/* Card 3: WhatsApp Web Hub (lg:col-span-5) */}
          <div className="lg:col-span-5 landing-glass-card landing-card-glow rounded-3xl p-6 sm:p-8 flex flex-col justify-between overflow-hidden relative group">
            <div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-extrabold bg-[#7367F0]/10 text-[#7367F0] mb-4">
                <MessageSquare className="w-3.5 h-3.5" />
                <span>{t('landing.bento3Badge')}</span>
              </div>

              <h3 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight">
                {t('landing.bento3Title')}
              </h3>

              <p className="mt-3 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
                {t('landing.bento3Desc')}
              </p>
            </div>

            {/* Visual Element: Chat Snippet */}
            <div className="mt-6 p-4 rounded-2xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] space-y-2">
              <div className="p-2.5 rounded-xl bg-white dark:bg-[#2F3349] border border-slate-100 dark:border-white/[0.05] text-xs">
                <div className="text-[10px] font-bold text-[#7367F0] mb-0.5">{t('landing.bentoVisualBotLabel')}</div>
                <div className="text-slate-700 dark:text-slate-300">
                  {t('landing.bentoVisualBotMsg')}
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-[#28C76F]/10 text-xs border border-[#28C76F]/20">
                <div className="text-[10px] font-bold text-[#28C76F] mb-0.5">{t('landing.bentoVisualClientLabel')}</div>
                <div className="text-slate-800 dark:text-slate-100 font-semibold">
                  {t('landing.bentoVisualClientMsg')}
                </div>
              </div>
            </div>
          </div>

          {/* Card 4: Webhook & CRM Bridge (lg:col-span-7) */}
          <div className="lg:col-span-7 landing-glass-card landing-card-glow rounded-3xl p-6 sm:p-8 flex flex-col justify-between overflow-hidden relative group">
            <div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-extrabold bg-[#FF9F43]/10 text-[#FF9F43] mb-4">
                <Webhook className="w-3.5 h-3.5" />
                <span>{t('landing.bento4Badge')}</span>
              </div>

              <h3 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight">
                {t('landing.bento4Title')}
              </h3>

              <p className="mt-3 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
                {t('landing.bento4Desc')}
              </p>
            </div>

            {/* Visual Element: Integration Connector Flow */}
            <div className="mt-6 p-4 rounded-2xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between gap-2 overflow-x-auto">
              <div className="px-3 py-2 rounded-xl bg-white dark:bg-[#2F3349] border border-slate-200 dark:border-white/[0.08] text-xs font-bold text-slate-700 dark:text-slate-200 shrink-0">
                {t('landing.bentoVisualFormStep')}
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
              <div className="px-3.5 py-2 rounded-xl bg-[#7367F0] text-white text-xs font-bold shadow-md shadow-[#7367F0]/30 shrink-0">
                {t('landing.bentoVisualEngineStep')}
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
              <div className="px-3 py-2 rounded-xl bg-white dark:bg-[#2F3349] border border-slate-200 dark:border-white/[0.08] text-xs font-bold text-slate-700 dark:text-slate-200 shrink-0">
                {t('landing.bentoVisualCrmStep')}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
