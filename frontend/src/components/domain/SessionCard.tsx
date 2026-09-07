import * as React from 'react';
import { 
  Smartphone, 
  Flame, 
  BatteryCharging, 
  PowerOff, 
  QrCode, 
  Trash2 
} from 'lucide-react';
import { WhatsAppSession } from '../../types';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { IconButton } from '../ui/IconButton';
import { cn } from '../../lib/utils';
import { useI18n } from '../../context/I18nContext';

export interface SessionCardProps {
  session: WhatsAppSession;
  onDisconnect?: (sessionId: number) => void;
  onScanQR?: (sessionId: number) => void;
  onDelete?: (sessionId: number) => void;
  className?: string;
}

export const SessionCard: React.FC<SessionCardProps> = ({
  session,
  onDisconnect,
  onScanQR,
  onDelete,
  className,
}) => {
  const { t } = useI18n();
  const quotaPercent = session.max_daily_limit > 0
    ? Math.round((session.daily_sent_count / session.max_daily_limit) * 100)
    : 0;

  const isConnected = session.status === 'CONNECTED';

  return (
    <Card className={cn('p-5 space-y-4 flex flex-col justify-between hover:shadow-md transition-all', className)}>
      <div>
        {/* Header: Device Icon, Name, Phone & Status */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center space-x-3">
            <div
              className={cn(
                'w-10 h-10 rounded-xl flex items-center justify-center font-bold shrink-0 transition-colors',
                isConnected
                  ? 'bg-[#28C76F]/15 text-[#28C76F]'
                  : 'bg-slate-100 dark:bg-white/[0.06] text-slate-400'
              )}
            >
              <Smartphone className="w-5 h-5" />
            </div>

            <div>
              <h4 className="font-extrabold text-sm text-slate-800 dark:text-white leading-tight">
                {session.session_name}
              </h4>
              <p className="font-mono text-xs text-slate-500 dark:text-[#7E7F96] mt-0.5 font-bold">
                {session.phone_number || t('leads.noPhone')}
              </p>
            </div>
          </div>

          <Badge variant={isConnected ? 'success' : 'outline'} className="text-[10px] uppercase font-mono font-bold">
            {session.status}
          </Badge>
        </div>

        {/* Warmup & Daily Limit Metrics Box */}
        <div className="mt-4 space-y-2.5 p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05]">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500 dark:text-[#7E7F96] flex items-center gap-1.5 font-bold">
              <Flame className="w-3.5 h-3.5 text-[#FF9F43]" />
              {t('whatsapp.warmUpDay', { day: session.warm_up_day })}:
            </span>
            <span className="font-extrabold text-[#FF9F43] font-mono">#{session.warm_up_day}</span>
          </div>

          <div>
            <div className="flex justify-between text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-1">
              <span>{t('whatsapp.dailyLimit')}</span>
              <span className="font-mono text-[#7367F0]">
                {session.daily_sent_count} / {session.max_daily_limit}
              </span>
            </div>
            <div className="h-1.5 w-full bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden p-0.5">
              <div
                className="h-full bg-gradient-to-r from-[#7367F0] to-[#28C76F] rounded-full transition-all duration-300"
                style={{ width: `${Math.min(quotaPercent, 100)}%` }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1 font-semibold">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[#28C76F] animate-pulse' : 'bg-slate-400'}`} />
              <span className={isConnected ? 'text-[#28C76F] font-bold' : 'text-slate-400 font-medium'}>
                {isConnected ? (t('whatsapp.connectionActive') || 'Multi-Device Aktif') : (t('whatsapp.disconnected') || 'Bağlantı Yok')}
              </span>
            </span>
            <span className="font-mono text-[10px] text-slate-400">
              {isConnected ? (t('whatsapp.socketLive') || 'Canlı Soket') : (t('whatsapp.offline') || 'Çevrimdışı')}
            </span>
          </div>
        </div>
      </div>

      {/* Card Actions Footer */}
      <div className="pt-2 flex items-center justify-between border-t border-slate-100 dark:border-white/[0.06] text-xs">
        {isConnected ? (
          <button
            type="button"
            onClick={() => onDisconnect && onDisconnect(session.id)}
            className="text-slate-500 hover:text-[#FF9F43] flex items-center gap-1.5 font-bold transition-colors text-xs cursor-pointer"
          >
            <PowerOff className="w-3.5 h-3.5" />
            <span>{t('whatsapp.disconnect')}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onScanQR && onScanQR(session.id)}
            className="text-[#7367F0] hover:text-[#685DD8] flex items-center gap-1.5 font-bold text-xs cursor-pointer"
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>{t('whatsapp.scanQrToConnect')}</span>
          </button>
        )}

        {onDelete && (
          <IconButton
            icon={Trash2}
            size="sm"
            variant="ghost"
            tooltip={t('whatsapp.deleteSession')}
            onClick={() => onDelete(session.id)}
            className="text-slate-400 hover:text-[#EA5455] hover:bg-[#EA5455]/10"
          />
        )}
      </div>
    </Card>
  );
};
