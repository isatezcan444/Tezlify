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
  const { t } = useI18n();
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
      const msg = err instanceof Error ? err.message : 'API anahtarları alınamadı';
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
      toast.error('Lütfen bir anahtar adı girin');
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
      toast.success('API anahtarı başarıyla oluşturuldu');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'API anahtarı oluşturulamadı';
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = () => {
    if (!createdKeyData?.raw_key) return;
    navigator.clipboard.writeText(createdKeyData.raw_key);
    setCopied(true);
    toast.success('API anahtarı panoya kopyalandı');
    setTimeout(() => setCopied(false), 2500);
  };

  const handleToggle = async (keyItem: ApiKeyItem) => {
    try {
      const updated = await ApiClient.toggleApiKey(keyItem.id);
      setKeys((prev) => prev.map((k) => (k.id === updated.id ? updated : k)));
      toast.success(updated.is_active ? 'Anahtar etkinleştirildi' : 'Anahtar devre dışı bırakıldı');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Durum güncellenemedi';
      toast.error(msg);
    }
  };

  const handleDelete = async (keyItem: ApiKeyItem) => {
    const confirmed = await toast.confirm({
      title: 'API Anahtarını Sil',
      message: `"${keyItem.name}" adlı anahtarı silmek istediğinize emin misiniz? Bu anahtarı kullanan dış sistemlerin erişimi anında kesilecektir.`,
      confirmText: 'Evet, Sil',
      cancelText: 'Vazgeç',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await ApiClient.deleteApiKey(keyItem.id);
      setKeys((prev) => prev.filter((k) => k.id !== keyItem.id));
      toast.success('API anahtarı silindi');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Anahtar silinemedi';
      toast.error(msg);
    }
  };

  return (
    <Card className="p-5 sm:p-6 space-y-4">
      <FormSection
        title={t('integrations.apiKeysTitle') || 'REST API Anahtarları'}
        subtitle={t('integrations.apiKeysSubtitle') || 'Dış sistemler, Zapier ve web sitenizden güvenli lead aktarımı için API anahtarları yönetin.'}
        icon={Key}
        action={
          <Button
            onClick={() => setIsCreateOpen(true)}
            className="space-x-1.5 font-bold shadow-md shadow-[#7367F0]/20 shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>{t('integrations.createNewKey') || 'Yeni Anahtar Üret'}</span>
          </Button>
        }
      >
        {loading ? (
          <div className="flex items-center justify-center p-8 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            <span>Yükleniyor...</span>
          </div>
        ) : keys.length === 0 ? (
          <div className="text-center py-8 p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-dashed border-slate-300 dark:border-white/10 space-y-2">
            <Key className="w-8 h-8 text-slate-400 mx-auto opacity-40" />
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300">Henüz bir API anahtarı üretmediniz</p>
            <p className="text-[11px] text-slate-400 max-w-md mx-auto">
              Zapier, Make, n8n veya kendi web sitenizin iletişim formundan lead aktarmak için yukarıdaki butondan bir anahtar oluşturun.
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
                      <Badge variant="success">Aktif</Badge>
                    ) : (
                      <Badge variant="secondary">Devre Dışı</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-slate-400 dark:text-slate-400 font-mono">
                    <span>Ön Ek: <strong className="text-slate-600 dark:text-slate-300">{k.key_prefix}...</strong></span>
                    <span>•</span>
                    <span>Oluşturulma: {new Date(k.created_at).toLocaleDateString('tr-TR')}</span>
                    {k.last_used_at && (
                      <>
                        <span>•</span>
                        <span className="text-emerald-500">Son Kullanım: {new Date(k.last_used_at).toLocaleDateString('tr-TR')}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggle(k)}
                    className="text-xs space-x-1"
                  >
                    {k.is_active ? (
                      <>
                        <ToggleRight className="w-4 h-4 text-emerald-500" />
                        <span>Pasife Al</span>
                      </>
                    ) : (
                      <>
                        <ToggleLeft className="w-4 h-4 text-slate-400" />
                        <span>Aktifleştir</span>
                      </>
                    )}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(k)}
                    className="p-1.5 px-2.5"
                    title="Anahtarı Sil"
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
        title="Yeni API Anahtarı Oluştur"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Dış sistemlerin (Zapier, formlar, CRM) Tezlify hesabınıza erişmesi için benzersiz bir gizli anahtar oluşturulacaktır.
          </p>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              Anahtar Adı <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="Örn: Elementor İletişim Formu, Zapier Webhook"
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-[#1E2235] text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#7367F0]"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              Geçerlilik Süresi (Opsiyonel)
            </label>
            <select
              value={expiresDays || ''}
              onChange={(e) => setExpiresDays(e.target.value ? Number(e.target.value) : undefined)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-[#1E2235] text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#7367F0]"
            >
              <option value="">Süresiz (Tavsiye Edilen)</option>
              <option value="30">30 Gün</option>
              <option value="90">90 Gün</option>
              <option value="365">1 Yıl</option>
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-white/[0.05]">
            <Button variant="outline" type="button" onClick={() => setIsCreateOpen(false)}>
              İptal
            </Button>
            <Button type="submit" disabled={creating} className="space-x-1.5 font-bold">
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              <span>Üret ve Kaydet</span>
            </Button>
          </div>
        </form>
      </Modal>

      {/* Reveal Modal (Shown ONLY ONCE upon creation) */}
      <Modal
        isOpen={!!createdKeyData}
        onClose={() => setCreatedKeyData(null)}
        title="API Anahtarınız Hazır"
      >
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-start gap-2.5 text-amber-600 dark:text-amber-400 text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <p>
              <strong>Dikkat:</strong> Bu anahtar güvenlik gerekçesiyle veritabanında şifrelenmiş (SHA-256) olarak saklanır. <strong>Bu ekranı kapattıktan sonra anahtarı bir daha asla tam olarak görüntüleyemezsiniz.</strong> Lütfen güvenli bir yere kopyalayın.
            </p>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              Tam Gizli API Anahtarı:
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
                onClick={handleCopy}
                className="shrink-0 space-x-1"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? 'Kopyalandı' : 'Kopyala'}</span>
              </Button>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={() => setCreatedKeyData(null)}>
              Kaydettim, Kapat
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
};
