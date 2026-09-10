import * as React from 'react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { 
  Smartphone, 
  X, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Layers, 
  Key, 
  Fingerprint,
  ShieldCheck
} from 'lucide-react';
import { Button } from '../ui/button';
import { TextInput } from '../forms/TextInput';
import { Badge } from '../ui/badge';
import { useI18n } from '../../context/I18nContext';
import { ApiClient } from '../../api/client';
import { WhatsAppNumber, WhatsAppNumberValidateResult } from '../../types';

export interface NewWhatsAppNumberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (createdNumber: WhatsAppNumber) => void;
}

export const NewWhatsAppNumberModal: React.FC<NewWhatsAppNumberModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [accessToken, setAccessToken] = useState('');

  const [isValidating, setIsValidating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [validationResult, setValidationResult] = useState<WhatsAppNumberValidateResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleValidate = async () => {
    if (!wabaId.trim() || !phoneNumberId.trim() || !accessToken.trim()) {
      setValidationError(t('whatsapp.fillAllMetaFields') || 'Lütfen WABA ID, Phone Number ID ve Access Token alanlarını doldurun.');
      return;
    }

    setIsValidating(true);
    setValidationError(null);
    setValidationResult(null);

    try {
      const res = await ApiClient.validateWhatsAppNumber({
        name: name.trim(),
        waba_id: wabaId.trim(),
        phone_number_id: phoneNumberId.trim(),
        access_token: accessToken.trim(),
      });

      if (res.is_valid) {
        setValidationResult(res);
        setValidationError(null);
      } else {
        setValidationError(res.error || 'Meta API doğrulaması başarısız oldu.');
      }
    } catch (err: any) {
      setValidationError(err?.message || 'Meta API ile bağlantı kurulamadı.');
    } finally {
      setIsValidating(false);
    }
  };

  const handleConnect = async () => {
    if (!validationResult || !validationResult.is_valid) {
      setValidationError(t('whatsapp.validateFirst') || 'Lütfen önce Meta bağlantısını doğrulayın.');
      return;
    }

    setIsSaving(true);
    setValidationError(null);

    try {
      const created = await ApiClient.connectWhatsAppNumber({
        name: (name.trim() || validationResult.verified_name || 'WhatsApp Hattı'),
        waba_id: wabaId.trim(),
        phone_number_id: phoneNumberId.trim(),
        access_token: accessToken.trim(),
      });

      onSuccess(created);
      onClose();
    } catch (err: any) {
      setValidationError(err?.message || 'Numara kaydedilirken hata oluştu.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleModalClose = () => {
    if (isValidating || isSaving) return;
    setName('');
    setWabaId('');
    setPhoneNumberId('');
    setAccessToken('');
    setValidationResult(null);
    setValidationError(null);
    onClose();
  };

  return typeof document !== 'undefined' ? createPortal(
    <div 
      className="fixed inset-0 z-[99999] bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in select-none"
      onClick={handleModalClose}
    >
      <div 
        className="w-full max-w-lg rounded-2xl bg-white dark:bg-[#2F3349] p-6 space-y-5 shadow-2xl border border-slate-200/80 dark:border-white/[0.1] animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-white/[0.08]">
          <div className="flex items-center space-x-2.5">
            <div className="w-10 h-10 rounded-xl bg-[#28C76F]/15 text-[#28C76F] flex items-center justify-center font-bold">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-slate-800 dark:text-white">
                {t('whatsapp.addMetaNumberTitle') || 'Yeni WhatsApp Business Hattı Bağla'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                {t('whatsapp.addMetaNumberSubtitle') || 'Meta Cloud API v21+ entegrasyonu'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleModalClose}
            disabled={isValidating || isSaving}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Error Alert */}
        {validationError && (
          <div className="p-3 rounded-xl bg-[#EA5455]/10 border border-[#EA5455]/20 flex items-start gap-2.5 text-xs text-[#EA5455]">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="font-semibold leading-relaxed">{validationError}</span>
          </div>
        )}

        {/* Inputs */}
        <div className="space-y-3.5">
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">
              {t('whatsapp.lineName') || 'Hat Adı'} <span className="text-slate-400 text-[11px] font-normal">(İsteğe bağlı, örneğin: Satış Hattı 1)</span>
            </label>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Örn: Satış Hattı 1"
              className="text-xs"
              disabled={isValidating || isSaving}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1 flex items-center gap-1">
                <Layers className="w-3.5 h-3.5 text-[#7367F0]" />
                WABA ID <span className="text-[#EA5455]">*</span>
              </label>
              <TextInput
                value={wabaId}
                onChange={(e) => {
                  setWabaId(e.target.value);
                  setValidationResult(null);
                }}
                placeholder="Örn: 102938475610293"
                className="text-xs font-mono"
                disabled={isValidating || isSaving}
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1 flex items-center gap-1">
                <Fingerprint className="w-3.5 h-3.5 text-[#7367F0]" />
                Phone Number ID <span className="text-[#EA5455]">*</span>
              </label>
              <TextInput
                value={phoneNumberId}
                onChange={(e) => {
                  setPhoneNumberId(e.target.value);
                  setValidationResult(null);
                }}
                placeholder="Örn: 593827104928172"
                className="text-xs font-mono"
                disabled={isValidating || isSaving}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1 flex items-center gap-1">
              <Key className="w-3.5 h-3.5 text-[#FF9F43]" />
              Permanent Access Token <span className="text-[#EA5455]">*</span>
            </label>
            <TextInput
              type="password"
              value={accessToken}
              onChange={(e) => {
                setAccessToken(e.target.value);
                setValidationResult(null);
              }}
              placeholder="EAAB..."
              className="text-xs font-mono"
              disabled={isValidating || isSaving}
            />
            <p className="text-[10px] text-slate-400 mt-1">
              {t('whatsapp.tokenSecurityNote') || 'Token şifrelenerek saklanır, hiçbir API yanıtında veya logda düz metin görünmez.'}
            </p>
          </div>
        </div>

        {/* Validation Result Box */}
        {validationResult && validationResult.is_valid && (
          <div className="p-3.5 rounded-xl bg-[#28C76F]/10 border border-[#28C76F]/25 space-y-2 animate-fade-in">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold text-[#28C76F] flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                {t('whatsapp.metaVerifiedSuccess') || 'Meta Doğrulaması Başarılı'}
              </span>
              <Badge variant="success" className="text-[10px] uppercase font-bold">
                {validationResult.quality_rating || 'GREEN'}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-[#28C76F]/20 text-slate-700 dark:text-slate-200">
              <div>
                <span className="text-slate-400 text-[10px] block">{t('whatsapp.phoneNumber') || 'Telefon'}:</span>
                <span className="font-mono font-bold">{validationResult.display_phone_number || phoneNumberId}</span>
              </div>
              <div>
                <span className="text-slate-400 text-[10px] block">{t('whatsapp.verifiedName') || 'Onaylı İsim'}:</span>
                <span className="font-bold">{validationResult.verified_name || '-'}</span>
              </div>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-end space-x-2.5 pt-2 border-t border-slate-100 dark:border-white/[0.08]">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleModalClose}
            disabled={isValidating || isSaving}
            className="text-xs font-bold"
          >
            {t('common.cancel') || 'İptal'}
          </Button>

          {!validationResult ? (
            <Button
              type="button"
              size="sm"
              onClick={handleValidate}
              disabled={isValidating || !wabaId.trim() || !phoneNumberId.trim() || !accessToken.trim()}
              className="space-x-1.5 text-xs font-bold bg-[#7367F0] hover:bg-[#685DD8] text-white cursor-pointer"
            >
              {isValidating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t('whatsapp.verifying') || 'Doğrulanıyor...'}</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>{t('whatsapp.verifyConnection') || 'Bağlantıyı Doğrula'}</span>
                </>
              )}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={handleConnect}
              disabled={isSaving}
              className="space-x-1.5 text-xs font-bold bg-[#28C76F] hover:bg-[#24B263] text-white shadow-md shadow-[#28C76F]/20 cursor-pointer"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t('whatsapp.saving') || 'Kaydediliyor...'}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{t('whatsapp.saveAndActivate') || 'Hattı Kaydet ve Aktif Et'}</span>
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body
  ) : null;
};
