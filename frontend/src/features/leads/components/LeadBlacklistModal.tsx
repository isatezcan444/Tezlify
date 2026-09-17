import React from 'react';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { Modal, Button } from '../../../components/ui';
import { Lead } from '../../../types';
import { useI18n } from '../../../context/I18nContext';

export interface LeadBlacklistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isBlacklisting: boolean;
  isBulkBlacklist: boolean;
  leadToBlacklist: Lead | null;
  selectedCount: number;
  blacklistReason: string;
  setBlacklistReason: (reason: string) => void;
}

const BLACKLIST_REASONS = [
  'USER_REQUEST',
  'BOUNCED',
  'SPAM_COMPLAINT',
  'MANUAL_BLACKLIST',
] as const;

export const LeadBlacklistModal: React.FC<LeadBlacklistModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  isBlacklisting,
  isBulkBlacklist,
  leadToBlacklist,
  selectedCount,
  blacklistReason,
  setBlacklistReason,
}) => {
  const { t } = useI18n();

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !isBlacklisting && onClose()}
      title={isBulkBlacklist ? t('blacklist.confirmBulkRemoveTitle') : t('blacklist.modalTitle')}
      subtitle={t('blacklist.subtitle')}
      icon={ShieldAlert}
      variant="warning"
      maxWidth="md"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBlacklisting}
            onClick={onClose}
            className="cursor-pointer"
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isBlacklisting}
            onClick={onConfirm}
            className="bg-[#FF9F43] hover:bg-[#E58A32] text-white font-bold space-x-1.5 shadow-md shadow-[#FF9F43]/30 cursor-pointer"
          >
            {isBlacklisting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{t('common.loading')}</span>
              </>
            ) : (
              <>
                <ShieldAlert className="w-4 h-4" />
                <span>{t('blacklist.addNumber')}</span>
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-xs text-slate-600 dark:text-slate-300 space-y-2">
          {!isBulkBlacklist && leadToBlacklist ? (
            <p>
              <strong className="text-slate-800 dark:text-white font-bold">{leadToBlacklist.name}</strong> ({leadToBlacklist.phone_e164 || leadToBlacklist.phone})
            </p>
          ) : (
            <p>
              {t('blacklist.selectedToolbarCount', { count: selectedCount })}
            </p>
          )}
        </div>

        <div className="space-y-2 text-xs">
          <label className="text-slate-700 dark:text-slate-300 font-bold block">{t('blacklist.blockReasonLabel')}</label>
          <div className="flex flex-wrap gap-1.5">
            {BLACKLIST_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setBlacklistReason(r)}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                  blacklistReason === r
                    ? 'bg-[#FF9F43]/15 text-[#FF9F43] border-[#FF9F43]'
                    : 'bg-white dark:bg-white/[0.03] border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300 hover:bg-slate-50'
                }`}
              >
                {r === 'USER_REQUEST'
                  ? t('blacklist.reasonUserRequest')
                  : r === 'BOUNCED'
                  ? t('blacklist.reasonBounced')
                  : r === 'SPAM_COMPLAINT'
                  ? t('blacklist.reasonSpamComplaint')
                  : t('blacklist.reasonManual')}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
};
