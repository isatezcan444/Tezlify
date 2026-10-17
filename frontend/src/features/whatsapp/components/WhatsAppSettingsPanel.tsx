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
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { useWhatsAppSettings } from '../hooks/useWhatsAppSettings';
import { SOUND_PRESETS, type SoundPresetId } from '../lib/whatsappAudio';
import {
  WALLPAPER_THEMES,
  getChatWallpaperStyle,
  type WallpaperThemeId,
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
      toast.success(t('whatsapp.notificationsGranted'), t('common.success'));
    } else {
      toast.error(t('whatsapp.notificationsDenied'), t('common.error'));
    }
  };

  const handleReset = async () => {
    const confirmed = await toast.confirm({
      title: t('whatsapp.resetCustomizationDefaults') || 'Varsayılanlara Sıfırla',
      message: t('whatsapp.resetCustomizationDefaultsConfirm') || 'Tüm WhatsApp kişiselleştirme ayarlarını varsayılana sıfırlamak istiyor musunuz?',
      variant: 'warning',
    });
    if (confirmed) {
      resetSettings();
      toast.success(t('whatsapp.resetCustomizationDefaultsSuccess') || 'Ayarlar başarıyla sıfırlandı.', t('common.success'));
    }
  };

  // Live preview wallpaper styling
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const previewWallpaperStyle = getChatWallpaperStyle({
    themeId: settings.wallpaperTheme,
    isDark,
  });

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12 animate-in fade-in duration-200">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-gradient-to-r from-white to-slate-50 dark:from-[#2F3349] dark:to-[#25293C] border border-slate-200/80 dark:border-white/[0.08] shadow-xs">
        <div className="flex items-center space-x-3.5">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[#7367F0]/20 to-[#28C76F]/20 flex items-center justify-center text-[#7367F0] dark:text-[#25D366] shrink-0 border border-[#7367F0]/20">
            <Sliders className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base sm:text-lg font-extrabold text-slate-800 dark:text-white flex items-center gap-2">
              {t('whatsapp.settingsTitle')}
              <Badge variant="primary" className="text-[10px] uppercase font-bold tracking-wider py-0 px-1.5">
                {t('whatsapp.settingsBadge') || 'Özelleştirme'}
              </Badge>
            </h1>
            <p className="text-xs text-slate-500 dark:text-[#7E7F96]">
              {t('whatsapp.settingsSubtitle')}
            </p>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleReset}
          className="space-x-1.5 text-xs font-bold cursor-pointer shrink-0 self-start sm:self-auto"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>{t('whatsapp.resetCustomizationDefaults')}</span>
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Sound & Interaction Settings */}
        <div className="lg:col-span-7 space-y-6">
          {/* 1. Sesli Bildirimler Card */}
          <Card className="p-5 space-y-5 bg-white dark:bg-[#2F3349] border-slate-200/80 dark:border-white/[0.08]">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-white/[0.06] pb-3.5">
              <div className="flex items-center space-x-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#28C76F]/10 flex items-center justify-center text-[#28C76F]">
                  <Volume2 className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-extrabold text-slate-800 dark:text-white">
                    {t('whatsapp.soundNotifications')}
                  </h2>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    {t('whatsapp.soundNotificationsDesc')}
                  </p>
                </div>
              </div>

              {/* Master Sound Toggle */}
              <label className="relative inline-flex items-center cursor-pointer">
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
                          className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                            isSelected
                              ? 'bg-[#7367F0]/10 dark:bg-[#7367F0]/20 border-[#7367F0] dark:border-[#7367F0]/60 shadow-xs'
                              : 'bg-slate-50/60 dark:bg-white/[0.02] border-slate-200/80 dark:border-white/[0.06] hover:border-slate-300 dark:hover:border-white/[0.12]'
                          }`}
                        >
                          <div className="flex items-center space-x-3">
                            <div
                              className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                                isSelected
                                  ? 'border-[#7367F0] bg-[#7367F0] text-white'
                                  : 'border-slate-300 dark:border-slate-600'
                              }`}
                            >
                              {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                            </div>
                            <div>
                              <div className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-1.5">
                                {t(preset.nameKey)}
                                {isSelected && (
                                  <span className="text-[10px] font-extrabold text-[#7367F0] dark:text-[#A59DF8]">
                                    ✓
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-400 dark:text-[#7E7F96]">
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
                            className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
                              isPlaying
                                ? 'bg-[#28C76F] text-white border-[#28C76F] animate-pulse'
                                : 'bg-white dark:bg-[#25293C] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100 dark:hover:bg-white/[0.08]'
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
                <div className="pt-2">
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
                    min="0"
                    max="1"
                    step="0.05"
                    value={settings.soundVolume}
                    onChange={(e) => updateSettings({ soundVolume: parseFloat(e.target.value) })}
                    className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-[#28C76F]"
                  />
                </div>
              </div>
            ) : (
              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-xs flex items-center gap-2">
                <VolumeX className="w-4 h-4 shrink-0" />
                <span>{t('whatsapp.soundsMutedNotice') || 'Bildirim sesleri kapalı. Gelen mesajlarda tarayıcıdan ses çalınmayacak.'}</span>
              </div>
            )}
          </Card>

          {/* 2. Masaüstü Bildirimleri Card */}
          <Card className="p-5 space-y-4 bg-white dark:bg-[#2F3349] border-slate-200/80 dark:border-white/[0.08]">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#00CFE8]/10 flex items-center justify-center text-[#00CFE8]">
                  <Bell className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-extrabold text-slate-800 dark:text-white">
                    {t('whatsapp.desktopNotifications')}
                  </h2>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    {t('whatsapp.desktopNotificationsDesc')}
                  </p>
                </div>
              </div>

              {notificationPermission === 'granted' ? (
                <Badge variant="success" className="text-xs">
                  {t('whatsapp.notificationsGranted')}
                </Badge>
              ) : notificationPermission === 'denied' ? (
                <Badge variant="danger" className="text-xs">
                  {t('whatsapp.notificationsDenied')}
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleRequestPermission}
                  className="text-xs font-bold"
                >
                  {t('whatsapp.enableNotifications')}
                </Button>
              )}
            </div>

            {notificationPermission === 'granted' && (
              <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-white/[0.06]">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  {t('whatsapp.desktopNotificationsActive') || 'Sekme arka plandayken sistem bildirimi göster'}
                </span>
                <label className="relative inline-flex items-center cursor-pointer">
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
          </Card>

          {/* 3. Sohbet Davranışları & Yazı Boyutu */}
          <Card className="p-5 space-y-4 bg-white dark:bg-[#2F3349] border-slate-200/80 dark:border-white/[0.08]">
            <div className="flex items-center space-x-2.5 border-b border-slate-100 dark:border-white/[0.06] pb-3">
              <div className="w-8 h-8 rounded-lg bg-[#7367F0]/10 flex items-center justify-center text-[#7367F0]">
                <CornerDownLeft className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-sm font-extrabold text-slate-800 dark:text-white">
                  {t('whatsapp.chatPreferences')}
                </h2>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  {t('whatsapp.chatPreferencesDesc') || 'Klavyeden mesaj gönderme ve görünüm ayarları'}
                </p>
              </div>
            </div>

            {/* Enter tuşu davranışı */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-slate-800 dark:text-white">
                  {t('whatsapp.enterToSend')}
                </div>
                <div className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  {t('whatsapp.enterToSendDesc')}
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
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
            <div className="pt-2">
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
                      className={`py-2 px-3 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
                        isSelected
                          ? 'bg-[#7367F0] text-white border-[#7367F0] shadow-xs'
                          : 'bg-slate-50 dark:bg-white/[0.03] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/[0.08] hover:border-slate-300'
                      }`}
                    >
                      {t(labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>
          </Card>
        </div>

        {/* Right Column: Wallpaper Customization & Interactive Live Preview */}
        <div className="lg:col-span-5 space-y-6">
          <Card className="p-5 space-y-5 bg-white dark:bg-[#2F3349] border-slate-200/80 dark:border-white/[0.08]">
            <div className="flex items-center space-x-2.5 border-b border-slate-100 dark:border-white/[0.06] pb-3.5">
              <div className="w-8 h-8 rounded-lg bg-[#FF9F43]/10 flex items-center justify-center text-[#FF9F43]">
                <Palette className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-sm font-extrabold text-slate-800 dark:text-white">
                  {t('whatsapp.chatWallpaper')}
                </h2>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  {t('whatsapp.chatWallpaperDesc')}
                </p>
              </div>
            </div>

            {/* Theme Swatches */}
            <div>
              <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block mb-2.5">
                {t('whatsapp.wallpaperThemeSelect') || 'Renk Teması'}
              </label>
              <div className="grid grid-cols-2 gap-2.5">
                {WALLPAPER_THEMES.map((theme) => {
                  const isSelected = settings.wallpaperTheme === theme.id;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      onClick={() => updateSettings({ wallpaperTheme: theme.id })}
                      className={`flex items-center space-x-2.5 p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                        isSelected
                          ? 'border-[#7367F0] ring-2 ring-[#7367F0]/30 bg-[#7367F0]/5 dark:bg-[#7367F0]/15'
                          : 'border-slate-200/80 dark:border-white/[0.08] bg-slate-50/60 dark:bg-white/[0.02] hover:border-slate-300'
                      }`}
                    >
                      <div
                        className="w-5 h-5 rounded-full shrink-0 shadow-xs flex items-center justify-center"
                        style={{ backgroundColor: theme.previewColor }}
                      >
                        {isSelected && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
                        {t(theme.nameKey)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Interactive Live Chat Preview */}
            <div className="pt-3">
              <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block mb-2 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#28C76F]" />
                {t('whatsapp.livePreview')}
              </label>

              <div
                className="relative rounded-2xl overflow-hidden border border-slate-200 dark:border-white/[0.12] p-4 shadow-inner min-h-[260px] flex flex-col justify-end space-y-3"
                style={previewWallpaperStyle}
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
          </Card>
        </div>
      </div>
    </div>
  );
};
