import React, { useState, useEffect } from 'react';
import { LayoutTemplate, Send, CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import { WhatsAppTemplate } from '../../types';
import { WhatsAppRepository } from '../../data/whatsapp/whatsappRepository';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/button';
import { useI18n } from '../../context/I18nContext';

export interface TemplateSelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  leadName?: string;
  onSendTemplate: (templateKey: string, variables: Record<string, string>) => Promise<void>;
}

export const TemplateSelectModal: React.FC<TemplateSelectModalProps> = ({
  isOpen,
  onClose,
  leadName = '',
  onSendTemplate,
}) => {
  const { t, language } = useI18n();
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [selectedKey, setSelectedKey] = useState<string>('welcome_intro');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      WhatsAppRepository.getTemplates()
        .then((data) => {
          setTemplates(data);
          if (data.length > 0) {
            setSelectedKey(data[0].key);
            initVariables(data[0], leadName);
          }
        })
        .catch((err) => {
          console.error('[TemplateSelectModal] Failed to load templates:', err);
        })
        .finally(() => setLoading(false));
    }
  }, [isOpen, leadName]);

  const initVariables = (tmpl: WhatsAppTemplate, name: string) => {
    const initial: Record<string, string> = {};
    for (const v of tmpl.variables || []) {
      if (v.default_from === 'lead_name') {
        initial[v.key] = name || '';
      } else {
        initial[v.key] = v.default_value || '';
      }
    }
    setVariables(initial);
  };

  const handleSelectTemplate = (tmpl: WhatsAppTemplate) => {
    setSelectedKey(tmpl.key);
    initVariables(tmpl, leadName);
  };

  const currentTemplate = templates.find((t) => t.key === selectedKey);

  const getRenderedPreview = () => {
    if (!currentTemplate) return '';
    let rendered = currentTemplate.body_pattern;
    for (const v of currentTemplate.variables || []) {
      const val = variables[v.key] || (v.default_from === 'lead_name' ? leadName : v.default_value) || `[${v.label}]`;
      rendered = rendered.replace(`{${v.key}}`, val || `[${v.label}]`);
    }
    return rendered;
  };

  const handleSend = async () => {
    if (!selectedKey || sending) return;
    setSending(true);
    try {
      await onSendTemplate(selectedKey, variables);
      onClose();
    } catch (err) {
      console.error('[TemplateSelectModal] Send failed:', err);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('whatsapp.selectTemplateTitle') || 'WhatsApp Şablonu Seçin'}
      subtitle={t('whatsapp.selectTemplateDesc') || 'Müşteriyle hızlı ve güvenli iletişim kurmak için hazır bir şablon seçin.'}
      icon={LayoutTemplate}
      maxWidth="xl"
    >
      {loading ? (
        <div className="flex items-center justify-center p-12 space-x-2 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin text-[#7367F0]" />
          <span className="text-xs font-bold">{t('common.loading') || 'Şablonlar yükleniyor...'}</span>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Template Selection Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {templates.map((tmpl) => {
              const isSelected = tmpl.key === selectedKey;
              const displayName = language === 'en' && tmpl.name_en ? tmpl.name_en : tmpl.name;
              return (
                <div
                  key={tmpl.key}
                  onClick={() => handleSelectTemplate(tmpl)}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer select-none flex items-start space-x-3 ${
                    isSelected
                      ? 'bg-[#7367F0]/10 border-[#7367F0] shadow-xs'
                      : 'bg-slate-50/50 dark:bg-white/[0.03] border-slate-200/80 dark:border-white/[0.08] hover:border-slate-300 dark:hover:border-white/20'
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                      isSelected
                        ? 'bg-[#7367F0] text-white'
                        : 'bg-slate-200/70 dark:bg-white/[0.06] text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                        {displayName}
                      </h4>
                      {isSelected && <CheckCircle2 className="w-4 h-4 text-[#7367F0] shrink-0" />}
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 mt-0.5 leading-relaxed">
                      {tmpl.description || tmpl.body_pattern}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Variable Inputs (if template has custom variables) */}
          {currentTemplate && currentTemplate.variables.length > 0 && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-black/20 border border-slate-200/80 dark:border-white/[0.06] space-y-3">
              <h5 className="text-[11px] font-extrabold uppercase text-slate-400 dark:text-slate-500 tracking-wider">
                {t('whatsapp.templateVariables') || 'Şablon Değişkenleri'}
              </h5>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {currentTemplate.variables.map((v) => (
                  <div key={v.key} className="space-y-1">
                    <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                      {v.label}
                    </label>
                    <input
                      type="text"
                      value={variables[v.key] || ''}
                      onChange={(e) =>
                        setVariables((prev) => ({ ...prev, [v.key]: e.target.value }))
                      }
                      placeholder={v.label}
                      className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Real-time Message Preview Box */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-extrabold uppercase text-slate-400 dark:text-slate-500 tracking-wider">
              {t('whatsapp.messagePreview') || 'Mesaj Önizleme'}
            </label>
            <div className="p-3.5 rounded-xl bg-[#25D366]/10 dark:bg-[#25D366]/15 border border-[#25D366]/25 text-slate-800 dark:text-slate-100 text-xs leading-relaxed font-medium">
              <p className="whitespace-pre-wrap">{getRenderedPreview()}</p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200/80 dark:border-white/[0.08]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={sending}
              className="text-xs font-bold"
            >
              {t('common.cancel') || 'İptal'}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSend}
              disabled={sending || !selectedKey}
              className="bg-[#25D366] hover:bg-[#1EBE5D] text-white text-xs font-bold space-x-1.5 shadow-sm cursor-pointer"
            >
              {sending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              <span>{t('whatsapp.sendTemplateBtn') || 'Şablonu Gönder'}</span>
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
};
