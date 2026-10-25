import React, { useState } from 'react';
import { 
  Settings, 
  Server, 
  Moon, 
  Sun, 
  Database,
  ShieldCheck,
  Zap,
  Globe,
  Languages,
  Key,
  Sliders,
  Webhook,
  CreditCard,
  MessageSquare,
  Sparkles,
  ArrowRight,
  Code2,
  BellRing,
  Mail
} from 'lucide-react';
import { Card, Badge, PageHeader, Button } from '../components/ui';
import { FormSection, Select } from '../components/forms';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../context/I18nContext';
import { API_BASE } from '../api/client';
import { 
  ApiKeysSection, 
  WebhooksSection, 
  InboundDocsSection,
  ProxySettingsSection,
  SmtpSettingsSection
} from '../features/integrations';
import { PlanUsageSection } from '../features/billing';

export const SettingsPage: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const { language, setLanguage, t } = useI18n();
  const [activeTab, setActiveTab] = useState<'billing' | 'general' | 'integrations' | 'smtp'>('billing');

  const apiBaseLabel = API_BASE;
  const gatewayBaseLabel =
    (import.meta.env?.VITE_GATEWAY_URL as string | undefined) || 'https://api.tezlify.com';

  return (
    <div className="space-y-6 pb-16 w-full select-none animate-fade-in">
      {/* Page Header */}
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        icon={Settings}
      />

      {/* Settings Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200/60 dark:border-white/[0.05] pb-2 text-xs font-bold overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('billing')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'billing'
              ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.04]'
          }`}
        >
          <CreditCard className="w-4 h-4" />
          <span>{t('integrations.tabBilling')}</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('integrations')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'integrations'
              ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.04]'
          }`}
        >
          <Zap className="w-4 h-4 text-amber-400" />
          <span>{t('integrations.tabIntegrations')}</span>
          <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-400 font-extrabold">
            API & Webhook
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('smtp')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'smtp'
              ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.04]'
          }`}
        >
          <Mail className="w-4 h-4 text-blue-400" />
          <span>{t('settings.tabSmtp') || 'E-posta (SMTP)'}</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('general')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'general'
              ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.04]'
          }`}
        >
          <Sliders className="w-4 h-4" />
          <span>{t('integrations.tabGeneral')}</span>
        </button>
      </div>

      {activeTab === 'billing' ? (
        <PlanUsageSection />
      ) : activeTab === 'integrations' ? (
        <div className="space-y-6 animate-fade-in">
          {/* Visual Education Banner: Why API & Webhooks Matter */}
          <div className="vuexy-card p-5 sm:p-6 rounded-xl border border-slate-200/70 dark:border-white/[0.07] bg-white dark:bg-[#2F3349] space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-[#7367F0]/10 text-[#7367F0] flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4 text-[#7367F0]" />
              </div>
              <div>
                <h3 className="text-sm sm:text-base font-bold text-slate-800 dark:text-slate-100">
                  {t('integrationsGuide.heroTitle')}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {t('integrationsGuide.heroSubtitle')}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.04] space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#7367F0]">
                  <Webhook className="w-3.5 h-3.5" />
                  <span>{t('integrationsGuide.cardInboundShort')}</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  {t('integrationsGuide.cardInboundDesc')}
                </p>
              </div>

              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.04] space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  <BellRing className="w-3.5 h-3.5" />
                  <span>{t('integrationsGuide.cardOutboundShort')}</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  {t('integrationsGuide.cardOutboundDesc')}
                </p>
              </div>

              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.04] space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#00CFE8]">
                  <Code2 className="w-3.5 h-3.5" />
                  <span>{t('integrationsGuide.cardApiShort')}</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  {t('integrationsGuide.cardApiDesc')}
                </p>
              </div>
            </div>
          </div>

          {/* Interactive Inbound Form Guide */}
          <InboundDocsSection />

          {/* Outbound Webhooks Management */}
          <WebhooksSection />

          {/* API Keys Management */}
          <ApiKeysSection />
        </div>
      ) : activeTab === 'smtp' ? (
        <div className="space-y-6 animate-fade-in">
          <SmtpSettingsSection />
        </div>
      ) : (
        <>
          {/* Language & Localization Card */}
          <Card className="p-5 sm:p-6 space-y-4">
            <FormSection
              title={t('settings.languageSection')}
              subtitle={t('settings.languageSubtitle')}
              icon={Languages}
            >
              <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
                      {t('settings.languageLabel')}: <span className="text-[#7367F0] font-extrabold">{language === 'en' ? 'English (EN)' : 'Türkçe (TR)'}</span>
                    </p>
                    <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                      {t('settings.languageNotice')}
                    </p>
                  </div>

                  <div className="w-full sm:w-56">
                    <Select
                      value={language}
                      onChange={(e) => setLanguage(e.target.value as 'en' | 'tr')}
                      options={[
                        { value: 'en', label: 'English (EN)' },
                        { value: 'tr', label: 'Türkçe (TR)' },
                      ]}
                    />
                  </div>
                </div>
              </div>
            </FormSection>
          </Card>

          {/* Theme Setting Card */}
          <Card className="p-5 sm:p-6 space-y-4">
            <FormSection
              title={t('settings.themeSection')}
              subtitle={t('settings.themeSubtitle')}
              icon={theme === 'light' ? Sun : Moon}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] gap-3">
                <div>
                  <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
                    {theme === 'light' ? t('settings.themeLight') : t('settings.themeDark')}
                  </p>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    {theme === 'light' ? t('settings.themeDescLight') : t('settings.themeDescDark')}
                  </p>
                </div>

                <Button
                  onClick={toggleTheme}
                  className="space-x-2 font-bold shadow-md shadow-[#7367F0]/30 shrink-0 cursor-pointer"
                >
                  {theme === 'light' ? (
                    <>
                      <Moon className="w-4 h-4" />
                      <span>{t('header.darkMode')}</span>
                    </>
                  ) : (
                    <>
                      <Sun className="w-4 h-4" />
                      <span>{t('header.lightMode')}</span>
                    </>
                  )}
                </Button>
              </div>
            </FormSection>
          </Card>

          {/* Scraper Proxy Pool & Rotation Section */}
          <ProxySettingsSection />

          {/* Services Connections Card */}
          <Card className="p-5 sm:p-6 space-y-4 sm:space-y-6">
            <FormSection
              title={t('settings.servicesSection')}
              subtitle={t('settings.servicesSubtitle')}
              icon={Server}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5 text-[#7367F0]" />
                      {t('settings.fastapiCore')}
                    </span>
                    <Badge variant="success">{t('common.active')}</Badge>
                  </div>
                  <p className="font-mono text-[#7367F0] text-[11px] font-bold">{apiBaseLabel}</p>
                  <p className="text-slate-400 dark:text-[#7E7F96] text-[10px]">Pydantic v2 & SQLAlchemy 2.0 Async Session</p>
                </div>

                <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                      <Globe className="w-3.5 h-3.5 text-[#00CFE8]" />
                      {t('settings.gatewaySidecar')}
                    </span>
                    <Badge variant="success">{t('common.active')}</Badge>
                  </div>
                  <p className="font-mono text-[#00CFE8] text-[11px] font-bold">{gatewayBaseLabel}</p>
                  <p className="text-slate-400 dark:text-[#7E7F96] text-[10px]">Baileys WebSocket Multi-Device Socket Engine</p>
                </div>

                <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                      <Database className="w-3.5 h-3.5 text-[#28C76F]" />
                      {t('settings.databaseEngine')}
                    </span>
                    <Badge variant="success">SQLite + WAL</Badge>
                  </div>
                  <p className="font-mono text-[#28C76F] text-[11px] font-bold">sqlite+aiosqlite:///tezlify.db</p>
                  <p className="text-slate-400 dark:text-[#7E7F96] text-[10px]">Async I/O non-blocking connection pool</p>
                </div>

                <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-[#FF9F43]" />
                      {t('settings.crawlerEngine')}
                    </span>
                    <Badge variant="success">Playwright Chromium</Badge>
                  </div>
                  <p className="font-mono text-[#FF9F43] text-[11px] font-bold">Google Maps Live Playwright Engine</p>
                  <p className="text-slate-400 dark:text-[#7E7F96] text-[10px]">Multi-line address extraction & stream feed</p>
                </div>
              </div>
            </FormSection>
          </Card>
        </>
      )}
    </div>
  );
};
