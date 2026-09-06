import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import { LanguageSwitcher } from '../components/ui/LanguageSwitcher';
import { 
  Sun, 
  Moon, 
  ArrowRight,
  Lock,
  Loader2,
  Sparkles,
  ShieldCheck,
  MapPin
} from 'lucide-react';

export const LoginPage: React.FC = () => {
  const { signInWithGoogle } = useAuth();
  const { t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const toast = useToast();
  const [isLoading, setIsLoading] = useState(false);

  const handleGoogleLogin = async () => {
    try {
      setIsLoading(true);
      await signInWithGoogle();
    } catch (err: any) {
      setIsLoading(false);
      toast.error(t('auth.loginError'));
    }
  };

  return (
    <div className="min-h-screen w-full relative flex items-center justify-center p-4 sm:p-6 bg-[#F8F7FA] dark:bg-[#25293C] text-[#4B465C] dark:text-[#DBD7EC] overflow-hidden transition-colors duration-200 select-none">
      {/* Dynamic Ambient Background Glows matching Vuexy Brand Palette */}
      <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#7367F0]/15 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -right-32 w-96 h-96 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />

      {/* Top Floating Controls: Language Switcher & Theme Toggle */}
      <div className="absolute top-4 sm:top-6 right-4 sm:right-6 flex items-center gap-2 z-20">
        <LanguageSwitcher />

        <button
          type="button"
          onClick={toggleTheme}
          className="p-2 rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-white/80 dark:bg-[#2F3349]/80 backdrop-blur text-slate-600 dark:text-slate-300 hover:text-[#7367F0] dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-all shadow-sm cursor-pointer active:scale-95"
          title={isDark ? t('header.lightMode') : t('header.darkMode')}
          aria-label={isDark ? t('header.lightMode') : t('header.darkMode')}
        >
          {isDark ? (
            <Sun className="w-4 h-4 text-[#FF9F43]" />
          ) : (
            <Moon className="w-4 h-4 text-[#7367F0]" />
          )}
        </button>
      </div>

      {/* Centered Vuexy Glassmorphism Card */}
      <div className="w-full max-w-[420px] sm:max-w-[450px] z-10 p-6 sm:p-9 rounded-2xl sm:rounded-3xl border border-slate-200/80 dark:border-white/[0.08] bg-white/95 dark:bg-[#2F3349]/95 backdrop-blur-xl shadow-2xl transition-all duration-200">
        {/* Brand Logo & Typography */}
        <div className="text-center flex flex-col items-center">
          <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-tr from-[#7367F0] via-indigo-600 to-[#7367F0] text-white flex items-center justify-center shadow-lg shadow-[#7367F0]/30 mb-3.5 transform transition-transform hover:scale-105 duration-200">
            <span className="text-2xl sm:text-3xl font-black tracking-tighter">T</span>
          </div>

          <h1 className="text-2xl sm:text-3xl font-black text-slate-800 dark:text-white tracking-tight">
            {t('auth.brandTitle')}
          </h1>

          <p className="text-xs sm:text-sm font-semibold text-[#7367F0] dark:text-[#A59DF8] mt-1">
            {t('auth.brandTagline')}
          </p>

          <p className="text-xs text-slate-500 dark:text-[#7E7F96] mt-2 max-w-xs leading-relaxed">
            {t('auth.loginPrompt')}
          </p>
        </div>

        {/* Divider */}
        <div className="my-6 flex items-center gap-3">
          <div className="h-[1px] flex-1 bg-slate-200 dark:bg-white/[0.08]" />
          <span className="text-[11px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider">
            {t('auth.badgeOAuth')}
          </span>
          <div className="h-[1px] flex-1 bg-slate-200 dark:bg-white/[0.08]" />
        </div>

        {/* Centered Google OAuth Sign-In Button */}
        <div className="space-y-4">
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={isLoading}
            className="w-full h-12 sm:h-13 px-4 sm:px-5 rounded-xl border border-slate-200 dark:border-white/[0.12] bg-white dark:bg-[#25293C] hover:bg-slate-50 dark:hover:bg-[#1E2235] text-slate-700 dark:text-slate-100 font-bold text-sm sm:text-base shadow-sm hover:shadow-lg hover:border-[#7367F0]/40 dark:hover:border-[#7367F0]/40 transition-all duration-200 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-3 cursor-pointer group"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 text-[#7367F0] animate-spin shrink-0" />
            ) : (
              /* Official Google 4-Color 'G' Logo */
              <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 10.04 0 12s.45 3.82 1.25 5.42l4.03-3.15z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                />
              </svg>
            )}

            <span>
              {isLoading ? t('auth.signingIn') : t('auth.signInWithGoogle')}
            </span>

            {!isLoading && (
              <ArrowRight className="w-4 h-4 ml-auto text-slate-400 group-hover:text-[#7367F0] group-hover:translate-x-1 transition-all" />
            )}
          </button>

          {/* SSL & Privacy Trust Badge */}
          <div className="flex items-center justify-center gap-1.5 text-[11px] font-medium text-slate-400 dark:text-[#7E7F96] pt-1 text-center">
            <Lock className="w-3.5 h-3.5 text-[#28C76F] shrink-0" />
            <span>{t('auth.securityNote')}</span>
          </div>
        </div>

        {/* Subtle Feature Pills */}
        <div className="mt-8 pt-5 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-primary-500/10 text-primary-600 dark:text-primary-400 border border-primary-500/20">
            <MapPin className="w-3 h-3 shrink-0" />
            <span>{t('auth.pillLeads')}</span>
          </div>

          <div className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <ShieldCheck className="w-3 h-3 shrink-0" />
            <span>{t('auth.pillAntiBan')}</span>
          </div>

          <div className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
            <Sparkles className="w-3 h-3 shrink-0" />
            <span>{t('auth.pillAutomation')}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
