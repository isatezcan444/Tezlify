import React, { useState, useEffect } from 'react';
import { 
  Key, 
  Plus, 
  Trash2, 
  Copy, 
  Check, 
  AlertTriangle, 
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  Loader2
} from 'lucide-react';
import { Card, Badge, Button, Modal } from '../../../components/ui';
import { FormSection } from '../../../components/forms';
import { ApiClient } from '../../../api/client';
import { ApiKeyItem, ApiKeyCreatedItem } from '../../../types';
import { useToast } from '../../../context/ToastContext';
import { useI18n } from '../../../context/I18nContext';

export const ApiKeysSection: React.FC = () => {
  const toast = useToast();
  const { t, language } = useI18n();
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Creation modal state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [expiresDays, setExpiresDays] = useState<number | undefined>(undefined);
  const [creating, setCreating] = useState(false);

  // Success reveal modal
  const [createdKeyData, setCreatedKeyData] = useState<ApiKeyCreatedItem | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchKeys = async () => {
    try {
      setLoading(true);
      const res = await ApiClient.getApiKeys();
      setKeys(res.items);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('integrations.loading');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyName.trim()) {
      toast.error(t('integrations.keyNameRequired'));
      return;
    }
    try {
      setCreating(true);
      const res = await ApiClient.createApiKey(keyName.trim(), expiresDays);
      setCreatedKeyData(res);
      setIsCreateOpen(false);
      setKeyName('');
      setExpiresDays(undefined);
      fetchKeys();
      toast.success(t('integrations.keyCreatedSuccess'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('toast.errorTitle');
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = () => {
    if (!createdKeyData?.raw_key) return;
    navigator.clipboard.writeText(createdKeyData.raw_key);
    setCopied(true);
    toast.success(t('integrations.copiedSuccess', { label: t('integrations.fullKeySecretLabel') }));
    setTimeout(() => setCopied(false), 2500);
  };

  const handleToggle = async (keyItem: ApiKeyItem) => {
    try {
      const updated = await ApiClient.toggleApiKey(keyItem.id);
      setKeys((prev) => prev.map((k) => (k.id === updated.id ? updated : k)));
      toast.success(updated.is_active ? t('integrations.keyActivatedSuccess') : t('integrations.keyDeactivatedSuccess'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('toast.errorTitle');
      toast.error(msg);
    }
  };

  const handleDelete = async (keyItem: ApiKeyItem) => {
    const confirmed = await toast.confirm({
      title: t('integrations.deleteKeyConfirmTitle'),
      message: t('integrations.deleteKeyConfirmMsg', { name: keyItem.name }),
      confirmText: t('integrations.delete'),
      cancelText: t('integrations.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await ApiClient.deleteApiKey(keyItem.id);
      setKeys((prev) => prev.filter((k) => k.id !== keyItem.id));
      toast.success(t('integrations.keyDeletedSuccess'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('toast.errorTitle');
      toast.error(msg);
    }
  };

  const locale = language === 'tr' ? 'tr-TR' : 'en-US';

  return (
    <Card className="p-5 sm:p-6 space-y-4">
      <FormSection
        title={t('integrations.apiKeysTitle')}
        subtitle={t('integrations.apiKeysSubtitle')}
        icon={Key}
        action={
          <Button
            onClick={() => setIsCreateOpen(true)}
            size="sm"
            className="space-x-1.5 font-semibold text-xs shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('integrations.createNewKey')}</span>
          </Button>
        }
      >
        {loading ? (
          <div className="flex items-center justify-center p-8 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2 text-[#7367F0]" />
            <span className="text-xs">{t('integrations.loading')}</span>
          </div>
        ) : keys.length === 0 ? (
          <div className="text-center py-8 p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-dashed border-slate-200 dark:border-white/10 space-y-2">
            <Key className="w-8 h-8 text-slate-400 mx-auto opacity-40" />
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
              {t('integrations.emptyKeysTitle')}
            </p>
            <p className="text-[11px] text-slate-400 max-w-md mx-auto leading-relaxed">
              {t('integrations.emptyKeysDesc')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-white/[0.04]">
            {keys.map((k) => (
              <div key={k.id} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-xs text-slate-800 dark:text-slate-200">{k.name}</span>
                    {k.is_active ? (
                      <Badge variant="success">{t('integrations.active')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('integrations.disabled')}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-slate-400 font-mono">
                    <span>
                      {t('integrations.prefix')}: <strong className="text-slate-600 dark:text-slate-300">{k.key_prefix}...</strong>
                    </span>
                    <span>•</span>
                    <span>
                      {t('integrations.created')}: {new Date(k.created_at).toLocaleDateString(locale)}
                    </span>
                    {k.last_used_at ? (
                      <>
                        <span>•</span>
                        <span className="text-emerald-500">
                          {t('integrations.lastUsed')}: {new Date(k.last_used_at).toLocaleDateString(locale)}
                        </span>
                      </>
                    ) : (
                      <>
                        <span>•</span>
                        <span className="text-slate-400">{t('integrations.neverUsed')}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggle(k)}
                    className="text-xs space-x-1 h-8"
                  >
                    {k.is_active ? (
                      <>
                        <ToggleRight className="w-3.5 h-3.5 text-emerald-500" />
                        <span>{t('integrations.deactivate')}</span>
                      </>
                    ) : (
                      <>
                        <ToggleLeft className="w-3.5 h-3.5 text-slate-400" />
                        <span>{t('integrations.activate')}</span>
                      </>
                    )}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(k)}
                    className="p-1.5 px-2.5 h-8"
                    title={t('integrations.delete')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </FormSection>

      {/* Create Key Modal */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title={t('integrations.createKeyModalTitle')}
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            {t('integrations.createKeyModalDesc')}
          </p>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              {t('integrations.keyNameLabel')} <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder={t('integrations.keyNamePlaceholder')}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-[#1E2235] text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#7367F0]"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              {t('integrations.keyExpiryLabel')}
            </label>
            <select
              value={expiresDays || ''}
              onChange={(e) => setExpiresDays(e.target.value ? Number(e.target.value) : undefined)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-[#1E2235] text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#7367F0]"
            >
              <option value="">{t('integrations.unlimitedExpiry')}</option>
              <option value="30">{t('integrations.daysUnit', { count: '30' })}</option>
              <option value="90">{t('integrations.daysUnit', { count: '90' })}</option>
              <option value="365">{t('integrations.oneYear')}</option>
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-white/[0.05]">
            <Button variant="outline" size="sm" type="button" onClick={() => setIsCreateOpen(false)}>
              {t('integrations.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={creating} className="space-x-1.5 font-bold">
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              <span>{t('integrations.generateAndSave')}</span>
            </Button>
          </div>
        </form>
      </Modal>

      {/* Reveal Modal (Shown ONLY ONCE upon creation) */}
      <Modal
        isOpen={!!createdKeyData}
        onClose={() => setCreatedKeyData(null)}
        title={t('integrations.keyCreatedTitle')}
      >
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-start gap-2.5 text-amber-600 dark:text-amber-400 text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <p>
              <strong>{t('integrations.keyCreatedWarningTitle')}:</strong> {t('integrations.keyCreatedWarningText')}
            </p>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              {t('integrations.fullKeySecretLabel')}:
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={createdKeyData?.raw_key || ''}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-white/10 bg-slate-100 dark:bg-black/30 text-emerald-600 dark:text-emerald-400 select-all"
              />
              <Button
                variant={copied ? 'success' : 'default'}
                size="sm"
                onClick={handleCopy}
                className="shrink-0 space-x-1"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? t('integrations.copied') : t('integrations.copy')}</span>
              </Button>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button size="sm" onClick={() => setCreatedKeyData(null)}>
              {t('integrations.keySavedCloseBtn')}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
};
