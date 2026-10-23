import React from 'react';
import { 
  ArrowRight, 
  Sparkles, 
  Play, 
  MapPin, 
  CheckCircle2, 
  ShieldCheck, 
  Users, 
  MessageSquare,
  Search,
  Filter,
  Check
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

interface LandingHeroProps {
  onGetStarted: () => void;
  onExploreDemo: () => void;
}

export const LandingHero: React.FC<LandingHeroProps> = ({ onGetStarted, onExploreDemo }) => {
  const { t } = useI18n();

  return (
    <section className="relative pt-12 sm:pt-20 pb-20 sm:pb-32 overflow-hidden select-none">
      {/* Radial Glow Background */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-[600px] landing-ambient-glow pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10 flex flex-col items-center text-center">
        {/* Hero Headline with Instrument Serif Italic Touch */}
        <h1 className="max-w-4xl text-3xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold text-slate-900 dark:text-white tracking-tight leading-[1.15] sm:leading-[1.1]">
          {t('landing.heroTitlePrefix')}{' '}
          <span className="font-serif italic font-normal text-shimmer pr-2">
            {t('landing.heroTitleHighlight')}
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mt-5 sm:mt-6 max-w-2xl text-sm sm:text-lg lg:text-xl text-slate-600 dark:text-slate-300 leading-relaxed font-normal">
          {t('landing.heroSubtitle')}
        </p>

        {/* Action Buttons */}
        <div className="mt-8 sm:mt-10 flex flex-col sm:flex-row items-center gap-3 sm:gap-4 w-full sm:w-auto">
          <button
            type="button"
            onClick={onGetStarted}
            className="w-full sm:w-auto min-h-[48px] h-12 sm:h-13 px-6 sm:px-8 rounded-2xl bg-[#7367F0] hover:bg-[#685DD8] text-white font-bold text-sm sm:text-base shadow-xl shadow-[#7367F0]/30 hover:shadow-2xl hover:shadow-[#7367F0]/40 transition-all duration-200 flex items-center justify-center gap-3 cursor-pointer active:scale-95 group"
          >
            <span>{t('landing.ctaPrimary')}</span>
            <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5 group-hover:translate-x-1 transition-transform" />
          </button>

          <button
            type="button"
            onClick={onExploreDemo}
            className="w-full sm:w-auto min-h-[48px] h-12 sm:h-13 px-6 sm:px-7 rounded-2xl border border-slate-200 dark:border-white/[0.1] bg-white/80 dark:bg-[#2F3349]/80 backdrop-blur hover:bg-slate-100 dark:hover:bg-[#363B53] text-slate-700 dark:text-slate-200 font-bold text-sm sm:text-base shadow-sm transition-all duration-200 flex items-center justify-center gap-2.5 cursor-pointer active:scale-95"
          >
            <Play className="w-4 h-4 fill-current text-[#7367F0]" />
            <span>{t('landing.ctaSecondary')}</span>
          </button>
        </div>

        {/* Floating 3D/Perspective Dashboard Mockup Frame */}
        <div className="mt-12 sm:mt-20 w-full max-w-5xl relative">
          {/* Ambient Glow underneath dashboard */}
          <div className="absolute inset-x-8 sm:inset-x-20 -bottom-10 h-32 bg-gradient-to-r from-[#7367F0]/30 via-indigo-500/20 to-[#00CFE8]/30 blur-3xl pointer-events-none" />

          {/* Floating Telemetry Pill 1 (Top Left / Right) */}
          <div className="hidden xl:flex absolute -top-6 -left-6 z-20 items-center gap-3 px-4 py-3 rounded-2xl bg-white/95 dark:bg-[#2F3349]/95 border border-slate-200/80 dark:border-white/[0.1] shadow-2xl backdrop-blur-xl animate-float-gentle">
            <div className="w-10 h-10 rounded-xl bg-[#28C76F]/10 text-[#28C76F] flex items-center justify-center">
              <Users className="w-5 h-5" />
            </div>
            <div className="text-left">
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                {t('landing.heroLiveLeadStream')}
              </div>
              <div className="text-sm font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[#28C76F] animate-ping" />
                {t('landing.heroNewBusinessesCount')}
              </div>
            </div>
          </div>

          {/* Floating Telemetry Pill 2 (Bottom Right) */}
          <div className="hidden xl:flex absolute -bottom-6 -right-6 z-20 items-center gap-3 px-4 py-3 rounded-2xl bg-white/95 dark:bg-[#2F3349]/95 border border-slate-200/80 dark:border-white/[0.1] shadow-2xl backdrop-blur-xl animate-float-delayed">
            <div className="w-10 h-10 rounded-xl bg-[#7367F0]/10 text-[#7367F0] flex items-center justify-center">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="text-left">
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                {t('landing.heroAntibanAlgorithm')}
              </div>
              <div className="text-sm font-extrabold text-[#28C76F] flex items-center gap-1">
                <Check className="w-4 h-4 stroke-[3]" />
                {t('landing.heroSafeWorkingHours')}
              </div>
            </div>
          </div>

          {/* Dashboard Canvas Container */}
          <div className="rounded-2xl sm:rounded-3xl border border-slate-200/80 dark:border-white/[0.12] bg-white dark:bg-[#25293C] shadow-2xl overflow-hidden text-left transition-all duration-300">
            {/* macOS Window Title Bar */}
            <div className="px-4 py-3 bg-slate-100/80 dark:bg-[#1E2235]/90 border-b border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-[#EA5455]" />
                <div className="w-3 h-3 rounded-full bg-[#FF9F43]" />
                <div className="w-3 h-3 rounded-full bg-[#28C76F]" />
              </div>
              <div className="text-xs font-semibold text-slate-400 dark:text-slate-400 flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-[#7367F0]" />
                <span>Tezlify v2.5 • B2B Lead & WhatsApp Engine</span>
              </div>
              <div className="w-12" />
            </div>

            {/* Dashboard Inner Teaser */}
            <div className="p-4 sm:p-6 space-y-4 sm:space-y-6 bg-slate-50/50 dark:bg-[#25293C]">
              {/* Fake Search Bar */}
              <div className="p-3 sm:p-4 rounded-xl bg-white dark:bg-[#2F3349] border border-slate-200/80 dark:border-white/[0.08] shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="flex items-center gap-3 w-full">
                  <div className="p-2 rounded-lg bg-[#7367F0]/10 text-[#7367F0] shrink-0">
                    <Search className="w-4 h-4" />
                  </div>
                  <div className="text-left min-w-0">
                    <div className="text-xs font-bold text-slate-800 dark:text-slate-200 flex flex-wrap items-center gap-2">
                      <span>{t('landing.heroMockupLocation')}</span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#28C76F]/10 text-[#28C76F]">
                        {t('landing.heroMockupLiveScanning')}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {t('landing.heroMockupSubtext')}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-between sm:justify-end">
                  <span className="text-xs font-semibold text-slate-500">{t('landing.heroMockupResultCount')}</span>
                  <div className="px-3 py-1.5 rounded-lg bg-[#7367F0] text-white text-xs font-bold shadow-sm flex items-center gap-1.5">
                    <Filter className="w-3.5 h-3.5" />
                    {t('landing.heroMockupFilterWhatsapp')}
                  </div>
                </div>
              </div>

              {/* Sample Lead Table Mockup (with responsive overflow support) */}
              <div className="rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] overflow-x-auto scrollbar-none shadow-sm">
                <div className="min-w-[460px] sm:min-w-0">
                  <div className="grid grid-cols-12 gap-2 p-3 text-[11px] font-extrabold uppercase tracking-wider text-slate-400 border-b border-slate-200/80 dark:border-white/[0.08]">
                    <div className="col-span-5 sm:col-span-4">{t('landing.heroMockupThBusiness')}</div>
                    <div className="col-span-4 sm:col-span-3">{t('landing.heroMockupThPhone')}</div>
                    <div className="hidden sm:block sm:col-span-3">{t('landing.heroMockupThStatus')}</div>
                    <div className="col-span-3 sm:col-span-2 text-right">{t('landing.heroMockupThAction')}</div>
                  </div>

                {/* Rows */}
                <div className="divide-y divide-slate-100 dark:divide-white/[0.05] text-xs">
                  <div className="grid grid-cols-12 gap-2 p-3 items-center hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors">
                    <div className="col-span-5 sm:col-span-4 font-bold text-slate-800 dark:text-white flex items-center gap-2 truncate">
                      <div className="w-2 h-2 rounded-full bg-[#28C76F]" />
                      <span className="truncate">{t('landing.heroMockupBiz1')}</span>
                    </div>
                    <div className="col-span-4 sm:col-span-3 font-mono text-slate-600 dark:text-slate-300 text-[11px]">
                      +90 532 412 88**
                    </div>
                    <div className="hidden sm:flex sm:col-span-3 items-center gap-1.5 text-[#28C76F] font-bold text-[11px]">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {t('landing.heroMockupVerifiedEligible')}
                    </div>
                    <div className="col-span-3 sm:col-span-2 text-right">
                      <span className="px-2 py-1 rounded-md text-[10px] font-bold bg-[#7367F0]/10 text-[#7367F0]">
                        {t('landing.heroMockupPersonalized')}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-12 gap-2 p-3 items-center hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors">
                    <div className="col-span-5 sm:col-span-4 font-bold text-slate-800 dark:text-white flex items-center gap-2 truncate">
                      <div className="w-2 h-2 rounded-full bg-[#28C76F]" />
                      <span className="truncate">{t('landing.heroMockupBiz2')}</span>
                    </div>
                    <div className="col-span-4 sm:col-span-3 font-mono text-slate-600 dark:text-slate-300 text-[11px]">
                      +90 544 892 14**
                    </div>
                    <div className="hidden sm:flex sm:col-span-3 items-center gap-1.5 text-[#28C76F] font-bold text-[11px]">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {t('landing.heroMockupVerifiedEligible')}
                    </div>
                    <div className="col-span-3 sm:col-span-2 text-right">
                      <span className="px-2 py-1 rounded-md text-[10px] font-bold bg-[#28C76F]/10 text-[#28C76F]">
                        {t('landing.heroMockupDeliveredTime')}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-12 gap-2 p-3 items-center hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors">
                    <div className="col-span-5 sm:col-span-4 font-bold text-slate-800 dark:text-white flex items-center gap-2 truncate">
                      <div className="w-2 h-2 rounded-full bg-[#00CFE8]" />
                      <span className="truncate">{t('landing.heroMockupBiz3')}</span>
                    </div>
                    <div className="col-span-4 sm:col-span-3 font-mono text-slate-600 dark:text-slate-300 text-[11px]">
                      +90 555 780 33**
                    </div>
                    <div className="hidden sm:flex sm:col-span-3 items-center gap-1.5 text-[#00CFE8] font-bold text-[11px]">
                      <MessageSquare className="w-3.5 h-3.5" />
                      {t('landing.heroMockupReplied')}
                    </div>
                    <div className="col-span-3 sm:col-span-2 text-right">
                      <span className="px-2 py-1 rounded-md text-[10px] font-bold bg-[#00CFE8]/10 text-[#00CFE8]">
                        {t('landing.heroMockupGoToChat')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </section>
  );
};
