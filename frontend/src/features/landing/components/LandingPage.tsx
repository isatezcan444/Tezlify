import React, { useState } from 'react';
import { LandingNavbar } from './LandingNavbar';
import { LandingHero } from './LandingHero';
import { LandingSocialProof } from './LandingSocialProof';
import { LandingBentoFeatures } from './LandingBentoFeatures';
import { LandingPricing } from './LandingPricing';
import { LandingFAQ } from './LandingFAQ';
import { LandingFooter } from './LandingFooter';
import { LandingInteractiveShowcase } from './LandingInteractiveShowcase';
import { LandingRoiCalculator } from './LandingRoiCalculator';
import { useAuth } from '../../../context/AuthContext';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { X, Sparkles, Loader2, ArrowRight } from 'lucide-react';

interface LandingPageProps {
  onEnterApp: () => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onEnterApp }) => {
  const { user, signInWithGoogle } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleOpenAuth = () => {
    if (user) {
      onEnterApp();
    } else {
      setShowLoginModal(true);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      setIsLoggingIn(true);
      await signInWithGoogle();
    } catch (err: unknown) {
      setIsLoggingIn(false);
      toast.error(t('auth.loginError'));
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#F8F7FA] dark:bg-[#25293C] text-[#4B465C] dark:text-[#DBD7EC] transition-colors duration-200">
      {/* Sticky Glass Navbar */}
      <LandingNavbar
        onGoToApp={onEnterApp}
        onOpenLogin={handleOpenAuth}
      />

      {/* Hero Section */}
      <LandingHero
        onGetStarted={handleOpenAuth}
        onExploreDemo={() => {
          const el = document.getElementById('how-it-works');
          el?.scrollIntoView({ behavior: 'smooth' });
        }}
      />

      {/* Social Proof Stats */}
      <LandingSocialProof />

      {/* Interactive Showcase / How It Works (Faz 1) */}
      <LandingInteractiveShowcase onGetStarted={handleOpenAuth} />

      {/* Bento Grid Features */}
      <LandingBentoFeatures />

      {/* ROI & Lead Growth Calculator (Faz 2) */}
      <LandingRoiCalculator onGetStarted={handleOpenAuth} />

      {/* Pricing Section */}
      <LandingPricing
        onSelectPlan={(tier) => {
          handleOpenAuth();
        }}
      />

      {/* FAQ Accordion */}
      <LandingFAQ />

      {/* Footer */}
      <LandingFooter />

      {/* Sleek Login / Registration Modal */}
      {showLoginModal && !user && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-md p-6 sm:p-8 rounded-3xl border border-slate-200/80 dark:border-white/[0.1] bg-white dark:bg-[#2F3349] shadow-2xl relative">
            <button
              type="button"
              onClick={() => setShowLoginModal(false)}
              className="absolute top-5 right-5 p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="text-center flex flex-col items-center">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-[#7367F0] to-indigo-600 text-white flex items-center justify-center shadow-lg shadow-[#7367F0]/30 mb-4">
                <span className="text-2xl font-black">T</span>
              </div>

              <h3 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white">
                {t('auth.brandTitle')}
              </h3>

              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs leading-relaxed">
                {t('auth.loginPrompt')}
              </p>
            </div>

            <div className="mt-6 space-y-4">
              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={isLoggingIn}
                className="w-full h-12 px-4 rounded-xl border border-slate-200 dark:border-white/[0.12] bg-white dark:bg-[#25293C] hover:bg-slate-50 dark:hover:bg-[#1E2235] text-slate-700 dark:text-slate-100 font-bold text-sm shadow-sm transition-all flex items-center justify-center gap-3 cursor-pointer active:scale-95 disabled:opacity-60"
              >
                {isLoggingIn ? (
                  <Loader2 className="w-5 h-5 text-[#7367F0] animate-spin" />
                ) : (
                  <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                )}
                <span>{t('auth.loginGoogle')}</span>
              </button>

              <div className="text-center text-[11px] text-slate-400">
                Giriş yaparak kullanım koşullarını kabul etmiş olursunuz.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
