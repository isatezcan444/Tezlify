import React from 'react';
import { Sparkles, ShieldCheck, Heart } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

export const LandingFooter: React.FC = () => {
  const { t } = useI18n();

  return (
    <footer className="border-t border-slate-200/80 dark:border-white/[0.08] bg-white/60 dark:bg-[#1E2235]/60 backdrop-blur select-none py-12 sm:py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6 sm:gap-8 pb-8 border-b border-slate-200/60 dark:border-white/[0.05]">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-[#7367F0] via-indigo-600 to-[#7367F0] text-white flex items-center justify-center font-black text-lg shadow-md shadow-[#7367F0]/30">
              T
            </div>
            <div>
              <span className="font-extrabold text-lg text-slate-900 dark:text-white tracking-tight">
                Tezlify
              </span>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('landing.footerTagline')}
              </p>
            </div>
          </div>

          {/* System Status Indicator */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-100 dark:bg-white/[0.04] border border-slate-200/80 dark:border-white/[0.08] text-xs font-semibold text-slate-700 dark:text-slate-300">
            <span className="w-2 h-2 rounded-full bg-[#28C76F] animate-pulse" />
            <span>{t('landing.footerOperational')}</span>
          </div>

          {/* Links */}
          <div className="flex items-center gap-6 text-xs font-semibold text-slate-500 dark:text-slate-400">
            <a href="#features" className="hover:text-[#7367F0] transition-colors">
              {t('landing.navFeatures')}
            </a>
            <a href="#pricing" className="hover:text-[#7367F0] transition-colors">
              {t('landing.navPricing')}
            </a>
            <a href="#faq" className="hover:text-[#7367F0] transition-colors">
              {t('landing.navFaq')}
            </a>
            <a href="/docs" target="_blank" rel="noopener noreferrer" className="hover:text-[#7367F0] transition-colors">
              REST API
            </a>
          </div>
        </div>

        {/* Copyright */}
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-400 dark:text-slate-500">
          <div>
            © {new Date().getFullYear()} Tezlify. {t('landing.footerRights')}
          </div>
          <div className="flex items-center gap-1">
            <span>Enterprise B2B Lead & WhatsApp Engine</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
