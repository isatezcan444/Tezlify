import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Mail, Send, X, Sparkles, Building2, AtSign, Loader2 } from 'lucide-react';
import { Lead } from '../../../types';
import { Button } from '../../../components/ui/button';
import { useToast } from '../../../context/ToastContext';
import { useI18n } from '../../../context/I18nContext';
import { ApiClient } from '../../../api/client';

export interface SendEmailModalProps {
  lead: Lead | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export const SendEmailModal: React.FC<SendEmailModalProps> = ({
  lead,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const toast = useToast();
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [subject, setSubject] = useState(
    lead ? `${t('email.defaultSubjectPrefix') || 'İş Birliği & Tanıtım'} - ${lead.name}` : ''
  );
  const [body, setBody] = useState(
    lead
      ? `${t('email.defaultGreeting') || 'Merhaba'} {name} ${t('email.authority') || 'Yetkilisi'},\n\n{city} ${t('email.defaultBodyIntro') || 'bölgesindeki'} {category} ${t('email.defaultBodyMessage') || 'hizmetlerinizi gördük ve firmanıza değer katacak çözümlerimiz hakkında kısa bir bilgi sunmak istedik.'}\n\n${t('email.defaultClosing') || 'Detayları görüşmek isterseniz yanıt vermeniz yeterlidir.\n\nİyi çalışmalar.'}`
      : ''
  );
  const [isSending, setIsSending] = useState(false);

  if (!isOpen || !lead) return null;

  const recipientEmail = lead.email || (lead.emails && lead.emails.length > 0 ? lead.emails[0] : '');

  const insertToken = (token: string) => {
    if (textareaRef.current) {
      const textarea = textareaRef.current;
      const start = textarea.selectionStart || 0;
      const end = textarea.selectionEnd || 0;
      const current = textarea.value;
      const updated = current.substring(0, start) + token + current.substring(end);
      setBody(updated);
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + token.length, start + token.length);
      }, 10);
    } else {
      setBody((prev) => `${prev} ${token}`);
    }
  };

  const handleApplyPreset = (presetType: 'intro' | 'partnership' | 'offer') => {
    if (presetType === 'intro') {
      setSubject(`Kurumsal Tanıtım - {name}`);
      setBody(
        `Merhaba {name} Yetkilisi,\n\n{city} bölgesindeki {category} faaliyetlerinizi inceledik. Kurumsal çözümlerimiz ve sunduğumuz avantajlar hakkında kısa bir bilgilendirme paylaşmak isteriz.\n\nİncelemek isterseniz detay iletebiliriz.\n\nSaygılarımızla.`
      );
    } else if (presetType === 'partnership') {
      setSubject(`{category} Alanında İş Ortaklığı Teklifi - {name}`);
      setBody(
        `Sayın {name} Yetkilisi,\n\n{city} lokasyonundaki operasyonlarınızda çözüm ortağınız olmak ve iş süreçlerinize verimlilik katmak isteriz.\n\nDetaylı görüşme için uygun olduğunuz bir zamanı iletirseniz memnun oluruz.\n\nİyi çalışmalar.`
      );
    } else if (presetType === 'offer') {
      setSubject(`Özel Teklif ve Çözümlerimiz - {name}`);
      setBody(
        `Sayın Yetkili,\n\n{name} firması için {category} sektörüne özel hazırladığımız avantajlı teklifimizi paylaşmak isteriz.\n\nDetayları değerlendirmek üzere kısa bir telefon veya video görüşmesi organize edebiliriz.\n\nSaygılarımızla.`
      );
    }
    toast.info(t('email.presetApplied') || 'Şablon uygulandı.', t('common.info'));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim()) {
      toast.warning(t('email.subjectRequired') || 'Lütfen e-posta konusunu girin.', t('common.warning'));
      return;
    }
    if (!body.trim()) {
      toast.warning(t('email.bodyRequired') || 'Lütfen e-posta içeriğini girin.', t('common.warning'));
      return;
    }
    if (!recipientEmail) {
      toast.error(t('email.noRecipientEmail') || 'İşletmenin e-posta adresi bulunmuyor.', t('toast.errorTitle'));
      return;
    }

    setIsSending(true);
    try {
      const res = await ApiClient.sendLeadEmail(lead.id, {
        subject: subject.trim(),
        body: body.trim(),
        is_html: false,
      });

      toast.success(res.message || t('email.sendSuccess') || 'E-posta başarıyla iletildi!', t('common.success'));
      onSuccess?.();
      onClose();
    } catch (err: any) {
      toast.error(err.message || t('email.sendError') || 'E-posta gönderilirken hata oluştu.', t('toast.errorTitle'));
    } finally {
      setIsSending(false);
    }
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl bg-white dark:bg-[#2F3349] border border-slate-200/80 dark:border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between bg-slate-50/50 dark:bg-white/[0.02]">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-[#7367F0]/10 text-[#7367F0] flex items-center justify-center shrink-0">
              <Mail className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-extrabold text-sm sm:text-base text-slate-800 dark:text-white truncate">
                {t('email.sendEmailTitle') || 'E-posta Gönder'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-[#7E7F96] truncate">
                {lead.name} {lead.city ? `(${lead.city})` : ''}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Recipient Information Pill */}
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] flex items-center justify-between">
            <div className="flex items-center space-x-2 text-xs min-w-0">
              <AtSign className="w-3.5 h-3.5 text-[#7367F0] shrink-0" />
              <span className="font-bold text-slate-600 dark:text-slate-300">
                {t('email.recipient') || 'Alıcı'}:
              </span>
              <span className="font-mono text-[#7367F0] font-semibold truncate">
                {recipientEmail || t('email.noEmailFound') || 'E-posta Bulunamadı'}
              </span>
            </div>
            {lead.category && (
              <span className="text-[10px] px-2 py-0.5 rounded-md font-medium bg-[#7367F0]/10 text-[#7367F0] shrink-0 border border-[#7367F0]/20">
                {lead.category}
              </span>
            )}
          </div>

          {/* Preset Buttons */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-slate-500 dark:text-[#7E7F96] uppercase tracking-wider block">
              {t('email.quickTemplates') || 'Hızlı Şablonlar'}
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => handleApplyPreset('intro')}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-100 dark:bg-white/[0.05] hover:bg-[#7367F0]/10 hover:text-[#7367F0] text-slate-600 dark:text-slate-300 transition-colors cursor-pointer border border-transparent hover:border-[#7367F0]/20"
              >
                Kurumsal Tanıtım
              </button>
              <button
                type="button"
                onClick={() => handleApplyPreset('partnership')}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-100 dark:bg-white/[0.05] hover:bg-[#7367F0]/10 hover:text-[#7367F0] text-slate-600 dark:text-slate-300 transition-colors cursor-pointer border border-transparent hover:border-[#7367F0]/20"
              >
                İş Ortaklığı
              </button>
              <button
                type="button"
                onClick={() => handleApplyPreset('offer')}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-100 dark:bg-white/[0.05] hover:bg-[#7367F0]/10 hover:text-[#7367F0] text-slate-600 dark:text-slate-300 transition-colors cursor-pointer border border-transparent hover:border-[#7367F0]/20"
              >
                Özel Fiyat Teklifi
              </button>
            </div>
          </div>

          {/* Subject Field */}
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block">
              {t('email.subjectLabel') || 'Konu'}
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t('email.subjectPlaceholder') || 'E-posta konusunu girin...'}
              className="w-full px-3.5 py-2 text-xs font-medium rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#1F2C34] text-slate-800 dark:text-white placeholder:text-slate-400 focus:outline-hidden focus:border-[#7367F0] focus:ring-1 focus:ring-[#7367F0]"
            />
          </div>

          {/* Body Field & Variable Chips */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block">
                {t('email.messageBody') || 'Mesaj İçeriği'}
              </label>
              <div className="flex items-center space-x-1">
                <span className="text-[10px] text-slate-400 mr-1">{t('email.insertVariable') || 'Değişken'}:</span>
                <button
                  type="button"
                  onClick={() => insertToken('{name}')}
                  className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-[#7367F0]/10 text-[#7367F0] rounded hover:bg-[#7367F0]/20 cursor-pointer"
                >
                  +{'{name}'}
                </button>
                <button
                  type="button"
                  onClick={() => insertToken('{category}')}
                  className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-[#7367F0]/10 text-[#7367F0] rounded hover:bg-[#7367F0]/20 cursor-pointer"
                >
                  +{'{category}'}
                </button>
                <button
                  type="button"
                  onClick={() => insertToken('{city}')}
                  className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-[#7367F0]/10 text-[#7367F0] rounded hover:bg-[#7367F0]/20 cursor-pointer"
                >
                  +{'{city}'}
                </button>
              </div>
            </div>

            <textarea
              ref={textareaRef}
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('email.bodyPlaceholder') || 'E-posta metnini buraya yazın...'}
              className="w-full px-3.5 py-2.5 text-xs font-sans rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#1F2C34] text-slate-800 dark:text-white placeholder:text-slate-400 focus:outline-hidden focus:border-[#7367F0] focus:ring-1 focus:ring-[#7367F0] leading-relaxed resize-none"
            />
          </div>

          {/* Footer Controls */}
          <div className="pt-2 flex items-center justify-end space-x-2 border-t border-slate-100 dark:border-white/[0.06]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={isSending}
              className="cursor-pointer font-bold border-slate-300 dark:border-white/10"
            >
              {t('common.cancel') || 'İptal'}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={isSending || !recipientEmail}
              className="bg-[#7367F0] hover:bg-[#685dd8] text-white font-bold space-x-1.5 cursor-pointer shadow-md shadow-[#7367F0]/20"
            >
              {isSending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t('email.sending') || 'Gönderiliyor...'}</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>{t('email.sendNow') || 'E-postayı Gönder'}</span>
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : null;
};
