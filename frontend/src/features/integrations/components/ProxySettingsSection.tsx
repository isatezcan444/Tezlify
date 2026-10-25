import React, { useState, useEffect } from 'react';
import { 
  Globe, 
  ShieldCheck, 
  CheckCircle2, 
  XCircle, 
  RotateCw, 
  Zap, 
  Clock, 
  AlertCircle, 
  Shuffle, 
  Repeat,
  Save,
  Server
} from 'lucide-react';
import { Card, Badge, Button } from '../../../components/ui';
import { FormSection } from '../../../components/forms';
import { ApiClient } from '../../../api/client';
import { ProxyPoolStatus, ProxyTestResult } from '../../../types';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';

export const ProxySettingsSection: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isTesting, setIsTesting] = useState<boolean>(false);

  const [enabled, setEnabled] = useState<boolean>(false);
  const [rotationStrategy, setRotationStrategy] = useState<'ROUND_ROBIN' | 'RANDOM'>('ROUND_ROBIN');
  const [proxiesText, setProxiesText] = useState<string>('');
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(10);
  const [activeCount, setActiveCount] = useState<number>(0);
  const [testResults, setTestResults] = useState<ProxyTestResult[] | null>(null);

  // Fetch settings on mount
  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);

    ApiClient.getProxySettings()
      .then((data: ProxyPoolStatus) => {
        if (!isMounted) return;
        setEnabled(data.enabled);
        setRotationStrategy((data.rotation_strategy as 'ROUND_ROBIN' | 'RANDOM') || 'ROUND_ROBIN');
        setProxiesText((data.proxies || []).join('\n'));
        setTimeoutSeconds(data.timeout_seconds || 10);
        setActiveCount(data.active_proxies || (data.proxies || []).length);
      })
      .catch((err) => {
        console.warn('[ProxySettingsSection] Failed to load proxy settings:', err);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const proxies = proxiesText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));

      const res = await ApiClient.updateProxySettings({
        enabled,
        proxies,
        rotation_strategy: rotationStrategy,
        timeout_seconds: timeoutSeconds,
      });

      setEnabled(res.enabled);
      setRotationStrategy((res.rotation_strategy as 'ROUND_ROBIN' | 'RANDOM') || 'ROUND_ROBIN');
      setProxiesText((res.proxies || []).join('\n'));
      setTimeoutSeconds(res.timeout_seconds || 10);
      setActiveCount(res.active_proxies || (res.proxies || []).length);

      toast.success(t('settings.proxySaveSuccess'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.errorOccurred');
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResults(null);
    try {
      // First save if needed or test current pool
      const results = await ApiClient.testProxy();
      setTestResults(results);

      const allSuccess = results.length > 0 && results.every((r) => r.success);
      if (allSuccess) {
        toast.success(t('settings.proxyTestSuccess'));
      } else {
        toast.warning(t('settings.proxyTestPartialFail'));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.errorOccurred');
      toast.error(msg);
    } finally {
      setIsTesting(false);
    }
  };

  const proxiesList = proxiesText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  return (
    <Card className="p-5 sm:p-6 space-y-6 w-full">
      <FormSection
        title={t('settings.proxyPoolTitle')}
        subtitle={t('settings.proxyPoolSubtitle')}
        icon={Globe}
      >
        <div className="space-y-6 pt-1">
          {/* Enable Toggle & Summary Pill */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                  {t('settings.proxyPoolEnabled')}
                </span>
                {enabled ? (
                  <Badge variant="success" className="text-[10px] font-mono uppercase font-bold">
                    {t('common.active')} ({activeCount})
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] font-mono uppercase font-bold">
                    {t('common.disabled')}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] leading-relaxed">
                {t('settings.proxyPoolEnabledDesc')}
              </p>
            </div>

            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                disabled={isLoading || isSaving}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#7367F0]" />
            </label>
          </div>

          {/* Rotation Strategy Selector */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <RotateCw className="w-3.5 h-3.5 text-[#7367F0]" />
              {t('settings.proxyRotationStrategy')}
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setRotationStrategy('ROUND_ROBIN')}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                  rotationStrategy === 'ROUND_ROBIN'
                    ? 'bg-[#7367F0]/10 border-[#7367F0] ring-1 ring-[#7367F0]/50'
                    : 'bg-slate-50 dark:bg-[#25293C] border-slate-200/60 dark:border-white/[0.05] hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <Repeat className="w-3.5 h-3.5 text-[#7367F0]" />
                    {t('settings.proxyStrategyRoundRobin')}
                  </span>
                  {rotationStrategy === 'ROUND_ROBIN' && (
                    <span className="w-2 h-2 rounded-full bg-[#7367F0]" />
                  )}
                </div>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  {t('settings.proxyStrategyRoundRobinDesc')}
                </p>
              </button>

              <button
                type="button"
                onClick={() => setRotationStrategy('RANDOM')}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                  rotationStrategy === 'RANDOM'
                    ? 'bg-[#7367F0]/10 border-[#7367F0] ring-1 ring-[#7367F0]/50'
                    : 'bg-slate-50 dark:bg-[#25293C] border-slate-200/60 dark:border-white/[0.05] hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <Shuffle className="w-3.5 h-3.5 text-[#FF9F43]" />
                    {t('settings.proxyStrategyRandom')}
                  </span>
                  {rotationStrategy === 'RANDOM' && (
                    <span className="w-2 h-2 rounded-full bg-[#FF9F43]" />
                  )}
                </div>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  {t('settings.proxyStrategyRandomDesc')}
                </p>
              </button>
            </div>
          </div>

          {/* Proxies List Textarea */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-[#28C76F]" />
                {t('settings.proxyListLabel')}
              </label>
              <span className="text-[11px] font-mono text-slate-400">
                {t('settings.proxyActiveCount')}: <strong className="text-[#7367F0]">{proxiesList.length}</strong>
              </span>
            </div>

            <textarea
              rows={5}
              value={proxiesText}
              onChange={(e) => setProxiesText(e.target.value)}
              placeholder={t('settings.proxyListPlaceholder')}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-slate-50 dark:bg-[#25293C] text-slate-800 dark:text-slate-100 font-mono text-xs focus:ring-2 focus:ring-[#7367F0]/20 focus:border-[#7367F0] outline-none transition-all placeholder:text-slate-400 dark:placeholder:text-slate-500 leading-relaxed"
            />

            <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-blue-500 shrink-0" />
              {t('settings.proxyListHelp')}
            </p>
          </div>

          {/* Action Buttons: Save & Test */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-white/[0.06]">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={isLoading || isSaving || isTesting || proxiesList.length === 0}
              className="gap-2 text-xs font-bold cursor-pointer"
            >
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              {isTesting ? t('settings.proxyTesting') : t('settings.proxyTestAllBtn')}
            </Button>

            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={isLoading || isSaving || isTesting}
              className="gap-2 text-xs font-bold shadow-md shadow-[#7367F0]/30 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              {t('common.save')}
            </Button>
          </div>

          {/* Live Test Results Badges */}
          {testResults && (
            <div className="space-y-3 pt-3 border-t border-slate-100 dark:border-white/[0.06] animate-fade-in">
              <div className="flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-300">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#28C76F]" />
                  {t('settings.proxyTestResultsTitle')}
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {testResults.filter((r) => r.success).length} / {testResults.length} {t('settings.proxyStatusWorking').toLowerCase()}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {testResults.map((result, idx) => {
                  // Mask password in proxy_url for display security
                  const cleanUrl = result.proxy_url.replace(/:[^:@]+@/, ':***@');

                  return (
                    <div
                      key={idx}
                      className={`p-3 rounded-xl border text-xs flex items-center justify-between gap-2 ${
                        result.success
                          ? 'bg-emerald-500/5 border-emerald-500/20 text-slate-700 dark:text-slate-200'
                          : 'bg-rose-500/5 border-rose-500/20 text-rose-700 dark:text-rose-300'
                      }`}
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="font-mono text-[11px] font-bold truncate">
                          {cleanUrl}
                        </p>
                        <div className="flex items-center gap-3 text-[10px] text-slate-400">
                          {result.exit_ip && (
                            <span>
                              {t('settings.proxyExitIp')}: <strong className="font-mono text-slate-700 dark:text-slate-300">{result.exit_ip}</strong>
                            </span>
                          )}
                          {typeof result.latency_ms === 'number' && (
                            <span>
                              {t('settings.proxyLatency')}: <strong className="font-mono text-emerald-600 dark:text-emerald-400">{result.latency_ms} ms</strong>
                            </span>
                          )}
                          {result.error && (
                            <span className="text-rose-500 truncate" title={result.error}>
                              {result.error}
                            </span>
                          )}
                        </div>
                      </div>

                      <Badge
                        variant={result.success ? 'success' : 'danger'}
                        className="text-[10px] uppercase font-mono font-bold shrink-0"
                      >
                        {result.success ? t('settings.proxyStatusWorking') : t('settings.proxyStatusFailed')}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </FormSection>
    </Card>
  );
};
