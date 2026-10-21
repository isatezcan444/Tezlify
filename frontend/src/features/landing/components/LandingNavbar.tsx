import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  ArrowRight,
  Sun,
  Moon,
  LogIn,
  Menu,
  X,
  Layers,
  HelpCircle,
  Zap,
  Tag
} from 'lucide-react';
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
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const isDark = theme === 'dark';

  // Lock background scroll when mobile menu is open and listen for Esc key
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setIsMobileMenuOpen(false);
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => {
        document.body.style.overflow = '';
        window.removeEventListener('keydown', handleKeyDown);
      };
    } else {
      document.body.style.overflow = '';
    }
  }, [isMobileMenuOpen]);

  const handleNavClick = (anchorId: string) => {
    setIsMobileMenuOpen(false);
    const el = document.getElementById(anchorId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <header className="sticky top-0 z-50 w-full landing-glass-nav transition-all duration-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 sm:h-20 flex items-center justify-between gap-3">
        {/* Brand Logo & Version Pill */}
        <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
          <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-gradient-to-tr from-[#7367F0] via-indigo-600 to-[#7367F0] text-white flex items-center justify-center font-black text-lg sm:text-xl shadow-lg shadow-[#7367F0]/30 shrink-0">
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

        {/* Center Nav Anchors (Desktop lg+) */}
        <nav className="hidden lg:flex items-center gap-6 xl:gap-8 text-sm font-semibold text-slate-600 dark:text-slate-300">
          <a
            href="#features"
            onClick={(e) => {
              e.preventDefault();
              handleNavClick('features');
            }}
            className="hover:text-[#7367F0] dark:hover:text-[#A59DF8] transition-colors cursor-pointer"
          >
            {t('landing.navFeatures')}
          </a>
          <a
            href="#how-it-works"
            onClick={(e) => {
              e.preventDefault();
              handleNavClick('how-it-works');
            }}
            className="hover:text-[#7367F0] dark:hover:text-[#A59DF8] transition-colors cursor-pointer"
          >
            {t('landing.navHowItWorks')}
          </a>
          <a
            href="#pricing"
            onClick={(e) => {
              e.preventDefault();
              handleNavClick('pricing');
            }}
            className="hover:text-[#7367F0] dark:hover:text-[#A59DF8] transition-colors cursor-pointer"
          >
            {t('landing.navPricing')}
          </a>
          <a
            href="#faq"
            onClick={(e) => {
              e.preventDefault();
              handleNavClick('faq');
            }}
            className="hover:text-[#7367F0] dark:hover:text-[#A59DF8] transition-colors cursor-pointer"
          >
            {t('landing.navFaq')}
          </a>
        </nav>

        {/* Desktop Right Actions (lg+) */}
        <div className="hidden lg:flex items-center gap-3 shrink-0">
          <LanguageSwitcher />

          <button
            type="button"
            onClick={toggleTheme}
            className="w-10 h-10 rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-white/80 dark:bg-[#2F3349]/80 backdrop-blur text-slate-600 dark:text-slate-300 hover:text-[#7367F0] dark:hover:text-white transition-all shadow-sm cursor-pointer active:scale-95 flex items-center justify-center"
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
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#7367F0] hover:bg-[#685DD8] text-white text-sm font-bold shadow-md shadow-[#7367F0]/30 transition-all cursor-pointer active:scale-95"
            >
              <span>{t('landing.goToDashboard')}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onOpenLogin}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-all cursor-pointer"
              >
                <LogIn className="w-4 h-4" />
                <span>{t('landing.login')}</span>
              </button>

              <button
                type="button"
                onClick={onOpenLogin}
                className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-[#7367F0] hover:bg-[#685DD8] text-white text-sm font-bold shadow-md shadow-[#7367F0]/30 transition-all cursor-pointer active:scale-95"
              >
                <span>{t('landing.getStarted')}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Mobile / Tablet Compact Action Bar (< lg) */}
        <div className="flex lg:hidden items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={toggleTheme}
            className="w-10 h-10 rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-white/80 dark:bg-[#2F3349]/80 text-slate-600 dark:text-slate-300 flex items-center justify-center cursor-pointer active:scale-95"
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
              className="h-10 px-3.5 rounded-xl bg-[#7367F0] text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-[#7367F0]/25 cursor-pointer active:scale-95"
            >
              <span>{t('landing.goToDashboard')}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenLogin}
              className="h-10 px-3.5 rounded-xl bg-[#7367F0] text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-[#7367F0]/25 cursor-pointer active:scale-95"
            >
              <span>{t('landing.getStarted')}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Hamburger Menu Toggle Button */}
          <button
            type="button"
            data-testid="mobile-nav-toggle"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="w-10 h-10 rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-white/80 dark:bg-[#2F3349]/80 text-slate-700 dark:text-slate-200 hover:text-[#7367F0] dark:hover:text-[#A59DF8] flex items-center justify-center transition-colors cursor-pointer"
            aria-label={isMobileMenuOpen ? t('landing.mobileMenuClose') : t('landing.mobileMenuOpen')}
            aria-expanded={isMobileMenuOpen}
          >
            {isMobileMenuOpen ? (
              <X className="w-5 h-5" />
            ) : (
              <Menu className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>

      {/* Accessible Mobile Drawer Dropdown */}
      {isMobileMenuOpen && (
        <div className="fixed inset-0 top-16 sm:top-20 z-40 bg-slate-900/60 backdrop-blur-sm lg:hidden animate-fade-in flex flex-col justify-start">
          <div
            className="w-full bg-white dark:bg-[#25293C] border-b border-slate-200/80 dark:border-white/[0.1] shadow-2xl p-5 sm:p-6 space-y-5 animate-slide-down max-h-[calc(100vh-5rem)] overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-label="Mobile Navigation"
          >
            {/* Nav Links */}
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => handleNavClick('features')}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-[#7367F0]/10 text-[#7367F0] flex items-center justify-center shrink-0">
                  <Layers className="w-4 h-4" />
                </div>
                <span>{t('landing.navFeatures')}</span>
              </button>

              <button
                type="button"
                onClick={() => handleNavClick('how-it-works')}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-[#00CFE8]/10 text-[#00CFE8] flex items-center justify-center shrink-0">
                  <Zap className="w-4 h-4" />
                </div>
                <span>{t('landing.navHowItWorks')}</span>
              </button>

              <button
                type="button"
                onClick={() => handleNavClick('pricing')}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-[#28C76F]/10 text-[#28C76F] flex items-center justify-center shrink-0">
                  <Tag className="w-4 h-4" />
                </div>
                <span>{t('landing.navPricing')}</span>
              </button>

              <button
                type="button"
                onClick={() => handleNavClick('faq')}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-[#FF9F43]/10 text-[#FF9F43] flex items-center justify-center shrink-0">
                  <HelpCircle className="w-4 h-4" />
                </div>
                <span>{t('landing.navFaq')}</span>
              </button>
            </div>

            {/* Language & Extra Setting */}
            <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                {t('settings.language')}
              </span>
              <LanguageSwitcher />
            </div>

            {/* Actions in Drawer */}
            <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] space-y-2">
              {user ? (
                <button
                  type="button"
                  onClick={() => {
                    setIsMobileMenuOpen(false);
                    onGoToApp();
                  }}
                  className="w-full h-12 rounded-xl bg-[#7367F0] text-white text-sm font-bold shadow-md shadow-[#7367F0]/30 flex items-center justify-center gap-2 cursor-pointer active:scale-95"
                >
                  <span>{t('landing.goToDashboard')}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      onOpenLogin();
                    }}
                    className="w-full h-12 rounded-xl bg-[#7367F0] text-white text-sm font-bold shadow-md shadow-[#7367F0]/30 flex items-center justify-center gap-2 cursor-pointer active:scale-95"
                  >
                    <span>{t('landing.getStarted')}</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      onOpenLogin();
                    }}
                    className="w-full h-12 rounded-xl border border-slate-200 dark:border-white/[0.1] text-slate-800 dark:text-slate-100 text-sm font-bold flex items-center justify-center gap-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-white/[0.05]"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>{t('landing.login')}</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
