/**
 * The Anti-Ban policy panel.
 *
 * Extracted from WhatsAppHubPage, which was 3,200 lines and rendered this as
 * 430 lines of inline JSX. All state lives in `useAntiBanSettings`; this file
 * is presentation and wiring, so the page no longer has to know how a policy is
 * edited or saved.
 */
import React from 'react';
import {
  AlertTriangle, Building2, Check, Loader2, RotateCcw, Save,
  Shield, ShieldCheck, Undo2, Zap, Clock, Sliders,
} from 'lucide-react';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Slider, Switch } from '../../../components/forms';
import { useI18n } from '../../../context/I18nContext';
import { useAntiBanSettings } from '../hooks/useAntiBanSettings';

export const AntiBanPanel: React.FC = () => {
  const { t } = useI18n();
  const {
    config,
    savedConfig,
    isSaving,
    saveSuccess,
    hasUnsavedChanges,
    riskInfo,
    handleSave,
    handleResetDefaults,
    handleRevert,
    handlePresetChange,
    handleCustomChange,
  } = useAntiBanSettings();

  return (
    <div className="space-y-6">
      <Card className="p-4 sm:p-6 space-y-6">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-white/[0.08] pb-4">
      <div className="flex items-center space-x-2.5">
        <div className="w-9 h-9 rounded-xl bg-[#28C76F]/15 text-[#28C76F] flex items-center justify-center font-bold">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-extrabold text-slate-800 dark:text-white">
              {t('whatsapp.antiBanTitle')}
            </h3>
            {hasUnsavedChanges ? (
              <Badge variant="warning" className="text-[10px] animate-pulse">
                ⚠️ {t('whatsapp.unsavedChanges')}
              </Badge>
            ) : (
              <Badge variant="success" className="text-[10px]">
                ✅ {t('whatsapp.synchronized')}
              </Badge>
            )}
          </div>
          <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium">
            {t('whatsapp.antiBanSubtitle')}
          </p>
        </div>
      </div>

      <div className="flex items-center space-x-2">
        {hasUnsavedChanges && (
          <button
            type="button"
            onClick={handleRevert}
            className="text-xs font-bold text-slate-500 hover:text-[#7367F0] dark:text-[#7E7F96] dark:hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer"
            title={t('whatsapp.discardChanges')}
          >
            <Undo2 className="w-3.5 h-3.5" />
            <span>{t('whatsapp.revertChanges')}</span>
          </button>
        )}

        <button
          type="button"
          onClick={handleResetDefaults}
          className="text-xs font-bold text-slate-500 hover:text-[#7367F0] dark:text-[#7E7F96] dark:hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer"
          title={t('whatsapp.resetDefaults')}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>{t('whatsapp.resetDefaults')}</span>
        </button>
      </div>
    </div>

    {/* Preset Selector Tabs */}
    <div>
      <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block mb-2">
        {t('whatsapp.antiBanPresetLabel')}
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        {/* Preset 1: Ultra Safe */}
        <button
          type="button"
          onClick={() => handlePresetChange('ultra_safe')}
          className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
            config.preset === 'ultra_safe'
              ? 'border-[#28C76F] bg-[#28C76F]/10 ring-1 ring-[#28C76F]/50 shadow-sm'
              : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100 dark:hover:bg-white/[0.04]'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-[#28C76F]" />
              {t('whatsapp.presetUltraSafe')}
            </span>
            <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#28C76F]/15 text-[#28C76F]">
              {t('whatsapp.presetUltraSafeTag')}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
            {t('whatsapp.presetUltraSafeDesc')}
          </p>
        </button>

        {/* Preset 2: Standard Balanced (Default) */}
        <button
          type="button"
          onClick={() => handlePresetChange('standard_balanced')}
          className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
            config.preset === 'standard_balanced'
              ? 'border-[#7367F0] bg-[#7367F0]/10 ring-1 ring-[#7367F0]/50 shadow-sm'
              : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100 dark:hover:bg-white/[0.04]'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-[#7367F0]" />
              {t('whatsapp.presetBalanced')}
            </span>
            <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#7367F0]/15 text-[#7367F0]">
              {t('whatsapp.presetBalancedTag')}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
            {t('whatsapp.presetBalancedDesc')}
          </p>
        </button>

        {/* Preset 3: Fast Warmed */}
        <button
          type="button"
          onClick={() => handlePresetChange('fast_warmed')}
          className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
            config.preset === 'fast_warmed'
              ? 'border-[#FF9F43] bg-[#FF9F43]/10 ring-1 ring-[#FF9F43]/50 shadow-sm'
              : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100 dark:hover:bg-white/[0.04]'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-[#FF9F43]" />
              {t('whatsapp.presetFast')}
            </span>
            <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#FF9F43]/15 text-[#FF9F43]">
              {t('whatsapp.presetFastTag')}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
            {t('whatsapp.presetFastDesc')}
          </p>
        </button>
      </div>
    </div>

    {/* Detailed Sliders */}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
      <Slider
        label={t('whatsapp.minDelay')}
        icon={Clock}
        value={config.min_delay_seconds}
        min={10}
        max={120}
        step={5}
        unit="s"
        helperText={t('whatsapp.minDelayHelp')}
        onChange={(val) => {
          handleCustomChange('min_delay_seconds', val);
          if (val >= config.max_delay_seconds) {
            handleCustomChange('max_delay_seconds', val + 15);
          }
        }}
      />

      <Slider
        label={t('whatsapp.maxDelay')}
        icon={Clock}
        value={config.max_delay_seconds}
        min={config.min_delay_seconds + 5}
        max={240}
        step={5}
        unit="s"
        helperText={t('whatsapp.maxDelayHelp')}
        onChange={(val) => handleCustomChange('max_delay_seconds', val)}
      />

      <Slider
        label={t('whatsapp.typingDelay')}
        icon={Sliders}
        value={config.typing_delay_seconds}
        min={1}
        max={15}
        step={1}
        unit="s"
        helperText={t('whatsapp.typingDelayHelp')}
        onChange={(val) => handleCustomChange('typing_delay_seconds', val)}
      />

      <Slider
        label={t('whatsapp.dailyLimitSlider')}
        icon={Shield}
        value={config.daily_message_limit}
        min={10}
        max={250}
        step={5}
        helperText={t('whatsapp.dailyLimitHelp')}
        onChange={(val) => handleCustomChange('daily_message_limit', val)}
      />
    </div>

    {/* Working Hours Protection & Smooth Risk Gauge */}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
      {/* Working Hours Box */}
      <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Building2 className="w-4 h-4 text-[#7367F0]" />
            <div>
              <span className="text-xs font-extrabold text-slate-800 dark:text-white block">
                {t('whatsapp.workingHoursTitle')}
              </span>
              <span className="text-[10px] text-slate-400">{t('whatsapp.workingHoursSubtitle')}</span>
            </div>
          </div>

          <Switch
            checked={config.working_hours_enabled !== false}
            onChange={(checked) => handleCustomChange('working_hours_enabled', checked)}
          />
        </div>

        {config.working_hours_enabled !== false && (
          <div className="space-y-2.5 pt-1 animate-fade-in">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  handleCustomChange('working_hours_start', '09:00');
                  handleCustomChange('working_hours_end', '18:00');
                }}
                className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                  config.working_hours_start === '09:00' && config.working_hours_end === '18:00'
                    ? 'bg-[#7367F0]/15 text-[#7367F0] border-[#7367F0]/40'
                    : 'bg-white dark:bg-white/[0.04] text-slate-500 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100'
                }`}
              >
                {t('whatsapp.presetStandardHours')}
              </button>

              <button
                type="button"
                onClick={() => {
                  handleCustomChange('working_hours_start', '09:00');
                  handleCustomChange('working_hours_end', '18:30');
                }}
                className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                  config.working_hours_start === '09:00' && config.working_hours_end === '18:30'
                    ? 'bg-[#7367F0]/15 text-[#7367F0] border-[#7367F0]/40'
                    : 'bg-white dark:bg-white/[0.04] text-slate-500 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100'
                }`}
              >
                {t('whatsapp.presetCorporateHours')}
              </button>

              <button
                type="button"
                onClick={() => {
                  handleCustomChange('working_hours_start', '09:00');
                  handleCustomChange('working_hours_end', '20:00');
                }}
                className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                  config.working_hours_start === '09:00' && config.working_hours_end === '20:00'
                    ? 'bg-[#7367F0]/15 text-[#7367F0] border-[#7367F0]/40'
                    : 'bg-white dark:bg-white/[0.04] text-slate-500 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100'
                }`}
              >
                {t('whatsapp.presetFlexibleHours')}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs pt-1">
              <div>
                <label className="text-[10px] font-bold text-slate-500 dark:text-[#7E7F96] block mb-1">
                  {t('whatsapp.startTime')}
                </label>
                <input
                  type="time"
                  value={config.working_hours_start || '09:00'}
                  onChange={(e) => handleCustomChange('working_hours_start', e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg vuexy-input text-xs font-mono font-bold"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 dark:text-[#7E7F96] block mb-1">
                  {t('whatsapp.endTime')}
                </label>
                <input
                  type="time"
                  value={config.working_hours_end || '18:30'}
                  onChange={(e) => handleCustomChange('working_hours_end', e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg vuexy-input text-xs font-mono font-bold"
                />
              </div>
            </div>
          </div>
        )}
        <p className="text-[10px] text-slate-400">
          {t('whatsapp.workingHoursHelp')}
        </p>
      </div>

      {/* Smooth Animated Risk Meter */}
      <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] flex flex-col justify-between space-y-3 shadow-sm">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
              <AlertTriangle className={`w-4 h-4 ${riskInfo.color}`} />
              {t('whatsapp.riskTitle')}
            </span>
            <span className={`text-[11px] font-extrabold px-2.5 py-0.5 rounded-lg border font-mono uppercase transition-all duration-300 ${riskInfo.badgeBg} ${riskInfo.badgeText}`}>
              {riskInfo.title} (%{riskInfo.score})
            </span>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] leading-relaxed">
            {riskInfo.desc}
          </p>
        </div>

        <div className="space-y-1.5 pt-1">
          <div className="relative w-full h-3 rounded-full bg-slate-200 dark:bg-slate-700 overflow-visible p-0.5">
            <div 
              className="w-full h-full rounded-full bg-gradient-to-r from-[#28C76F] via-[#FF9F43] to-[#EA5455] opacity-90"
            />
            <div 
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-white dark:bg-slate-900 border-2 rounded-full shadow-md transition-all duration-500 ease-out z-10 flex items-center justify-center"
              style={{ 
                left: `${Math.max(4, Math.min(96, riskInfo.score))}%`,
                borderColor: riskInfo.color 
              }}
            >
              <div 
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: riskInfo.color }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between text-[9px] font-bold text-slate-400 font-mono px-0.5">
            <span className="text-[#28C76F]">{t('whatsapp.riskSafe')}</span>
            <span className="text-[#FF9F43]">{t('whatsapp.riskBalanced')}</span>
            <span className="text-[#EA5455]">{t('whatsapp.riskHigh')}</span>
          </div>
        </div>
      </div>
    </div>

    {/* Save Actions */}
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-white/[0.05]">
      <div className="flex items-center gap-2">
        {saveSuccess ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#28C76F] bg-[#28C76F]/15 px-3 py-1.5 rounded-lg border border-[#28C76F]/30 animate-fade-in">
            <Check className="w-3.5 h-3.5" />
            <span>{t('whatsapp.policySavedSuccess')}</span>
          </span>
        ) : hasUnsavedChanges ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#FF9F43] bg-[#FF9F43]/15 px-3 py-1.5 rounded-lg border border-[#FF9F43]/30 animate-fade-in">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>{t('whatsapp.unsavedChangesDesc')}</span>
          </span>
        ) : (
          <span className="text-xs text-slate-400 dark:text-[#7E7F96]">
            {savedConfig.updated_at
              ? `${t('whatsapp.synchronized')}: ${new Date(savedConfig.updated_at).toLocaleTimeString()}`
              : t('whatsapp.synchronized')}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {hasUnsavedChanges && (
          <Button
            variant="outline"
            onClick={handleRevert}
            className="space-x-1.5 font-bold text-slate-600 dark:text-slate-300 cursor-pointer"
          >
            <Undo2 className="w-4 h-4" />
            <span>{t('whatsapp.revertChanges')}</span>
          </Button>
        )}

        <Button
          onClick={handleSave}
          disabled={isSaving || !hasUnsavedChanges}
          className={`space-x-2 font-bold justify-center cursor-pointer transition-all duration-300 ${
            hasUnsavedChanges
              ? 'bg-[#7367F0] hover:bg-[#5E50EE] text-white shadow-lg shadow-[#7367F0]/30 ring-2 ring-[#7367F0]/30'
              : 'bg-slate-200 dark:bg-white/[0.08] text-slate-400 dark:text-slate-500 cursor-not-allowed'
          }`}
        >
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{t('whatsapp.saving')}</span>
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              <span>{hasUnsavedChanges ? t('whatsapp.savePolicy') : t('whatsapp.savedStatus')}</span>
            </>
          )}
        </Button>
      </div>
    </div>
  </Card>

  {/* Anti-Ban Safeguard Guidelines */}
  <div className="grid grid-cols-1">
    <div>
      <Card className="p-6 space-y-4">
        <h3 className="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#28C76F]" />
          {t('whatsapp.guidelinesTitle')}
        </h3>

        <div className="space-y-2.5 text-xs text-slate-700 dark:text-slate-300 font-medium">
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-1">
            <span className="font-bold text-[#28C76F]">{t('whatsapp.guideline1Title')}</span>
            <p className="text-slate-500 dark:text-[#7E7F96] text-[11px]">
              {t('whatsapp.guideline1Desc')}
            </p>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-1">
            <span className="font-bold text-[#00CFE8]">{t('whatsapp.guideline2Title')}</span>
            <p className="text-slate-500 dark:text-[#7E7F96] text-[11px]">
              {t('whatsapp.guideline2Desc')}
            </p>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-1">
            <span className="font-bold text-[#7367F0]">{t('whatsapp.guideline3Title')}</span>
            <p className="text-slate-500 dark:text-[#7E7F96] text-[11px]">
              {t('whatsapp.guideline3Desc')}
            </p>
          </div>
        </div>
      </Card>
    </div>
  </div>
  </div>
  );
};
