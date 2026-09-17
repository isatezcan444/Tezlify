import * as React from 'react';
import { CheckCircle2, AlertTriangle, XCircle, ShieldCheck } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useI18n } from '../../../context/I18nContext';

export interface VerificationBadgeProps {
  status?: string;
  isVerified?: boolean;
  score?: number;
  className?: string;
  verifiedLabel?: string;
  rejectedLabel?: string;
  unverifiedLabel?: string;
}

export const VerificationBadge: React.FC<VerificationBadgeProps> = ({
  status = 'VERIFIED',
  isVerified = true,
  score,
  className,
  verifiedLabel,
  rejectedLabel,
  unverifiedLabel,
}) => {
  const { t } = useI18n();
  if (isVerified || status === 'VERIFIED') {
    return (
      <span
        className={cn(
          'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-[#28C76F]/15 text-[#28C76F] border border-[#28C76F]/30 text-[10px] font-bold font-mono select-none',
          className
        )}
      >
        <ShieldCheck className="w-3 h-3" />
        <span>{verifiedLabel ?? t('common.verified')} {score ? `(${score})` : ''}</span>
      </span>
    );
  }

  if (status === 'REJECTED' || status === 'INVALID') {
    return (
      <span
        className={cn(
          'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-[#EA5455]/15 text-[#EA5455] border border-[#EA5455]/30 text-[10px] font-bold font-mono select-none',
          className
        )}
      >
        <XCircle className="w-3 h-3" />
        <span>{rejectedLabel ?? t('common.rejected')}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-[#FF9F43]/15 text-[#FF9F43] border border-[#FF9F43]/30 text-[10px] font-bold font-mono select-none',
        className
      )}
    >
      <AlertTriangle className="w-3 h-3" />
      <span>{unverifiedLabel ?? t('common.unverified')}</span>
    </span>
  );
};
