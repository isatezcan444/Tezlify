import React from 'react';
import { Users, CheckCircle2, Zap, ShieldCheck } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

export const LandingSocialProof: React.FC = () => {
  const { t } = useI18n();

  const stats = [
    {
      value: '100,000+',
      label: t('landing.statVerifiedLeads'),
      icon: Users,
      color: 'text-[#7367F0]',
      bg: 'bg-[#7367F0]/10',
    },
    {
      value: '%98',
      label: t('landing.statDeliveryRate'),
      icon: CheckCircle2,
      color: 'text-[#28C76F]',
      bg: 'bg-[#28C76F]/10',
    },
    {
      value: '10x',
      label: t('landing.statSpeedBoost'),
      icon: Zap,
      color: 'text-[#FF9F43]',
      bg: 'bg-[#FF9F43]/10',
    },
    {
      value: '7/24',
      label: t('landing.statSafeOutreach'),
      icon: ShieldCheck,
      color: 'text-[#00CFE8]',
      bg: 'bg-[#00CFE8]/10',
    },
  ];

  return (
    <section className="py-12 border-y border-slate-200/80 dark:border-white/[0.08] bg-white/40 dark:bg-[#25293C]/40 backdrop-blur select-none">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 sm:gap-8">
          {stats.map((s, idx) => {
            const Icon = s.icon;
            return (
              <div
                key={idx}
                className="flex flex-col items-center text-center p-4 rounded-2xl hover:bg-white/60 dark:hover:bg-white/[0.02] transition-colors"
              >
                <div className={`p-3 rounded-2xl ${s.bg} ${s.color} mb-3 shadow-sm`}>
                  <Icon className="w-6 h-6" />
                </div>
                <div className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
                  {s.value}
                </div>
                <div className="text-xs sm:text-sm font-semibold text-slate-500 dark:text-slate-400 mt-1">
                  {s.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
