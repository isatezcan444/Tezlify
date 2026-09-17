import React from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import { Modal, Button } from '../../../components/ui';
import { Campaign } from '../../../types';
import { useI18n } from '../../../context/I18nContext';

export interface CampaignDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
  campaignToDelete: Campaign | null;
}

export const CampaignDeleteModal: React.FC<CampaignDeleteModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
  campaignToDelete,
}) => {
  const { t } = useI18n();

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !isDeleting && onClose()}
      title={t('campaigns.deleteCampaignTitle') || 'Kampanyayı sil?'}
      subtitle={
        t('campaigns.deleteCampaignConfirmMsg') ||
        'Bu kampanyayı silmek istediğinizden emin misiniz? Bu işlem geri alınamaz.'
      }
      icon={Trash2}
      variant="danger"
      maxWidth="sm"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="cancel-delete-campaign-btn"
            disabled={isDeleting}
            onClick={onClose}
            className="cursor-pointer font-bold"
          >
            {t('campaigns.deleteCampaignCancelBtn') || t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="confirm-delete-campaign-btn"
            disabled={isDeleting}
            onClick={onConfirm}
            className="bg-[#EA5455] hover:bg-[#D43B3C] text-white font-bold space-x-1.5 shadow-md shadow-[#EA5455]/30 cursor-pointer"
          >
            {isDeleting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{t('common.loading')}</span>
              </>
            ) : (
              <>
                <Trash2 className="w-4 h-4" />
                <span>{t('campaigns.deleteCampaignBtn') || 'Kampanyayı Sil'}</span>
              </>
            )}
          </Button>
        </>
      }
    >
      {campaignToDelete && (
        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-xs space-y-1.5">
          <div className="font-bold text-slate-800 dark:text-white flex items-center justify-between">
            <span className="truncate">{campaignToDelete.name}</span>
            <span className="font-mono text-[10px] text-slate-400">ID: #{campaignToDelete.id}</span>
          </div>
          {campaignToDelete.description && (
            <p className="text-slate-500 dark:text-slate-400 text-[11px] line-clamp-2">
              {campaignToDelete.description}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
};
