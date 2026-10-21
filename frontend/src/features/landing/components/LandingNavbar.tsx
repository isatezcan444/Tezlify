import React from 'react';
import { Sparkles, ArrowRight, Sun, Moon, LogIn } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { useTheme } from '../../../context/ThemeContext';
import { LanguageSwitcher } from '../../../components/ui/LanguageSwitcher';
import { useAuth } from '../../../context/AuthContext';

interface LandingNavbarProps {
  onGoToApp: () => void;
  onOpenLogin: () => void;
}

export const LandingNavbar: React.FC<LandingNavbarProps> = ({ onGoToApp, onOpenLogin }) => {
  const { t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();
  const isDark = theme === 'dark';

  return (
    <header className="sticky top-0 z-50 w-full landing-glass-nav transition-all duration-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 sm:h-20 flex items-center justify-between gap-4">
        {/* Brand Logo & Version Pill */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-gradient-to-tr from-[#7367F0] via-indigo-600 to-[#7367F0] text-white flex items-center justify-center font-black text-xl shadow-lg shadow-[#7367F0]/30 shrink-0">
            T
          </div>
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-xl sm:text-2xl text-slate-900 dark:text-white tracking-tight">
              Tezlify
            </span>
            <span className="hidden sm:inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#7367F0]/10 text-[#7367F0] dark:bg-[#7367F0]/20 dark:text-[#A59DF8] border border-[#7367F0]/20">
              <Sparkles className="w-3 h-3 animate-pulse" />
              {t('landing.pillNew')}
            </span>
          </div>
        </div>

        {/* Center Nav Anchors */}
        <nav className="hidden md:flex items-center gap-8 text-sm font-semibold text-slate-600 dark:text-slate-300">
          <a
            href="#features"
            className="hover:text-[#7367F0] dark:hover:text-[#A59DF8] transition-colors cursor-pointer"
          >
            {t('landing.navFeatures')}
          </a>
          <a
            href="#how-it-works"
            className="hover:text-[#7367F0] dark:hover:text-[#A59DF8] transition-colors cursor-pointer"
          >
            {t('landing.navHowItWorks')}
          </a>
          <a
            href="#pricing"
            className="hover:text-[#7367F0] dark:hover:text-[#A59DF8] transition-colors cursor-pointer"
          >
            {t('landing.navPricing')}
          </a>
          <a
            href="#faq"
            className="hover:text-[#7367F0] dark:hover:text-[#A59DF8] transition-colors cursor-pointer"
          >
            {t('landing.navFaq')}
          </a>
        </nav>

        {/* Right Actions: Lang, Theme, Login / App */}
        <div className="flex items-center gap-2 sm:gap-3">
          <LanguageSwitcher />

          <button
            type="button"
            onClick={toggleTheme}
            className="p-2 sm:p-2.5 rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-white/80 dark:bg-[#2F3349]/80 backdrop-blur text-slate-600 dark:text-slate-300 hover:text-[#7367F0] dark:hover:text-white transition-all shadow-sm cursor-pointer active:scale-95"
            title={isDark ? t('header.lightMode') : t('header.darkMode')}
            aria-label={isDark ? t('header.lightMode') : t('header.darkMode')}
          >
            {isDark ? (
              <Sun className="w-4 h-4 text-[#FF9F43]" />
            ) : (
              <Moon className="w-4 h-4 text-[#7367F0]" />
            )}
          </button>

          {user ? (
            <button
              type="button"
              onClick={onGoToApp}
              className="flex items-center gap-2 px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl bg-[#7367F0] hover:bg-[#685DD8] text-white text-xs sm:text-sm font-bold shadow-md shadow-[#7367F0]/30 transition-all cursor-pointer active:scale-95"
            >
              <span>{t('landing.goToDashboard')}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onOpenLogin}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-all cursor-pointer"
              >
                <LogIn className="w-4 h-4" />
                <span>{t('landing.login')}</span>
              </button>

              <button
                type="button"
                onClick={onOpenLogin}
                className="flex items-center gap-1.5 px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl bg-[#7367F0] hover:bg-[#685DD8] text-white text-xs sm:text-sm font-bold shadow-md shadow-[#7367F0]/30 transition-all cursor-pointer active:scale-95"
              >
                <span>{t('landing.getStarted')}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
