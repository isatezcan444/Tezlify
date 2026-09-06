import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import { 
  Sparkles, 
  MapPin, 
  ShieldCheck, 
  Users, 
  Sun, 
  Moon, 
  Languages, 
  ArrowRight,
  Lock
} from 'lucide-react';

export const LoginPage: React.FC = () => {
  const { signInWithGoogle } = useAuth();
  const { t, language, setLanguage } = useI18n();
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
    <div className="min-h-screen w-full relative flex items-center justify-center p-4 sm:p-6 lg:p-8 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden transition-colors duration-300">
      {/* Dynamic Background Glowing Orbs */}
      <div className="absolute top-[-10%] left-[-10%] w-[45vw] h-[45vw] rounded-full bg-gradient-to-br from-primary-500/20 via-indigo-500/15 to-transparent blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-15%] right-[-10%] w-[50vw] h-[50vw] rounded-full bg-gradient-to-tl from-emerald-500/15 via-teal-500/10 to-transparent blur-3xl pointer-events-none" />

      {/* Top Controls: Theme & Language */}
      <div className="absolute top-6 right-6 flex items-center gap-2 z-20">
        <button
          type="button"
          onClick={() => setLanguage(language === 'tr' ? 'en' : 'tr')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/70 backdrop-blur text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all shadow-sm"
          title="Change language"
        >
          <Languages className="w-3.5 h-3.5 text-primary-500" />
          <span>{language.toUpperCase()}</span>
        </button>

        <button
          type="button"
          onClick={toggleTheme}
          className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/70 backdrop-blur text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all shadow-sm"
          title={isDark ? 'Light Mode' : 'Dark Mode'}
        >
          {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-600" />}
        </button>
      </div>

      {/* Main Container */}
      <div className="w-full max-w-5xl z-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
        
        {/* Left Showcase (Desktop) */}
        <div className="lg:col-span-7 flex flex-col justify-center space-y-6">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary-500/30 bg-primary-500/10 text-primary-600 dark:text-primary-400 text-xs font-semibold w-fit">
            <Sparkles className="w-4 h-4" />
            <span>Tezlify B2B Growth Engine</span>
          </div>

          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight leading-tight">
            Müşteri Bulmanın &amp; <br />
            <span className="bg-gradient-to-r from-primary-600 via-indigo-600 to-teal-500 bg-clip-text text-transparent">
              Satışa Dönüştürmenin
            </span>{' '}
            En Hızlı Yolu
          </h1>

          <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 max-w-xl leading-relaxed">
            {t('auth.welcomeSubtitle')}
          </p>

          {/* Feature Highlights Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-2">
            <div className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800/80 bg-white/60 dark:bg-slate-900/60 backdrop-blur-md flex items-start gap-3.5 shadow-sm">
              <div className="p-2.5 rounded-lg bg-primary-500/10 text-primary-600 dark:text-primary-400">
                <MapPin className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  {t('auth.featureLeadFinder')}
                </h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-snug">
                  {t('auth.featureLeadFinderDesc')}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800/80 bg-white/60 dark:bg-slate-900/60 backdrop-blur-md flex items-start gap-3.5 shadow-sm">
              <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  {t('auth.featureAntiBan')}
                </h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-snug">
                  {t('auth.featureAntiBanDesc')}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800/80 bg-white/60 dark:bg-slate-900/60 backdrop-blur-md flex items-start gap-3.5 shadow-sm sm:col-span-2">
              <div className="p-2.5 rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400">
                <Users className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  {t('auth.featureCrm')}
                </h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-snug">
                  {t('auth.featureCrmDesc')}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Login Box */}
        <div className="lg:col-span-5 flex justify-center">
          <div className="w-full max-w-md p-8 sm:p-10 rounded-2xl border border-slate-200/90 dark:border-slate-800/90 bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl shadow-2xl space-y-6">
            
            {/* Brand Logo & Header */}
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-tr from-primary-600 to-indigo-500 text-white shadow-lg shadow-primary-500/25 mb-1">
                <span className="text-xl font-black">T</span>
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                {t('auth.welcomeBack')}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Tezlify hesabınıza giriş yaparak aramalara başlayın.
              </p>
            </div>

            {/* Google Sign-In Action */}
            <div className="space-y-4 pt-2">
              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={isLoading}
                className="w-full relative flex items-center justify-center gap-3 px-5 py-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-750 text-slate-800 dark:text-slate-100 font-semibold text-sm shadow-md hover:shadow-lg transition-all transform active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed group"
              >
                {/* Official Google 'G' SVG Logo */}
                <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24">
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

                <span>
                  {isLoading ? t('auth.signingIn') : t('auth.signInWithGoogle')}
                </span>

                <ArrowRight className="w-4 h-4 ml-auto text-slate-400 group-hover:translate-x-1 transition-transform" />
              </button>

              {/* Security Badge */}
              <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 pt-2">
                <Lock className="w-3.5 h-3.5 text-emerald-500" />
                <span>{t('auth.securityNote')}</span>
              </div>
            </div>

          </div>
        </div>

      </div>
    </div>
  );
};
