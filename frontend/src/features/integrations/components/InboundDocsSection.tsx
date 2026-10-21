import React, { useState } from 'react';
import { 
  Code2, 
  Copy, 
  Check, 
  Terminal, 
  Info
} from 'lucide-react';
import { Card, Button } from '../../../components/ui';
import { FormSection } from '../../../components/forms';
import { useToast } from '../../../context/ToastContext';
import { useI18n } from '../../../context/I18nContext';

export const InboundDocsSection: React.FC = () => {
  const toast = useToast();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<'rest' | 'inbound'>('rest');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(label);
    toast.success(t('integrations.copiedSuccess', { label }));
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const curlExample = `curl -X POST https://api.tezlify.com/api/v1/public/leads \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: tzf_live_YOUR_SECRET_KEY" \\
  -d '{
    "name": "Kuzey Mimarlık ve Tasarım",
    "phone": "+905321234567",
    "email": "iletisim@kuzeymimarlik.com",
    "category": "Mimarlık Ofisi",
    "city": "İstanbul",
    "district": "Kadıköy",
    "website": "https://kuzeymimarlik.com",
    "notes": "Web sitesi iletişim formundan gelen B2B teklif talebi",
    "send_whatsapp_welcome": true,
    "welcome_message": "Merhaba Kuzey Mimarlık yetkilisi, talebiniz tarafımıza ulaştı!"
  }'`;

  const jsonWebhookSchema = `{
  "name": "İşletme veya Kişi Adı",
  "phone": "05321234567 (E.164 veya yerel)",
  "email": "ornek@sirket.com",
  "city": "İstanbul",
  "district": "Şişli",
  "category": "Restoran & Kafe",
  "notes": "Web formundan iletilen özel notlar"
}`;

  return (
    <Card className="p-5 sm:p-6 space-y-4">
      <FormSection
        title={t('integrations.docsTitle')}
        subtitle={t('integrations.docsSubtitle')}
        icon={Code2}
        action={
          <div className="flex items-center gap-1.5 p-1 bg-slate-100 dark:bg-white/[0.05] rounded-lg self-start sm:self-auto text-xs font-semibold">
            <button
              onClick={() => setActiveTab('rest')}
              className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
                activeTab === 'rest' 
                  ? 'bg-white dark:bg-[#25293C] text-[#7367F0] shadow-xs' 
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {t('integrations.tabRestCurl')}
            </button>
            <button
              onClick={() => setActiveTab('inbound')}
              className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
                activeTab === 'inbound' 
                  ? 'bg-white dark:bg-[#25293C] text-[#7367F0] shadow-xs' 
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {t('integrations.tabInboundWebhook')}
            </button>
          </div>
        }
      >
        {activeTab === 'rest' ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5 font-mono">
                <Terminal className="w-3.5 h-3.5 text-[#7367F0]" />
                {t('integrations.curlPostTitle')}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(curlExample, t('integrations.curlCopyLabel'))}
                className="text-xs space-x-1 h-8"
              >
                {copiedKey === t('integrations.curlCopyLabel') ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedKey === t('integrations.curlCopyLabel') ? t('integrations.copied') : t('integrations.copy')}</span>
              </Button>
            </div>

            <pre className="p-4 rounded-xl bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto leading-relaxed border border-slate-800 select-all">
              {curlExample}
            </pre>

            <div className="p-3.5 rounded-xl bg-blue-500/5 dark:bg-blue-500/10 border border-blue-500/15 flex items-start gap-2.5 text-xs text-blue-700 dark:text-blue-300">
              <Info className="w-4 h-4 shrink-0 mt-0.5 text-blue-500" />
              <p className="leading-relaxed">
                <strong>{t('integrations.inboundTipTitle')}:</strong> {t('integrations.inboundTipText')}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {t('integrations.noCodeWebhookDesc')}
            </p>

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-black/30 border border-slate-200/80 dark:border-white/5 font-mono text-xs flex items-center justify-between gap-2">
              <span className="text-[#7367F0] truncate font-bold">
                https://api.tezlify.com/api/v1/public/inbound-webhook/<span className="text-emerald-500">tzf_live_YOUR_PREFIX</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard('https://api.tezlify.com/api/v1/public/inbound-webhook/tzf_live_YOUR_PREFIX', t('integrations.webhookUrlCopyLabel'))}
                className="text-xs shrink-0 h-8"
              >
                {copiedKey === t('integrations.webhookUrlCopyLabel') ? t('integrations.copied') : t('integrations.copy')}
              </Button>
            </div>

            <div className="flex items-center justify-between text-xs pt-2">
              <span className="font-bold text-slate-700 dark:text-slate-300">{t('integrations.sampleJsonTitle')}:</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(jsonWebhookSchema, t('integrations.jsonSchemaCopyLabel'))}
                className="text-xs space-x-1 h-8"
              >
                {copiedKey === t('integrations.jsonSchemaCopyLabel') ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedKey === t('integrations.jsonSchemaCopyLabel') ? t('integrations.copied') : t('integrations.copy')}</span>
              </Button>
            </div>

            <pre className="p-4 rounded-xl bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto leading-relaxed border border-slate-800 select-all">
              {jsonWebhookSchema}
            </pre>
          </div>
        )}
      </FormSection>
    </Card>
  );
};
