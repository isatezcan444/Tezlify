import React, { useState } from 'react';
import { MessageSquarePlus, Send, Loader2, Phone, User, MessageSquare } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/button';
import { TextInput } from '../forms/TextInput';
import { useI18n } from '../../context/I18nContext';
import { useToast } from '../../context/ToastContext';
import { ApiClient } from '../../api/client';
import { ConversationDetail } from '../../types';

export interface NewChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (conv: ConversationDetail) => void;
}

export const NewChatModal: React.FC<NewChatModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPhone = phone.trim();
    if (!cleanPhone) {
      toast.error(t('whatsapp.phoneRequired') || 'Lütfen geçerli bir telefon numarası girin.');
      return;
    }

    setLoading(true);
    try {
      const newConv = await ApiClient.startConversation({
        phone: cleanPhone,
        name: name.trim() || undefined,
        message: message.trim() || undefined,
      });

      toast.success(t('whatsapp.chatStarted') || 'Yeni sohbet başarıyla başlatıldı!');
      setPhone('');
      setName('');
      setMessage('');
      onClose();
      onSuccess(newConv);
    } catch (err: any) {
      console.error('[NewChatModal] Failed to start conversation:', err);
      toast.error(err.message || t('whatsapp.chatStartFailed') || 'Sohbet başlatılamadı');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('whatsapp.newChatModalTitle') || 'Yeni WhatsApp Sohbeti Başlat'}
      subtitle={t('whatsapp.newChatModalSubtitle') || 'Rehberinizde veya veritabanında olmasa dahi herhangi bir numaraya doğrudan mesaj gönderin.'}
      icon={MessageSquarePlus}
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Phone Input */}
        <div>
          <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
            <Phone className="w-3.5 h-3.5 text-[#25D366]" />
            <span>{t('whatsapp.phoneLabel') || 'Telefon Numarası'}</span>
            <span className="text-red-500">*</span>
          </label>
          <TextInput
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+90 5XX XXX XX XX"
            required
            autoFocus
            className="font-mono text-sm"
          />
          <p className="text-[11px] text-slate-400 mt-1">
            {t('whatsapp.phoneHint') || 'Ülke kodu ile birlikte girin (Örn: +905321234567).'}
          </p>
        </div>

        {/* Contact Name (Optional) */}
        <div>
          <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
            <User className="w-3.5 h-3.5 text-[#7367F0]" />
            <span>{t('whatsapp.contactNameLabel') || 'Kişi / İşletme Adı (İsteğe Bağlı)'}</span>
          </label>
          <TextInput
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('whatsapp.contactNamePlaceholder') || 'Örn: Mehmet Bey veya XYZ Kuaför'}
          />
        </div>

        {/* Initial Message (Optional) */}
        <div>
          <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5 text-[#28C76F]" />
            <span>{t('whatsapp.initialMessageLabel') || 'İlk Mesaj (İsteğe Bağlı)'}</span>
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('whatsapp.initialMessagePlaceholder') || 'Merhaba, görüşmek istediğiniz konuyu buraya yazabilirsiniz...'}
            rows={3}
            className="w-full rounded-xl border border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.04] p-3 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#7367F0]/40 transition-all resize-none"
          />
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100 dark:border-white/[0.08]">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={loading}
          >
            {t('common.cancel') || 'İptal'}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={loading || !phone.trim()}
            className="space-x-1.5 bg-[#25D366] hover:bg-[#20ba59] text-white font-bold cursor-pointer"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            <span>{t('whatsapp.startChatBtn') || 'Sohbeti Başlat'}</span>
          </Button>
        </div>
      </form>
    </Modal>
  );
};
