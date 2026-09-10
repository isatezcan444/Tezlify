import * as React from 'react';
import { 
  Smartphone, 
  CheckCircle2, 
  AlertCircle, 
  PowerOff, 
  Trash2, 
  Edit3, 
  RotateCw,
  Layers,
  Fingerprint
} from 'lucide-react';
import { WhatsAppNumber } from '../../types';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { IconButton } from '../ui/IconButton';
import { cn } from '../../lib/utils';
import { useI18n } from '../../context/I18nContext';

export interface WhatsAppNumberCardProps {
  number: WhatsAppNumber;
  onVerify?: (numberId: number) => void;
  onEdit?: (number: WhatsAppNumber) => void;
  onDisconnect?: (numberId: number) => void;
  onDelete?: (numberId: number) => void;
  onScanQR?: (number: WhatsAppNumber) => void;
  isVerifying?: boolean;
  isDisconnecting?: boolean;
  isDeleting?: boolean;
  className?: string;
}

export const WhatsAppNumberCard: React.FC<WhatsAppNumberCardProps> = ({
  number,
  onVerify,
  onEdit,
  onDisconnect,
  onDelete,
  onScanQR,
  isVerifying = false,
  isDisconnecting = false,
  isDeleting = false,
  className,
}) => {
  const { t } = useI18n();

  const isConnected = number.status === 'ACTIVE';
  const isError = number.status === 'ERROR';
  const isBaileys = number.provider === 'BAILEYS_QR';

  const getQualityBadgeVariant = (quality?: string): 'success' | 'warning' | 'danger' | 'outline' => {
    switch ((quality || '').toUpperCase()) {
      case 'GREEN':
        return 'success';
      case 'YELLOW':
        return 'warning';
      case 'RED':
        return 'danger';
      default:
        return 'outline';
    }
  };

  const formatDateTime = (dateStr?: string) => {
    if (!dateStr) return t('whatsapp.neverVerified') || 'Henüz test edilmedi';
    try {
      const d = new Date(dateStr);
      return d.toLocaleString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <Card className={cn('p-5 space-y-4 flex flex-col justify-between hover:shadow-md transition-all border border-slate-200/80 dark:border-white/[0.08]', className)}>
      <div>
        {/* Header: Icon, Name, Phone & Status */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center space-x-3">
            <div
              className={cn(
                'w-11 h-11 rounded-xl flex items-center justify-center font-bold shrink-0 transition-colors shadow-xs',
                isConnected
                  ? 'bg-[#28C76F]/15 text-[#28C76F]'
                  : isError
                  ? 'bg-[#EA5455]/15 text-[#EA5455]'
                  : 'bg-slate-100 dark:bg-white/[0.06] text-slate-400'
              )}
            >
              {isBaileys ? (
                <Smartphone className="w-5 h-5" />
              ) : (
                <Smartphone className="w-5 h-5" />
              )}
            </div>

            <div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <h4 className="font-extrabold text-sm text-slate-800 dark:text-white leading-tight">
                  {number.name}
                </h4>
                {isBaileys ? (
                  <span className="text-[9px] font-bold px-1.5 py-0.2 rounded-md bg-[#28C76F]/15 text-[#28C76F] border border-[#28C76F]/30 uppercase font-mono">
                    {t('whatsapp.providerBaileysQr') || 'QR / Baileys'}
                  </span>
                ) : (
                  <>
                    <span className="text-[9px] font-bold px-1.5 py-0.2 rounded-md bg-[#7367F0]/15 text-[#7367F0] border border-[#7367F0]/30 uppercase font-mono">
                      {t('whatsapp.providerMetaCloud') || 'Meta Cloud'}
                    </span>
                    {number.verified_name && (
                      <span title={`Meta Verified: ${number.verified_name}`} className="text-[#28C76F] shrink-0">
                        <CheckCircle2 className="w-3.5 h-3.5 fill-[#28C76F]/20" />
                      </span>
                    )}
                  </>
                )}
              </div>
              <p className="font-mono text-xs text-slate-600 dark:text-[#7E7F96] mt-0.5 font-bold">
                {number.display_phone_number || number.phone_number_e164 || (
                  <span className="text-amber-500 font-medium text-[11px]">
                    {t('whatsapp.awaitingQrScan') || 'QR ile Eşleşme Bekleniyor'}
                  </span>
                )}
              </p>
            </div>
          </div>

          <Badge 
            variant={isConnected ? 'success' : isError ? 'danger' : 'outline'} 
            className="text-[10px] uppercase font-mono font-extrabold px-2 py-0.5"
          >
            {number.status}
          </Badge>
        </div>

        {/* Details Box */}
        {isBaileys ? (
          /* Baileys QR Specific Details Box */
          <div className="mt-4 space-y-2 p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05]">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500 dark:text-[#7E7F96] font-semibold flex items-center gap-1.5">
                <Smartphone className="w-3.5 h-3.5 text-[#28C76F]" />
                {t('whatsapp.tabSessions') || 'Bağlantı Türü'}:
              </span>
              <span className="font-bold text-slate-800 dark:text-slate-200">
                Multi-Device Linked
              </span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500 dark:text-[#7E7F96] font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#7367F0]" />
                {t('whatsapp.connectionActive') || 'Durum'}:
              </span>
              <Badge variant={isConnected ? 'success' : 'outline'} className="text-[10px] font-bold">
                {isConnected ? (t('whatsapp.socketLive') || 'Canlı Soket') : (t('whatsapp.disconnected') || 'Bağlantı Yok')}
              </Badge>
            </div>

            <div className="pt-1.5 border-t border-slate-200/60 dark:border-white/[0.05] flex items-center justify-between text-[10px] text-slate-400">
              <span>{t('whatsapp.lastVerified') || 'Son Senkronizasyon'}:</span>
              <span className="font-mono">{formatDateTime(number.last_verified_at || number.updated_at)}</span>
            </div>
          </div>
        ) : (
          /* Meta Cloud Details Box */
          <div className="mt-4 space-y-2 p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05]">
            {/* Verified Name & Quality */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500 dark:text-[#7E7F96] font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#28C76F]" />
                {t('whatsapp.verifiedName') || 'Onaylı İsim'}:
              </span>
              <span className="font-bold text-slate-800 dark:text-slate-200 truncate max-w-[140px]" title={number.verified_name || '-'}>
                {number.verified_name || '-'}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500 dark:text-[#7E7F96] font-semibold flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 text-[#7367F0]" />
                {t('whatsapp.qualityRating') || 'Hat Kalitesi'}:
              </span>
              <Badge variant={getQualityBadgeVariant(number.quality_rating)} className="text-[10px] uppercase font-bold">
                {number.quality_rating || 'UNKNOWN'}
              </Badge>
            </div>

            {/* Meta Identifiers */}
            <div className="pt-2 border-t border-slate-200/60 dark:border-white/[0.05] space-y-1.5 text-[11px] font-mono text-slate-500 dark:text-[#7E7F96]">
              {number.waba_id && (
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    <Layers className="w-3 h-3 text-slate-400" />
                    WABA ID:
                  </span>
                  <span className="font-semibold text-slate-700 dark:text-slate-300">{number.waba_id}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <Fingerprint className="w-3 h-3 text-slate-400" />
                  Phone ID:
                </span>
                <span className="font-semibold text-slate-700 dark:text-slate-300">{number.phone_number_id}</span>
              </div>
            </div>

            {/* Last verification */}
            <div className="pt-1.5 border-t border-slate-200/60 dark:border-white/[0.05] flex items-center justify-between text-[10px] text-slate-400">
              <span>{t('whatsapp.lastVerified') || 'Son Doğrulama'}:</span>
              <span className="font-mono">{formatDateTime(number.last_verified_at)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Card Actions Footer */}
      <div className="pt-3 flex items-center justify-between border-t border-slate-100 dark:border-white/[0.06] text-xs">
        <div className="flex items-center space-x-2">
          {/* If Baileys and disconnected, show Re-scan QR */}
          {isBaileys && !isConnected && onScanQR ? (
            <button
              type="button"
              onClick={() => onScanQR(number)}
              className="text-[#7367F0] hover:text-[#685DD8] flex items-center gap-1.5 font-bold transition-colors text-xs cursor-pointer"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>{t('whatsapp.reconnectQr') || 'QR ile Bağla'}</span>
            </button>
          ) : (
            /* Verify / Test Button */
            <button
              type="button"
              onClick={() => onVerify && onVerify(number.id)}
              disabled={isVerifying}
              className="text-[#7367F0] hover:text-[#685DD8] disabled:opacity-50 flex items-center gap-1.5 font-bold transition-colors text-xs cursor-pointer"
              title={isBaileys ? 'Bağlantı durumunu kontrol et' : (t('whatsapp.verifyTooltip') || 'Meta API ile bağlantıyı doğrula')}
            >
              <RotateCw className={cn('w-3.5 h-3.5', isVerifying && 'animate-spin')} />
              <span>{isVerifying ? (t('whatsapp.verifying') || 'Doğrulanıyor...') : (t('whatsapp.testConnection') || 'Doğrula')}</span>
            </button>
          )}

          {/* Edit Button */}
          <button
            type="button"
            onClick={() => onEdit && onEdit(number)}
            className="text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white flex items-center gap-1 font-semibold transition-colors text-xs cursor-pointer ml-2"
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>{t('common.edit') || 'Düzenle'}</span>
          </button>
        </div>

        <div className="flex items-center space-x-1">
          {isConnected && onDisconnect && (
            <button
              type="button"
              onClick={() => onDisconnect(number.id)}
              disabled={isDisconnecting}
              className="text-slate-400 hover:text-[#FF9F43] disabled:opacity-50 p-1.5 rounded-lg transition-colors cursor-pointer"
              title={t('whatsapp.disconnect') || 'Bağlantıyı Kes'}
            >
              <PowerOff className="w-3.5 h-3.5" />
            </button>
          )}

          {onDelete && (
            <IconButton
              icon={Trash2}
              size="sm"
              variant="ghost"
              tooltip={t('whatsapp.deleteNumber') || 'Hattı Kaldır'}
              onClick={() => onDelete(number.id)}
              disabled={isDeleting}
              className="text-slate-400 hover:text-[#EA5455] hover:bg-[#EA5455]/10"
            />
          )}
        </div>
      </div>
    </Card>
  );
};
