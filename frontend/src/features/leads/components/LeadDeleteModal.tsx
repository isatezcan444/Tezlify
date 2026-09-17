import React from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import { Modal, Button } from '../../../components/ui';
import { Lead } from '../../../types';
import { useI18n } from '../../../context/I18nContext';

export interface LeadDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
  isBulkDelete: boolean;
  leadToDelete: Lead | null;
  selectedCount: number;
  total: number;
  leadsCount: number;
  selectAllMatching: boolean;
  setSelectAllMatching: (val: boolean) => void;
}

export const LeadDeleteModal: React.FC<LeadDeleteModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
  isBulkDelete,
  leadToDelete,
  selectedCount,
  total,
  leadsCount,
  selectAllMatching,
  setSelectAllMatching,
}) => {
  const { t } = useI18n();

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !isDeleting && onClose()}
      title={
        isBulkDelete
          ? selectAllMatching
            ? t('leads.bulkDeleteAll', { total })
            : t('leads.bulkDelete', { count: selectedCount })
          : t('leads.deleteConfirmTitle')
      }
      subtitle={t('leads.deleteConfirmMsg')}
      icon={Trash2}
      variant="danger"
      maxWidth="md"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isDeleting}
            onClick={onClose}
            className="cursor-pointer"
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
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
                <span>{t('common.delete')}</span>
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-xs text-slate-600 dark:text-slate-300 space-y-3">
        {!isBulkDelete && leadToDelete ? (
          <p>
            <strong className="text-slate-800 dark:text-white font-bold">{leadToDelete.name}</strong> - {t('leads.deleteConfirmMsg')}
          </p>
        ) : (
          <div className="space-y-2">
            <label className="flex items-start space-x-2.5 p-2 rounded-lg border border-slate-200 dark:border-white/[0.08] cursor-pointer hover:bg-slate-100 dark:hover:bg-white/[0.03] transition-colors">
              <input
                type="radio"
                name="deleteScope"
                checked={!selectAllMatching}
                onChange={() => setSelectAllMatching(false)}
                className="mt-0.5 text-[#EA5455] focus:ring-0"
              />
              <div>
                <span className="font-bold text-slate-800 dark:text-white">
                  {t('leads.bulkDelete', { count: selectedCount })}
                </span>
              </div>
            </label>

            {total > leadsCount && (
              <label className="flex items-start space-x-2.5 p-2 rounded-lg border border-rose-200 dark:border-rose-500/30 bg-rose-50/50 dark:bg-rose-500/10 cursor-pointer hover:bg-rose-50 dark:hover:bg-rose-500/20 transition-colors">
                <input
                  type="radio"
                  name="deleteScope"
                  checked={selectAllMatching}
                  onChange={() => setSelectAllMatching(true)}
                  className="mt-0.5 text-[#EA5455] focus:ring-0"
                />
                <div>
                  <span className="font-bold text-[#EA5455]">
                    {t('leads.bulkDeleteAll', { total })}
                  </span>
                </div>
              </label>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};
