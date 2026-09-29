/**
 * Anti-Ban policy: the whole settings domain in one place.
 *
 * WHY THIS EXISTS
 * ---------------
 * This was ~170 lines of state, four handlers and two derived values living
 * inside WhatsAppHubPage — a file that is already 3,200 lines and owns
 * conversations, sessions, sync gating and message hydration. Anti-ban is
 * none of that: it is one self-contained form that reads a config, edits it,
 * and persists it. Extracting it is what lets the panel render as a component
 * instead of 430 lines of inline JSX inside the page.
 *
 * The behaviour is unchanged. `savedConfig` stays the last server-confirmed
 * value so `hasUnsavedChanges` is a real comparison rather than a guess, and
 * every write still goes through the API and only then to localStorage — the
 * persisted copy is never the source of truth for what is on screen.
 */
import { useState, useCallback, useEffect } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { ApiClient } from '../../../api/client';
import {
  DEFAULT_ANTI_BAN_CONFIG,
  getStoredAntiBanConfig,
  isConfigEqual,
  resolvePresetFromConfig,
  saveAntiBanConfig,
  calculateRiskLevel,
  ANTI_BAN_PRESETS,
  type AntiBanConfig,
} from '../../../utils/antiBanSettings';

export function useAntiBanSettings() {
  const { t } = useI18n();
  const toast = useToast();

  const [savedConfig, setSavedConfig] = useState<AntiBanConfig>(getStoredAntiBanConfig());
  const [config, setConfig] = useState<AntiBanConfig>(getStoredAntiBanConfig());
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // The database is the source of truth for the live policy; localStorage only
  // paints the first frame so the panel is never empty while this is in
  // flight. A failure here is deliberately non-fatal — the cached config stays
  // on screen and the reason is logged, because showing a blank policy form on
  // a transient network blip would be worse than showing a slightly stale one.
  useEffect(() => {
    let cancelled = false;
    ApiClient.getAntiBanSettings()
      .then((remote) => {
        if (cancelled || !remote) return;
        const resolvedPreset = resolvePresetFromConfig(remote);
        const normalized = { ...remote, preset: remote.preset || resolvedPreset };
        setConfig(normalized);
        setSavedConfig(normalized);
        saveAntiBanConfig(normalized);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn('Anti-ban config failed to load from backend, using local storage:', e);
        }
      });
    return () => { cancelled = true; };
  }, []);

  /** Shared by save and reset: the server response is what becomes "saved". */
  const commit = useCallback(async (payload: AntiBanConfig) => {
    setIsSaving(true);
    try {
      const updated = await ApiClient.updateAntiBanSettings(payload);
      setSavedConfig(updated);
      setConfig(updated);
      saveAntiBanConfig(updated);
      setSaveSuccess(true);
      toast.success(t('whatsapp.policySavedSuccess'), t('toast.policySavedTitle'));
      setTimeout(() => setSaveSuccess(false), 3500);
    } finally {
      // No catch here on purpose: the callers own the messaging, and they need
      // to tell "save failed" and "reset failed" apart. Swallowing or
      // re-wrapping the error here would lose that distinction.
      setIsSaving(false);
    }
  }, [t, toast]);

  const handleSave = useCallback(async () => {
    try {
      await commit(config);
    } catch (err) {
      // `unknown` rather than `any`: the error can come from anywhere, so the
      // only safe read is the message the API layer attaches to Error.
      const message = err instanceof Error ? err.message : t('common.error');
      toast.error(message, t('toast.errorTitle'));
    }
  }, [config, commit, t, toast]);

  const handleResetDefaults = useCallback(async () => {
    const confirmed = await toast.confirm({
      title: t('whatsapp.resetDefaults') + '?',
      message: t('whatsapp.presetBalancedDesc'),
      confirmText: t('common.save'),
      cancelText: t('common.cancel'),
      variant: 'warning',
    });
    if (!confirmed) return;
    try {
      await commit(DEFAULT_ANTI_BAN_CONFIG);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.error');
      toast.error(message, t('common.error'));
    }
  }, [commit, t, toast]);

  const handleRevert = useCallback(() => {
    setConfig(savedConfig);
    toast.info(t('whatsapp.discardChanges'), t('common.info'));
  }, [savedConfig, t, toast]);

  const handlePresetChange = useCallback((presetKey: keyof typeof ANTI_BAN_PRESETS) => {
    setConfig((prev) => ({ ...prev, preset: presetKey, ...ANTI_BAN_PRESETS[presetKey] }));
  }, []);

  const handleCustomChange = useCallback((field: keyof AntiBanConfig, value: unknown) => {
    setConfig((prev) => {
      const updated = { ...prev, [field]: value } as AntiBanConfig;
      // Editing any single field can make the config match a different preset
      // (or none), so the label is always recomputed rather than kept.
      updated.preset = resolvePresetFromConfig(updated);
      return updated;
    });
  }, []);

  const hasUnsavedChanges = !isConfigEqual(config, savedConfig);
  const riskInfo = calculateRiskLevel(config.min_delay_seconds, config.daily_message_limit);

  return {
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
  };
}

export type UseAntiBanSettings = ReturnType<typeof useAntiBanSettings>;
