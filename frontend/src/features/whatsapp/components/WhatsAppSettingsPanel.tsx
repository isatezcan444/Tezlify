import React, { useState, useEffect } from 'react';
import {
  Volume2,
  VolumeX,
  Volume1,
  Play,
  Palette,
  RotateCcw,
  Check,
  Bell,
  Sliders,
  Type,
  CornerDownLeft,
  Sparkles,
  Pipette,
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { useTheme } from '../../../context/ThemeContext';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { useWhatsAppSettings } from '../hooks/useWhatsAppSettings';
import { SOUND_PRESETS, type SoundPresetId } from '../lib/whatsappAudio';
import {
  WALLPAPER_THEMES,
  getChatWallpaperStyle,
} from '../lib/whatsappWallpapers';

export const WhatsAppSettingsPanel: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const {
    settings,
    updateSettings,
    resetSettings,
    testSound,
    requestNotificationPermission,
    testDesktopNotification,
  } = useWhatsAppSettings();

  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'default'
  );

  const [playingPreset, setPlayingPreset] = useState<SoundPresetId | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  const handleTestSound = (presetId: SoundPresetId) => {
    setPlayingPreset(presetId);
    testSound(presetId, settings.soundVolume);
    setTimeout(() => {
      setPlayingPreset(null);
    }, 600);
  };

  const handleRequestPermission = async () => {
    const granted = await requestNotificationPermission();
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotificationPermission(Notification.permission);
    }
    if (granted) {
      updateSettings({ desktopNotificationsEnabled: true });
      toast.success(t('whatsapp.notificationsGranted'), t('common.success'));
    } else {
      toast.error(t('whatsapp.notificationsDenied'), t('common.error'));
    }
  };

  const handleTestDesktopNotification = async () => {
    const success = await testDesktopNotification(
      t('whatsapp.testNotificationTitle'),
      t('whatsapp.testNotificationBody')
    );
    if (success) {
      toast.success(`${t('whatsapp.testNotificationTitle')} — ${t('whatsapp.testNotification')}`, t('common.success'));
    } else {
      toast.error(t('whatsapp.notificationsDeniedHelp') || t('whatsapp.notificationsDenied'), t('common.error'));
    }
  };

  const handleReset = async () => {
    const confirmed = await toast.confirm({
      title: t('whatsapp.resetCustomizationDefaults'),
      message: t('whatsapp.resetCustomizationDefaultsConfirm'),
      variant: 'warning',
    });
    if (confirmed) {
      resetSettings();
      toast.success(t('whatsapp.resetCustomizationDefaultsSuccess'), t('common.success'));
    }
  };

  // Live preview wallpaper styling
  const { theme } = useTheme();
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return theme === 'dark';
  });

  useEffect(() => {
    setIsDark(theme === 'dark');
  }, [theme]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const updateDark = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    updateDark();
    const observer = new MutationObserver(() => updateDark());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const isDefaultTheme = settings.wallpaperTheme === 'whatsapp_default';
  const previewWallpaperStyle = getChatWallpaperStyle({
    themeId: settings.wallpaperTheme,
    customColor: settings.customWallpaperColor,
    isDark,
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      <Card className="p-4 sm:p-6 space-y-6">
        {/* Card Header matching AntiBanPanel Standard Topology */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-white/[0.08] pb-4">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center font-bold shrink-0">
              <Sliders className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h3 className="text-xs sm:text-sm md:text-base font-extrabold text-slate-800 dark:text-white truncate whitespace-nowrap">
                  {t('whatsapp.settingsTitle')}
                </h3>
                <Badge variant="primary" className="text-[9px] sm:text-[10px] shrink-0 font-bold whitespace-nowrap">
                  {t('whatsapp.settingsBadge')}
                </Badge>
              </div>
              <p className="text-[10px] sm:text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium truncate whitespace-nowrap">
                {t('whatsapp.settingsSubtitle')}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2 shrink-0 self-start sm:self-auto">
            <button
              type="button"
              onClick={handleReset}
              className="text-[11px] sm:text-xs font-bold text-slate-500 hover:text-[#7367F0] dark:text-[#7E7F96] dark:hover:text-white flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer whitespace-nowrap"
              title={t('whatsapp.resetCustomizationDefaults')}
            >
              <RotateCcw className="w-3.5 h-3.5 shrink-0" />
              <span className="whitespace-nowrap">{t('whatsapp.resetCustomizationDefaults')}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-1">
          {/* Left Column: Sound & Interaction Settings */}
          <div className="lg:col-span-7 space-y-5">
            {/* 1. Sesli Bildirimler Card */}
            <div className="p-4 sm:p-5 rounded-xl bg-slate-50/70 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-4">
              <div className="flex items-center justify-between border-b border-slate-200/60 dark:border-white/[0.06] pb-3 gap-3">
                <div className="flex items-center space-x-2.5 min-w-0 pr-2">
                  <div className="w-8 h-8 rounded-lg bg-[#28C76F]/10 flex items-center justify-center text-[#28C76F] shrink-0">
                    <Volume2 className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white truncate">
                      {t('whatsapp.soundNotifications')}
                    </h4>
                    <p className="text-[10px] sm:text-[11px] text-slate-400 dark:text-[#7E7F96] truncate">
                      {t('whatsapp.soundNotificationsDesc')}
                    </p>
                  </div>
                </div>

                {/* Master Sound Toggle */}
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={settings.soundEnabled}
                    onChange={(e) => updateSettings({ soundEnabled: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#28C76F]" />
                </label>
              </div>

              {settings.soundEnabled ? (
                <div className="space-y-4 pt-1 animate-in fade-in duration-150">
                  {/* Sound Presets Selection */}
                  <div>
                    <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block mb-2">
                      {t('whatsapp.incomingSound')}
                    </label>
                    <div className="space-y-2">
                      {SOUND_PRESETS.map((preset) => {
                        const isSelected = settings.soundPreset === preset.id;
                        const isPlaying = playingPreset === preset.id;

                        return (
                          <div
                            key={preset.id}
                            onClick={() => {
                              updateSettings({ soundPreset: preset.id });
                              handleTestSound(preset.id);
                            }}
                            className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer gap-2 ${
                              isSelected
                                ? 'bg-[#7367F0]/10 dark:bg-[#7367F0]/20 border-[#7367F0] dark:border-[#7367F0]/60 shadow-xs'
                                : 'bg-white dark:bg-white/[0.02] border-slate-200/80 dark:border-white/[0.06] hover:border-slate-300 dark:hover:border-white/[0.12]'
                            }`}
                          >
                            <div className="flex items-center space-x-3 min-w-0 flex-1 pr-2">
                              <div
                                className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                                  isSelected
                                    ? 'border-[#7367F0] bg-[#7367F0] text-white'
                                    : 'border-slate-300 dark:border-slate-600'
                                }`}
                              >
                                {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-1.5 truncate">
                                  <span className="truncate">{t(preset.nameKey)}</span>
                                  {isSelected && (
                                    <span className="text-[10px] font-extrabold text-[#7367F0] dark:text-[#A59DF8] shrink-0">
                                      ✓
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10px] text-slate-400 dark:text-[#7E7F96] truncate">
                                  {t(preset.descKey)}
                                </div>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleTestSound(preset.id);
                              }}
                              title={t('whatsapp.testSound')}
                              className={`p-1.5 rounded-lg border transition-all cursor-pointer shrink-0 ${
                                isPlaying
                                  ? 'bg-[#28C76F] text-white border-[#28C76F] animate-pulse'
                                  : 'bg-slate-50 dark:bg-[#25293C] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100 dark:hover:bg-white/[0.08]'
                              }`}
                            >
                              <Play className="w-3.5 h-3.5 fill-current" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Volume Slider */}
                  <div className="pt-2 border-t border-slate-200/60 dark:border-white/[0.06]">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-200 mb-2">
                      <span className="flex items-center gap-1.5">
                        {settings.soundVolume === 0 ? (
                          <VolumeX className="w-3.5 h-3.5 text-slate-400" />
                        ) : settings.soundVolume < 0.5 ? (
                          <Volume1 className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" />
                        ) : (
                          <Volume2 className="w-3.5 h-3.5 text-[#28C76F]" />
                        )}
                        {t('whatsapp.soundVolume')}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                        {Math.round(settings.soundVolume * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.soundVolume}
                      onChange={(e) => updateSettings({ soundVolume: parseFloat(e.target.value) })}
                      className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-[#28C76F]"
                    />
                  </div>
                </div>
              ) : (
                <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-xs flex items-center gap-2">
                  <VolumeX className="w-4 h-4 shrink-0" />
                  <span>{t('whatsapp.soundsMutedNotice')}</span>
                </div>
              )}
            </div>

            {/* 2. Masaüstü Bildirimleri Card */}
            <div className="p-4 sm:p-5 rounded-xl bg-slate-50/70 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-3.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center space-x-2.5 min-w-0 pr-2">
                  <div className="w-8 h-8 rounded-lg bg-[#00CFE8]/10 flex items-center justify-center text-[#00CFE8] shrink-0">
                    <Bell className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white truncate">
                      {t('whatsapp.desktopNotifications')}
                    </h4>
                    <p className="text-[10px] sm:text-[11px] text-slate-400 dark:text-[#7E7F96] truncate">
                      {t('whatsapp.desktopNotificationsDesc')}
                    </p>
                  </div>
                </div>

                {notificationPermission === 'granted' ? (
                  <div className="flex items-center gap-2 shrink-0 self-start sm:self-auto">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleTestDesktopNotification}
                      className="text-xs font-bold space-x-1.5 cursor-pointer hover:border-[#7367F0]/50 h-8"
                    >
                      <Bell className="w-3.5 h-3.5 text-[#7367F0]" />
                      <span>{t('whatsapp.testNotification')}</span>
                    </Button>
                    <Badge variant="success" className="text-[10px] font-bold shrink-0">
                      {t('whatsapp.notificationsGranted')}
                    </Badge>
                  </div>
                ) : notificationPermission === 'denied' ? (
                  <Badge variant="danger" className="text-[10px] font-bold shrink-0 self-start sm:self-auto">
                    {t('whatsapp.notificationsDenied')}
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRequestPermission}
                    className="text-xs font-bold shrink-0 self-start sm:self-auto h-8"
                  >
                    {t('whatsapp.enableNotifications')}
                  </Button>
                )}
              </div>

              {notificationPermission === 'denied' && (
                <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 text-xs leading-relaxed">
                  {t('whatsapp.notificationsDeniedHelp')}
                </div>
              )}

              {notificationPermission === 'granted' && (
                <div className="flex items-center justify-between pt-2 border-t border-slate-200/60 dark:border-white/[0.06] gap-3">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-300 min-w-0 pr-2 truncate">
                    {t('whatsapp.desktopNotificationsActive')}
                  </span>
                  <label className="relative inline-flex items-center cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      checked={settings.desktopNotificationsEnabled}
                      onChange={(e) => updateSettings({ desktopNotificationsEnabled: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#7367F0]" />
                  </label>
                </div>
              )}
            </div>

            {/* 3. Sohbet Davranışları & Yazı Boyutu */}
            <div className="p-4 sm:p-5 rounded-xl bg-slate-50/70 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-4">
              <div className="flex items-center space-x-2.5 border-b border-slate-200/60 dark:border-white/[0.06] pb-3">
                <div className="w-8 h-8 rounded-lg bg-[#7367F0]/10 flex items-center justify-center text-[#7367F0] shrink-0">
                  <CornerDownLeft className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h4 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white truncate">
                    {t('whatsapp.chatPreferences')}
                  </h4>
                  <p className="text-[10px] sm:text-[11px] text-slate-400 dark:text-[#7E7F96] truncate">
                    {t('whatsapp.chatPreferencesDesc')}
                  </p>
                </div>
              </div>

              {/* Enter tuşu davranışı */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 pr-2">
                  <div className="text-xs font-bold text-slate-800 dark:text-white truncate">
                    {t('whatsapp.enterToSend')}
                  </div>
                  <div className="text-[10px] sm:text-[11px] text-slate-400 dark:text-[#7E7F96] truncate">
                    {t('whatsapp.enterToSendDesc')}
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={settings.enterIsSend}
                    onChange={(e) => updateSettings({ enterIsSend: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#7367F0]" />
                </label>
              </div>

              {/* Mesaj Yazı Boyutu */}
              <div className="pt-1 border-t border-slate-200/60 dark:border-white/[0.06]">
                <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block mb-2 flex items-center gap-1.5">
                  <Type className="w-3.5 h-3.5 text-slate-400" />
                  {t('whatsapp.fontSize')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['small', 'medium', 'large'] as const).map((size) => {
                    const isSelected = settings.fontSize === size;
                    const labelKey = size === 'small' ? 'whatsapp.fontSmall' : size === 'medium' ? 'whatsapp.fontMedium' : 'whatsapp.fontLarge';
                    return (
                      <button
                        key={size}
                        type="button"
                        onClick={() => updateSettings({ fontSize: size })}
                        className={`py-2 px-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer border text-center truncate ${
                          isSelected
                            ? 'bg-[#7367F0] text-white border-[#7367F0] shadow-xs'
                            : 'bg-white dark:bg-white/[0.03] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/[0.08] hover:border-slate-300'
                        }`}
                      >
                        {t(labelKey)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Wallpaper Customization & Interactive Live Preview */}
          <div className="lg:col-span-5 space-y-5">
            <div className="p-4 sm:p-5 rounded-xl bg-slate-50/70 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-4">
              <div className="flex items-center space-x-2.5 border-b border-slate-200/60 dark:border-white/[0.06] pb-3">
                <div className="w-8 h-8 rounded-lg bg-[#FF9F43]/10 flex items-center justify-center text-[#FF9F43] shrink-0">
                  <Palette className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h4 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white truncate">
                    {t('whatsapp.chatWallpaper')}
                  </h4>
                  <p className="text-[10px] sm:text-[11px] text-slate-400 dark:text-[#7E7F96] truncate">
                    {t('whatsapp.chatWallpaperDesc')}
                  </p>
                </div>
              </div>

              {/* Theme Swatches */}
              <div>
                <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block mb-2.5">
                  {t('whatsapp.wallpaperThemeSelect')}
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-2 gap-2">
                  {WALLPAPER_THEMES.map((theme) => {
                    const isSelected = settings.wallpaperTheme === theme.id;
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        onClick={() => updateSettings({ wallpaperTheme: theme.id })}
                        title={t(theme.nameKey)}
                        className={`flex items-center space-x-2 p-2 sm:p-2.5 rounded-xl border text-left transition-all cursor-pointer min-w-0 ${
                          isSelected
                            ? 'border-[#7367F0] ring-2 ring-[#7367F0]/30 bg-[#7367F0]/10 dark:bg-[#7367F0]/20'
                            : 'border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-white/[0.02] hover:border-slate-300'
                        }`}
                      >
                        <div
                          className="w-4 h-4 sm:w-5 sm:h-5 rounded-full shrink-0 shadow-xs flex items-center justify-center"
                          style={{ backgroundColor: theme.previewColor }}
                        >
                          {isSelected && <Check className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-white" />}
                        </div>
                        <span className="text-[10px] sm:text-xs font-semibold text-slate-700 dark:text-slate-200 truncate leading-tight">
                          {t(theme.nameKey)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Custom Color Palette Section */}
              <div className="pt-2 border-t border-slate-200/60 dark:border-white/[0.06]">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                    <Pipette className="w-3.5 h-3.5 text-[#7367F0]" />
                    {t('whatsapp.customColor')}
                  </label>
                  {settings.wallpaperTheme === 'custom' && (
                    <Badge variant="primary" className="text-[10px] py-0 px-1.5 font-bold">
                      {t('common.active')}
                    </Badge>
                  )}
                </div>

                {/* Native color picker & hex input */}
                <div className="flex items-center gap-2 p-2 rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-white/[0.02]">
                  <div className="relative w-7 h-7 sm:w-8 sm:h-8 rounded-lg overflow-hidden shrink-0 border border-slate-300 dark:border-white/[0.15] shadow-xs cursor-pointer">
                    <input
                      type="color"
                      value={settings.customWallpaperColor || '#0b141a'}
                      onChange={(e) => {
                        updateSettings({
                          wallpaperTheme: 'custom',
                          customWallpaperColor: e.target.value,
                        });
                      }}
                      className="absolute -top-2 -left-2 w-12 h-12 cursor-pointer border-0 p-0"
                      title={t('whatsapp.customColorPicker')}
                    />
                  </div>

                  <div className="flex-1 min-w-0 flex items-center gap-1">
                    <span className="text-xs font-mono font-bold text-slate-400 select-none">#</span>
                    <input
                      type="text"
                      maxLength={7}
                      value={settings.customWallpaperColor ? settings.customWallpaperColor.replace('#', '') : ''}
                      onChange={(e) => {
                        const val = e.target.value.replace(/[^0-9a-fA-F]/g, '');
                        if (val.length <= 6) {
                          const hex = `#${val}`;
                          updateSettings({
                            wallpaperTheme: 'custom',
                            customWallpaperColor: hex,
                          });
                        }
                      }}
                      placeholder="0b141a"
                      className="w-full min-w-0 bg-slate-50 dark:bg-[#25293C] text-xs font-mono font-semibold text-slate-800 dark:text-white px-2 py-1 rounded-lg border border-slate-200 dark:border-white/[0.08] focus:outline-none focus:border-[#7367F0]"
                    />
                  </div>

                  <Button
                    size="sm"
                    variant={settings.wallpaperTheme === 'custom' ? 'default' : 'outline'}
                    onClick={() => updateSettings({ wallpaperTheme: 'custom' })}
                    className="text-[11px] sm:text-xs font-bold shrink-0 h-7 sm:h-8 px-2 sm:px-3"
                  >
                    {settings.wallpaperTheme === 'custom' ? `✓ ${t('common.selected')}` : t('common.select')}
                  </Button>
                </div>
              </div>

              {/* Interactive Live Chat Preview */}
              <div className="pt-2 border-t border-slate-200/60 dark:border-white/[0.06]">
                <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block mb-2 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-[#28C76F]" />
                  {t('whatsapp.livePreview')}
                </label>

                <div
                  className={`relative rounded-2xl overflow-hidden border border-slate-200 dark:border-white/[0.12] p-4 shadow-inner min-h-[220px] sm:min-h-[240px] flex flex-col justify-end space-y-3 ${isDefaultTheme ? 'whatsapp-chat-bg' : ''}`}
                  style={isDefaultTheme ? undefined : previewWallpaperStyle}
                >
                  {/* Incoming bubble */}
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded-2xl rounded-tl-xs px-3.5 py-2 bg-white dark:bg-[#1E2333] shadow-xs border border-slate-200/60 dark:border-white/[0.08] text-slate-800 dark:text-slate-100">
                      <p className={`leading-relaxed ${
                        settings.fontSize === 'small' ? 'text-[11px]' : settings.fontSize === 'large' ? 'text-sm' : 'text-xs'
                      }`}>
                        {t('whatsapp.previewIncoming')}
                      </p>
                      <div className="flex justify-end pt-1">
                        <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                          14:32
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Outgoing bubble */}
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-tr-xs px-3.5 py-2 bg-[#d9fdd3] dark:bg-[#005c4b] shadow-xs border border-[#25D366]/20 text-slate-800 dark:text-white">
                      <p className={`leading-relaxed ${
                        settings.fontSize === 'small' ? 'text-[11px]' : settings.fontSize === 'large' ? 'text-sm' : 'text-xs'
                      }`}>
                        {t('whatsapp.previewOutgoing')}
                      </p>
                      <div className="flex items-center justify-end space-x-1 pt-1">
                        <span className="text-[10px] text-slate-500 dark:text-white/70 font-mono">
                          14:33
                        </span>
                        <span className="text-[#53bdeb] text-xs font-bold leading-none">
                          ✓✓
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
};
