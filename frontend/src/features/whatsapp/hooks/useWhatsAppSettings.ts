import { useState, useEffect, useCallback } from 'react';
import {
  type SoundPresetId,
  playSoundPreset,
  triggerInboundNotification,
  showDesktopNotification,
} from '../lib/whatsappAudio';
import { type WallpaperThemeId } from '../lib/whatsappWallpapers';

export interface WhatsAppCustomizationSettings {
  soundEnabled: boolean;
  soundPreset: SoundPresetId;
  soundVolume: number; // 0 to 1
  playWhenTabActive: boolean;
  desktopNotificationsEnabled: boolean;
  wallpaperTheme: WallpaperThemeId;
  customWallpaperColor: string;
  fontSize: 'small' | 'medium' | 'large';
  enterIsSend: boolean;
}

export const DEFAULT_WHATSAPP_SETTINGS: WhatsAppCustomizationSettings = {
  soundEnabled: true,
  soundPreset: 'whatsapp_classic',
  soundVolume: 0.8,
  playWhenTabActive: true,
  desktopNotificationsEnabled: false,
  wallpaperTheme: 'whatsapp_default',
  customWallpaperColor: '#0b141a',
  fontSize: 'medium',
  enterIsSend: true,
};

const SETTINGS_STORAGE_KEY = 'tezlify_whatsapp_customization';
const SETTINGS_CHANGED_EVENT = 'tezlify:whatsapp_settings_updated';

function getStoredSettings(): WhatsAppCustomizationSettings {
  if (typeof window === 'undefined') return DEFAULT_WHATSAPP_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const hasGranted = 'Notification' in window && Notification.permission === 'granted';
    return {
      ...DEFAULT_WHATSAPP_SETTINGS,
      desktopNotificationsEnabled: hasGranted ? (parsed.desktopNotificationsEnabled ?? true) : Boolean(parsed.desktopNotificationsEnabled),
      ...parsed,
    };
  } catch (err) {
    console.warn('[WhatsApp Settings] Failed to read stored settings:', err);
    return DEFAULT_WHATSAPP_SETTINGS;
  }
}

function persistSettings(settings: WhatsAppCustomizationSettings): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: settings }));
  } catch (err) {
    console.warn('[WhatsApp Settings] Failed to persist settings:', err);
  }
}

export function useWhatsAppSettings() {
  const [settings, setSettings] = useState<WhatsAppCustomizationSettings>(getStoredSettings);

  // Sync settings reactively across multiple components and tabs
  useEffect(() => {
    const handleUpdate = (e: Event) => {
      const customEvent = e as CustomEvent<WhatsAppCustomizationSettings>;
      if (customEvent.detail) {
        setSettings(customEvent.detail);
      } else {
        setSettings(getStoredSettings());
      }
    };

    const handleStorage = (e: StorageEvent) => {
      if (e.key === SETTINGS_STORAGE_KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          setSettings({ ...DEFAULT_WHATSAPP_SETTINGS, ...parsed });
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener(SETTINGS_CHANGED_EVENT, handleUpdate);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, handleUpdate);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const updateSettings = useCallback((partial: Partial<WhatsAppCustomizationSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      persistSettings(next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_WHATSAPP_SETTINGS);
    persistSettings(DEFAULT_WHATSAPP_SETTINGS);
  }, []);

  const testSound = useCallback((presetId?: SoundPresetId, volume?: number) => {
    const targetPreset = presetId ?? settings.soundPreset;
    const targetVolume = volume ?? settings.soundVolume;
    playSoundPreset(targetPreset, targetVolume);
  }, [settings.soundPreset, settings.soundVolume]);

  const requestNotificationPermission = useCallback(async (): Promise<boolean> => {
    if (typeof window === 'undefined' || !('Notification' in window)) return false;
    try {
      const permission = await Notification.requestPermission();
      const granted = permission === 'granted';
      updateSettings({ desktopNotificationsEnabled: granted });
      return granted;
    } catch (e) {
      console.warn('[WhatsApp Settings] Permission request error:', e);
      return false;
    }
  }, [updateSettings]);

  const testDesktopNotification = useCallback(async (title?: string, body?: string): Promise<boolean> => {
    if (typeof window === 'undefined' || !('Notification' in window)) return false;
    if (Notification.permission !== 'granted') {
      const granted = await requestNotificationPermission();
      if (!granted) return false;
    }
    return await showDesktopNotification({
      title: title || 'Tezlify WhatsApp',
      body: body || 'Chrome masaüstü bildirimi başarıyla çalışıyor! 🔔',
    });
  }, [requestNotificationPermission]);

  const notifyInbound = useCallback((senderName?: string, body?: string) => {
    triggerInboundNotification({
      soundEnabled: settings.soundEnabled,
      soundPreset: settings.soundPreset,
      soundVolume: settings.soundVolume,
      desktopNotificationsEnabled: settings.desktopNotificationsEnabled,
      senderName,
      body,
    });
  }, [settings]);

  return {
    settings,
    updateSettings,
    resetSettings,
    testSound,
    requestNotificationPermission,
    testDesktopNotification,
    notifyInbound,
  };
}
