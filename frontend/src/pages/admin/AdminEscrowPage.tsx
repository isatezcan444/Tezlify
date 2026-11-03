import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  Eye,
  EyeOff,
  Lock,
  RefreshCw,
  AlertTriangle,
  FileCheck2,
  Clock,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { useToast } from '../../context/ToastContext';
import { EscrowApi } from '../../api/admin';
import { EscrowStatusResponse } from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { StatusBadge, StatusVariant } from '../../components/ui/StatusBadge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';

interface AdminEscrowPageProps {
  onNavigate?: (tab: string) => void;
}

const MASK = '••••';

/**
 * Felaket Kurtarma / Encryption Key Escrow.
 *
 * GUVENLIK SOZLESMESI (bu dosyada ihlal edilemez):
 * - Anahtar YALNIZCA bilesen state'inde yasar. `localStorage`, `sessionStorage`,
 *   `console`, analytics veya hata izleyiciye YAZILMAZ.
 * - Anahtar `reveal_ttl_seconds` sonunda kendiliginden silinir; "Goruntulemeyi
 *   kapat" da ayni seyi yapar. Sekme kapanirsa state zaten olur.
 * - Kopyalama dugmesi BILEREK yok: panoya alinan bir anahtar, isletim sistemi
 *   panosunda ve pano gecmisinde sinirsiz sure kalir.
 * - Anahtari gostermek icin once Google ile YENIDEN giris (step-up) gerekir;
 *   mevcut oturum tek basina yetmez.
 */
export const AdminEscrowPage: React.FC<AdminEscrowPageProps> = () => {
  const { t } = useI18n();
  const toast = useToast();
  const { user, profile, isAdmin } = useAuth();

  const [status, setStatus] = useState<EscrowStatusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  // Anahtar burada tutulur ve baska HICBIR yere kopyalanmaz.
  const [secret, setSecret] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number>(0);
  const secretRef = useRef<string | null>(null);

  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

  const clearSecret = useCallback(() => {
    secretRef.current = null;
    setSecret(null);
    setRemaining(0);
  }, []);

  const loadStatus = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await EscrowApi.getStatus();
      setStatus(res);
      setError(null);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'UNKNOWN';
      setError(message);
      setStatus(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!showAdmin) {
      setLoading(false);
      return;
    }
    void loadStatus(true);
  }, [showAdmin, loadStatus]);

  // Bilesen sokuldugunde anahtar referansi da dusurulur.
  useEffect(() => {
    return () => {
      secretRef.current = null;
    };
  }, []);

  // Geri sayim: sure bitince anahtar ekrandan silinir.
  useEffect(() => {
    if (!secret) return undefined;
    const timer = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          clearSecret();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [secret, clearSecret]);

  const doReveal = useCallback(async () => {
    setBusy(true);
    try {
      const res = await EscrowApi.reveal(true);
      secretRef.current = res.key;
      setSecret(res.key);
      setRemaining(res.expires_in);
      toast.success(t('escrow.revealSuccess'), t('common.success'));
      void loadStatus();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'UNKNOWN';
      const key =
        message === 'SUPER_ADMIN_REQUIRED'
          ? 'escrow.errSuperAdmin'
          : message === 'PANEL_DISABLED'
            ? 'escrow.errDisabled'
            : message === 'RATE_LIMITED'
              ? 'escrow.errRateLimited'
              : 'escrow.errGeneric';
      toast.error(t(key), t('toast.errorTitle'));
      // Basarisizlikta anahtar gosterme.
      clearSecret();
    } finally {
      setBusy(false);
    }
  }, [clearSecret, loadStatus, t, toast]);

  const handleStepUp = useCallback(async () => {
    setBusy(true);
    try {
      const res = await EscrowApi.startStepUp();
      // Tam sayfa yonlendirme: Google'dan donunce panel geri acilir.
      window.location.assign(res.authorization_url);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'UNKNOWN';
      toast.error(
        message === 'SUPER_ADMIN_REQUIRED' ? t('escrow.errSuperAdmin') : t('escrow.errGeneric'),
        t('toast.errorTitle'),
      );
      setBusy(false);
    }
  }, [t, toast]);

  // Google donusu: ?stepup=ok ise onay iste, sonra goruntule.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('stepup');
    if (!outcome) return;

    // Parametreyi adres cubugundan temizle: yenilemede tekrar tetiklenmesin.
    params.delete('stepup');
    params.delete('reason');
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);

    if (outcome !== 'ok') {
      toast.error(t('escrow.stepUpDenied'), t('toast.errorTitle'));
      return;
    }

    const confirmReveal = async () => {
      const ok = await toast.confirm({
        title: t('escrow.confirmTitle'),
        message: t('escrow.confirmMessage'),
        confirmText: t('escrow.confirmButton'),
        cancelText: t('common.cancel'),
        variant: 'warning',
      });
      if (ok) await doReveal();
    };
    void confirmReveal();
  }, [doReveal, t, toast]);

  const handleAttest = useCallback(
    async (copy: 'A' | 'B') => {
      const anchor = status?.anchor8;
      if (!anchor) return;
      const ok = await toast.confirm({
        title: t('escrow.attestConfirmTitle'),
        message: t('escrow.attestConfirmMessage', { copy }),
        confirmText: t('escrow.attestButton'),
        cancelText: t('common.cancel'),
        variant: 'primary',
      });
      if (!ok) return;
      try {
        await EscrowApi.attestCopy(copy, anchor);
        toast.success(t('escrow.attestSuccess', { copy }), t('common.success'));
        void loadStatus();
      } catch {
        toast.error(t('escrow.errGeneric'), t('toast.errorTitle'));
      }
    },
    [loadStatus, status?.anchor8, t, toast],
  );

  const stateVariant = (): StatusVariant => {
    switch (status?.state) {
      case 'PRESENT':
        return 'active';
      case 'MISSING':
        return 'failed';
      case 'INVALID':
        return 'danger';
      case 'UNREACHABLE':
        return 'warning';
      default:
        return 'neutral';
    }
  };

  const stateLabel = (): string => {
    switch (status?.state) {
      case 'PRESENT':
        return t('escrow.statePresent');
      case 'MISSING':
        return t('escrow.stateMissing');
      case 'INVALID':
        return t('escrow.stateInvalid');
      case 'UNREACHABLE':
        return t('escrow.stateUnreachable');
      default:
        return t('escrow.stateUnknown');
    }
  };

  const groups = (): string[] => {
    if (!secret) return [];
    const out: string[] = [];
    for (let i = 0; i < 16; i += 1) out.push(secret.slice(i * 4, i * 4 + 4));
    return out;
  };

  const copyBadge = (copy: 'A' | 'B') => {
    const entry = status?.copies?.[copy];
    if (!entry) return <StatusBadge status="neutral" label={t('escrow.copyNotAttested')} size="sm" />;
    const matches = entry.anchor8 === status?.anchor8;
    return (
      <StatusBadge
        status={matches ? 'active' : 'warning'}
        label={matches ? t('escrow.copyAttested') : t('escrow.copyMismatch')}
        size="sm"
      />
    );
  };

  if (!showAdmin) {
    return (
      <AdminShell title={t('titles.adminEscrow')} subtitle={t('titles.adminEscrowSub')}>
        <Card>
          <CardContent className="p-8 flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
            <ShieldAlert className="w-5 h-5 text-amber-500" />
            {t('escrow.superAdminOnly')}
          </CardContent>
        </Card>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      title={t('titles.adminEscrow')}
      subtitle={t('titles.adminEscrowSub')}
      lastUpdated={lastUpdated}
      onRefresh={() => void loadStatus()}
      isRefreshing={refreshing}
      badge={
        status ? (
          <StatusBadge status={stateVariant()} label={stateLabel()} size="sm" />
        ) : undefined
      }
    >
      {loading ? (
        <Card>
          <CardContent className="p-6 space-y-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="p-6 flex items-start gap-3 text-sm">
            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-slate-800 dark:text-slate-100">
                {error === 'PANEL_DISABLED'
                  ? t('escrow.errDisabled')
                  : error === 'SUPER_ADMIN_REQUIRED'
                    ? t('escrow.errSuperAdmin')
                    : t('escrow.errGeneric')}
              </p>
              <p className="text-slate-500 dark:text-slate-400">{t('escrow.errHint')}</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* --- Anahtar karti --- */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-white/[0.06] flex items-center justify-center shrink-0">
                  <KeyRound className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-base">{t('escrow.cardTitle')}</CardTitle>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {status?.path}
                  </p>
                </div>
              </div>
              <StatusBadge status={stateVariant()} label={stateLabel()} />
            </CardHeader>
            <CardContent className="p-6 pt-0 space-y-5">
              {status?.state === 'UNREACHABLE' && (
                <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200 flex gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{t('escrow.unreachableHint')}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-xl border border-slate-200/80 dark:border-white/[0.08] p-4">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {t('escrow.anchor8')}
                  </p>
                  <p className="mt-1 font-mono text-lg text-slate-800 dark:text-slate-100">
                    {status?.anchor8 ?? '—'}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200/80 dark:border-white/[0.08] p-4">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {t('escrow.keyLength')}
                  </p>
                  <p className="mt-1 font-mono text-lg text-slate-800 dark:text-slate-100">
                    {status?.key_len ?? '—'}
                  </p>
                </div>
              </div>

              {/* Maskeli / acik anahtar alani */}
              <div className="rounded-xl border border-slate-200/80 dark:border-white/[0.08] p-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" />
                    {t('escrow.keyField')}
                  </p>
                  {secret && (
                    <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {t('escrow.hideIn', { seconds: remaining })}
                    </span>
                  )}
                </div>

                {secret ? (
                  <div className="space-y-1.5 font-mono text-sm sm:text-base text-slate-900 dark:text-slate-50 select-all">
                    {[0, 1, 2, 3].map((row) => (
                      <div key={row} className="flex flex-wrap gap-x-4 gap-y-1">
                        {groups()
                          .slice(row * 4, row * 4 + 4)
                          .map((group, idx) => {
                            const n = row * 4 + idx + 1;
                            return (
                              <span key={n} className="whitespace-nowrap">
                                <span className="text-slate-400 dark:text-slate-500 text-xs">
                                  {String(n).padStart(2, ' ')}:
                                </span>
                                {group}
                              </span>
                            );
                          })}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="font-mono text-sm sm:text-base text-slate-400 dark:text-slate-500 break-all">
                    {Array.from({ length: 16 })
                      .map(() => MASK)
                      .join(' ')}
                  </p>
                )}

                <div className="flex items-center gap-2 flex-wrap pt-1">
                  {secret ? (
                    <Button
                      variant="outline"
                      onClick={clearSecret}
                      className="h-10 px-4 rounded-xl text-xs font-semibold gap-2"
                    >
                      <EyeOff className="w-3.5 h-3.5" />
                      {t('escrow.hideButton')}
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void handleStepUp()}
                      disabled={busy || status?.state !== 'PRESENT'}
                      className="h-10 px-4 rounded-xl text-xs font-semibold gap-2"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      {t('escrow.revealButton')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => void loadStatus()}
                    disabled={refreshing}
                    className="h-10 px-3 rounded-xl text-xs font-semibold gap-2"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                    {t('admin.refreshNow')}
                  </Button>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 flex items-start gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                  {t('escrow.revealHint')}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* --- Fiziksel kopyalar --- */}
          <Card>
            <CardHeader className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-white/[0.06] flex items-center justify-center shrink-0">
                <FileCheck2 className="w-5 h-5 text-primary-600 dark:text-primary-400" />
              </div>
              <CardTitle className="text-base">{t('escrow.copiesTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="p-6 pt-0 space-y-4">
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('escrow.copiesHint')}</p>

              {(['A', 'B'] as const).map((copy) => {
                const entry = status?.copies?.[copy];
                return (
                  <div
                    key={copy}
                    className="flex items-center justify-between gap-3 flex-wrap rounded-xl border border-slate-200/80 dark:border-white/[0.08] p-4"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                          {t('escrow.copyLabel', { copy })}
                        </span>
                        {copyBadge(copy)}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {entry
                          ? t('escrow.lastVerified', {
                              at: new Date(entry.attested_at).toLocaleString(),
                              by: entry.attested_by,
                            })
                          : t('escrow.neverVerified')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => void handleAttest(copy)}
                      disabled={!status?.anchor8}
                      className="h-9 px-3 rounded-xl text-xs font-semibold"
                    >
                      {t('escrow.attestButton')}
                    </Button>
                  </div>
                );
              })}

              <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <Eye className="w-3.5 h-3.5 shrink-0" />
                {status?.last_reveal
                  ? t('escrow.lastReveal', {
                      at: new Date(status.last_reveal.at).toLocaleString(),
                      by: status.last_reveal.by,
                    })
                  : t('escrow.noRevealYet')}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </AdminShell>
  );
};
