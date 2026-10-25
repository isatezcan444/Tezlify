import React, { useState, useEffect } from 'react';
import { 
  Mail, 
  Server, 
  Key, 
  User, 
  CheckCircle2, 
  XCircle, 
  Send, 
  Save, 
  Loader2, 
  ShieldCheck, 
  AlertCircle, 
  Sparkles,
  Lock
} from 'lucide-react';
import { Card, Badge, Button } from '../../../components/ui';
import { FormSection, FormField, TextInput } from '../../../components/forms';
import { ApiClient } from '../../../api/client';
import { SmtpConfig } from '../../../types';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';

export const SmtpSettingsSection: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isTesting, setIsTesting] = useState<boolean>(false);

  const [host, setHost] = useState<string>('');
  const [port, setPort] = useState<number>(587);
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [senderEmail, setSenderEmail] = useState<string>('');
  const [senderName, setSenderName] = useState<string>('');
  const [useTls, setUseTls] = useState<boolean>(true);
  const [useSsl, setUseSsl] = useState<boolean>(false);
  const [isConfigured, setIsConfigured] = useState<boolean>(false);

  const [testEmail, setTestEmail] = useState<string>('');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Load SMTP config
  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);

    ApiClient.getSmtpSettings()
      .then((data: SmtpConfig) => {
        if (!isMounted) return;
        setHost(data.host || '');
        setPort(data.port || 587);
        setUsername(data.username || '');
        setPassword(data.password || '');
        setSenderEmail(data.sender_email || '');
        setSenderName(data.sender_name || '');
        setUseTls(data.use_tls ?? true);
        setUseSsl(data.use_ssl ?? false);
        setIsConfigured(Boolean(data.is_configured));
      })
      .catch((err) => {
        console.warn('[SmtpSettingsSection] Failed to load SMTP config:', err);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!host.trim() || !senderEmail.trim()) {
      toast.warning(t('settings.smtpHostRequired') || 'Sunucu adresi ve gönderici e-posta zorunludur.', t('common.warning'));
      return;
    }

    setIsSaving(true);
    try {
      const updated = await ApiClient.updateSmtpSettings({
        host: host.trim(),
        port: Number(port) || 587,
        username: username.trim(),
        password: password.trim(),
        sender_email: senderEmail.trim(),
        sender_name: senderName.trim(),
        use_tls: useTls,
        use_ssl: useSsl,
      });

      setIsConfigured(Boolean(updated.is_configured));
      toast.success(t('settings.smtpSavedSuccess') || 'SMTP yapılandırması başarıyla kaydedildi.', t('common.success'));
    } catch (err: any) {
      toast.error(err.message || t('settings.smtpSaveError') || 'SMTP ayarları kaydedilemedi.', t('toast.errorTitle'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!testEmail.trim()) {
      toast.warning(t('settings.smtpTestEmailRequired') || 'Lütfen test e-postasının gönderileceği adresi girin.', t('common.warning'));
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const res = await ApiClient.testSmtpConnection(testEmail.trim());
      if (res.success) {
        setTestResult({
          success: true,
          message: res.message || t('settings.smtpTestSuccess') || 'Test e-postası başarıyla gönderildi!',
        });
        toast.success(res.message || t('settings.smtpTestSuccess') || 'Test e-postası başarıyla iletildi.', t('common.success'));
      } else {
        setTestResult({
          success: false,
          message: res.error || t('settings.smtpTestFailed') || 'Test e-postası gönderilemedi.',
        });
        toast.error(res.error || t('settings.smtpTestFailed'), t('toast.errorTitle'));
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err.message || t('settings.smtpTestFailed'),
      });
      toast.error(err.message || t('settings.smtpTestFailed'), t('toast.errorTitle'));
    } finally {
      setIsTesting(false);
    }
  };

  if (isLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-12 text-slate-400 gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-[#7367F0]" />
          <span className="text-xs font-semibold">{t('common.loading')}...</span>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-5 sm:p-6 space-y-6">
      <FormSection
        title={t('settings.smtpTitle') || 'E-posta (SMTP) Yapılandırması'}
        subtitle={t('settings.smtpSubtitle') || 'Zenginleştirilen işletme e-postalarına tek tıkla doğrudan kurumsal teklif ve outreach e-postaları gönderin.'}
        icon={Mail}
      >
        <div className="space-y-6">
          {/* Status Header Banner */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] gap-3">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                isConfigured ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
              }`}>
                {isConfigured ? <ShieldCheck className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100">
                    {t('settings.smtpStatusTitle') || 'SMTP Outreach Durumu'}
                  </h4>
                  <Badge variant={isConfigured ? 'success' : 'warning'} className="text-[10px]">
                    {isConfigured 
                      ? (t('settings.smtpConfigured') || 'Etkin & Hazır')
                      : (t('settings.smtpNotConfigured') || 'Yapılandırılmamış')}
                  </Badge>
                </div>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] mt-0.5">
                  {isConfigured
                    ? (t('settings.smtpConfiguredDesc') || 'Kurumsal sunucunuz üzerinden doğrudan teklif e-postaları gönderilebilir.')
                    : (t('settings.smtpNotConfiguredDesc') || 'Lead CRM ve arama sonuçlarından e-posta gönderebilmek için sunucu bilgilerinizi kaydedin.')}
                </p>
              </div>
            </div>

            <Button
              onClick={handleSave}
              disabled={isSaving}
              className="space-x-1.5 font-bold shadow-md shadow-[#7367F0]/30 shrink-0 cursor-pointer text-xs"
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              <span>{isSaving ? (t('common.saving') || 'Kaydediliyor...') : (t('common.save') || 'Ayarları Kaydet')}</span>
            </Button>
          </div>

          {/* Form Fields Grid */}
          <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label={t('settings.smtpHostLabel') || 'SMTP Sunucu Adresi (Host)'} required>
              <TextInput
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="smtp.example.com / smtp.gmail.com"
                leftIcon={Server}
              />
            </FormField>

            <FormField label={t('settings.smtpPortLabel') || 'SMTP Port'} required>
              <TextInput
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                placeholder="587 veya 465"
              />
            </FormField>

            <FormField label={t('settings.smtpSenderEmailLabel') || 'Gönderici E-posta (From Email)'} required>
              <TextInput
                type="email"
                value={senderEmail}
                onChange={(e) => setSenderEmail(e.target.value)}
                placeholder="info@sirketiniz.com"
                leftIcon={Mail}
              />
            </FormField>

            <FormField label={t('settings.smtpSenderNameLabel') || 'Gönderici Başlığı / Şirket Adı'}>
              <TextInput
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                placeholder="Tezlify Satış & Çözüm Ekibi"
                leftIcon={User}
              />
            </FormField>

            <FormField label={t('settings.smtpUsernameLabel') || 'Kullanıcı Adı (Opsiyonel / Genellikle e-posta)'}>
              <TextInput
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="info@sirketiniz.com"
                leftIcon={User}
              />
            </FormField>

            <FormField label={t('settings.smtpPasswordLabel') || 'Parola / Uygulama Şifresi'}>
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                leftIcon={Key}
              />
            </FormField>

            {/* TLS / SSL Security Toggles */}
            <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
              <label className="flex items-center gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] cursor-pointer hover:border-[#7367F0]/40 transition-colors">
                <input
                  type="checkbox"
                  checked={useTls}
                  onChange={(e) => setUseTls(e.target.checked)}
                  className="w-4 h-4 text-[#7367F0] rounded border-slate-300 dark:border-white/20 focus:ring-[#7367F0]"
                />
                <div className="text-xs">
                  <p className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-[#7367F0]" />
                    <span>STARTTLS (Port 587)</span>
                  </p>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    {t('settings.smtpTlsDesc') || 'Modern e-posta sunucuları için önerilen şifreli bağlantı modu.'}
                  </p>
                </div>
              </label>

              <label className="flex items-center gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] cursor-pointer hover:border-[#7367F0]/40 transition-colors">
                <input
                  type="checkbox"
                  checked={useSsl}
                  onChange={(e) => setUseSsl(e.target.checked)}
                  className="w-4 h-4 text-[#7367F0] rounded border-slate-300 dark:border-white/20 focus:ring-[#7367F0]"
                />
                <div className="text-xs">
                  <p className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Doğrudan SSL / TLS (Port 465)</span>
                  </p>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    {t('settings.smtpSslDesc') || 'Eski SSL standardı (465 portu kullanan özel sunucular için).'}
                  </p>
                </div>
              </label>
            </div>
          </form>

          {/* Live SMTP Connection & Delivery Test */}
          <div className="p-4 sm:p-5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#7367F0]" />
              <h4 className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-200">
                {t('settings.smtpTestHeading') || 'Canlı Bağlantı & Gönderim Testi'}
              </h4>
            </div>
            <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
              {t('settings.smtpTestNotice') || 'Yapılandırdığınız SMTP sunucusunun kimlik doğrulaması ve teslimat kabiliyetini doğrulamak için bir test e-postası tetikleyin.'}
            </p>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <div className="flex-1">
                <TextInput
                  type="email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder="test@sirketiniz.com"
                  leftIcon={Mail}
                />
              </div>
              <Button
                type="button"
                onClick={handleTestConnection}
                disabled={isTesting || !isConfigured}
                className="space-x-1.5 font-bold shadow-md shadow-[#7367F0]/20 shrink-0 cursor-pointer text-xs"
              >
                {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                <span>{isTesting ? (t('settings.smtpTesting') || 'Test Ediliyor...') : (t('settings.smtpSendTestBtn') || 'Test E-postası Gönder')}</span>
              </Button>
            </div>

            {testResult && (
              <div className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
                testResult.success
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                  : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
              }`}>
                {testResult.success ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                <span className="font-medium">{testResult.message}</span>
              </div>
            )}
          </div>
        </div>
      </FormSection>
    </Card>
  );
};
