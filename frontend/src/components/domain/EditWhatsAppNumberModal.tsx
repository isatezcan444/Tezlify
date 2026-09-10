import * as React from 'react';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
  Edit3, 
  X, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Key, 
  Fingerprint
} from 'lucide-react';
import { Button } from '../ui/button';
import { TextInput } from '../forms/TextInput';
import { useI18n } from '../../context/I18nContext';
import { ApiClient } from '../../api/client';
import { WhatsAppNumber } from '../../types';

export interface EditWhatsAppNumberModalProps {
  number: WhatsAppNumber | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (updated: WhatsAppNumber) => void;
}

export const EditWhatsAppNumberModal: React.FC<EditWhatsAppNumberModalProps> = ({
  number,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [newToken, setNewToken] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (number) {
      setName(number.name || '');
      setNewToken('');
      setError(null);
    }
  }, [number, isOpen]);

  if (!isOpen || !number) return null;

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t('whatsapp.nameRequired') || 'Hat adı boş bırakılamaz.');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const payload: { name: string; access_token?: string } = {
        name: name.trim(),
      };
      if (newToken.trim()) {
        payload.access_token = newToken.trim();
      }

      const updated = await ApiClient.updateWhatsAppNumber(number.id, payload);
      onSuccess(updated);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Güncelleme sırasında hata oluştu.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleModalClose = () => {
    if (isSaving) return;
    setError(null);
    onClose();
  };

  return typeof document !== 'undefined' ? createPortal(
    <div 
      className="fixed inset-0 z-[99999] bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in select-none"
      onClick={handleModalClose}
    >
      <div 
        className="w-full max-w-md rounded-2xl bg-white dark:bg-[#2F3349] p-6 space-y-5 shadow-2xl border border-slate-200/80 dark:border-white/[0.1] animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-white/[0.08]">
          <div className="flex items-center space-x-2.5">
            <div className="w-10 h-10 rounded-xl bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center font-bold">
              <Edit3 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-slate-800 dark:text-white">
                {t('whatsapp.editNumberTitle') || 'Hattı Düzenle'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                {number.display_phone_number || number.phone_number_e164}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleModalClose}
            disabled={isSaving}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="p-3 rounded-xl bg-[#EA5455]/10 border border-[#EA5455]/20 flex items-start gap-2.5 text-xs text-[#EA5455]">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="font-semibold leading-relaxed">{error}</span>
          </div>
        )}

        {/* Form Fields */}
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">
              {t('whatsapp.lineName') || 'Hat Adı'}
            </label>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Örn: Satış Hattı"
              className="text-xs"
              disabled={isSaving}
            />
          </div>

          <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-xs space-y-1">
            <span className="text-slate-400 text-[10px] block font-semibold">Phone Number ID (Değiştirilemez):</span>
            <div className="flex items-center gap-1.5 font-mono font-bold text-slate-700 dark:text-slate-300">
              <Fingerprint className="w-3.5 h-3.5 text-[#7367F0]" />
              {number.phone_number_id}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1 flex items-center gap-1">
              <Key className="w-3.5 h-3.5 text-[#FF9F43]" />
              {t('whatsapp.rotateTokenLabel') || 'Yeni Access Token (Opsiyonel)'}
            </label>
            <TextInput
              type="password"
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
              placeholder="Değiştirmek istemiyorsanız boş bırakın"
              className="text-xs font-mono"
              disabled={isSaving}
            />
            <p className="text-[10px] text-slate-400 mt-1">
              {t('whatsapp.rotateTokenHelp') || 'Yalnızca yeni bir token girdiğinizde doğrulanarak eski token değiştirilir.'}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end space-x-2.5 pt-2 border-t border-slate-100 dark:border-white/[0.08]">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleModalClose}
            disabled={isSaving}
            className="text-xs font-bold"
          >
            {t('common.cancel') || 'İptal'}
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={isSaving || !name.trim()}
            className="space-x-1.5 text-xs font-bold bg-[#7367F0] hover:bg-[#685DD8] text-white cursor-pointer"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{t('whatsapp.saving') || 'Kaydediliyor...'}</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{t('common.saveChanges') || 'Değişiklikleri Kaydet'}</span>
              </>
            )}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  ) : null;
};
