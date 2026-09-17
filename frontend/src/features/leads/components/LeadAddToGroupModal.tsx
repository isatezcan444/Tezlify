import React from 'react';
import { FolderPlus, Loader2, Building2, Plus } from 'lucide-react';
import { Modal, Button, Badge } from '../../../components/ui';
import { Lead, CampaignGroup } from '../../../types';
import { useI18n } from '../../../context/I18nContext';

export interface LeadAddToGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isAddingToGroup: boolean;
  singleLeadForGroup: Lead | null;
  selectAllMatching: boolean;
  total: number;
  selectedCount: number;
  campaignGroups: CampaignGroup[];
  isLoadingGroups: boolean;
  selectedTargetGroupId: number | 'NEW';
  setSelectedTargetGroupId: (val: number | 'NEW') => void;
  newGroupName: string;
  setNewGroupName: (val: string) => void;
}

export const LeadAddToGroupModal: React.FC<LeadAddToGroupModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  isAddingToGroup,
  singleLeadForGroup,
  selectAllMatching,
  total,
  selectedCount,
  campaignGroups,
  isLoadingGroups,
  selectedTargetGroupId,
  setSelectedTargetGroupId,
  newGroupName,
  setNewGroupName,
}) => {
  const { t } = useI18n();

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !isAddingToGroup && onClose()}
      title={t('leads.addToGroupModalTitle')}
      subtitle={t('leads.addToGroupModalSubtitle')}
      icon={FolderPlus}
      variant="primary"
      maxWidth="md"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isAddingToGroup}
            onClick={onClose}
            className="cursor-pointer"
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isAddingToGroup || (selectedTargetGroupId === 'NEW' && !newGroupName.trim())}
            onClick={onConfirm}
            className="bg-[#7367F0] hover:bg-[#685dd8] text-white font-bold space-x-1.5 shadow-md shadow-[#7367F0]/30 cursor-pointer"
          >
            {isAddingToGroup ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{t('common.loading')}</span>
              </>
            ) : (
              <>
                <FolderPlus className="w-4 h-4" />
                <span>{t('leads.addToGroupBtn')}</span>
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        {/* Target Leads Summary Box */}
        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] flex items-center justify-between">
          <div className="flex items-center space-x-2 min-w-0 pr-2">
            <Building2 className="w-4 h-4 text-[#7367F0] shrink-0" />
            <span className="font-bold text-slate-800 dark:text-white truncate">
              {singleLeadForGroup
                ? singleLeadForGroup.name
                : selectAllMatching
                ? t('leads.allMatchingSelected', { total })
                : t('leads.bulkToolbarCount', { count: selectedCount })}
            </span>
          </div>
          <Badge variant="primary" className="text-[10px] shrink-0">
            {singleLeadForGroup ? 1 : selectedCount} {t('campaignGroups.businesses')}
          </Badge>
        </div>

        {/* Group Choice Selection */}
        <div className="space-y-3">
          <label className="text-slate-700 dark:text-slate-300 font-bold block">
            {t('leads.selectExistingGroup')}
          </label>

          {isLoadingGroups ? (
            <div className="p-4 text-center text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
              <span>{t('common.loading')}</span>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Radio choice for New Group */}
              <label
                className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-colors ${
                  selectedTargetGroupId === 'NEW'
                    ? 'bg-[#7367F0]/10 border-[#7367F0] text-[#7367F0]'
                    : 'bg-white dark:bg-[#25293C] border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center space-x-2.5">
                  <input
                    type="radio"
                    name="targetGroupChoice"
                    value="NEW"
                    checked={selectedTargetGroupId === 'NEW'}
                    onChange={() => setSelectedTargetGroupId('NEW')}
                    className="text-[#7367F0] focus:ring-[#7367F0]"
                  />
                  <span className="font-bold">{t('leads.createNewGroupOption')}</span>
                </div>
                <Plus className="w-4 h-4" />
              </label>

              {selectedTargetGroupId === 'NEW' && (
                <div className="pl-6 pr-1 pt-1 pb-2">
                  <input
                    type="text"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder={t('leads.newGroupNamePlaceholder')}
                    className="w-full px-3 py-2 rounded-lg vuexy-input text-xs"
                    autoFocus
                  />
                </div>
              )}

              {/* List of Existing Campaign Groups */}
              {campaignGroups.length > 0 && (
                <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
                  {campaignGroups.map((grp) => {
                    const isSelected = selectedTargetGroupId === grp.id;
                    return (
                      <label
                        key={grp.id}
                        className={`p-2.5 px-3 rounded-xl border flex items-center justify-between cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-[#7367F0]/10 border-[#7367F0] text-[#7367F0]'
                            : 'bg-white dark:bg-[#25293C] border-slate-200/80 dark:border-white/10 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                        }`}
                      >
                        <div className="flex items-center space-x-2.5 min-w-0 pr-2">
                          <input
                            type="radio"
                            name="targetGroupChoice"
                            value={grp.id}
                            checked={isSelected}
                            onChange={() => setSelectedTargetGroupId(grp.id)}
                            className="text-[#7367F0] focus:ring-[#7367F0]"
                          />
                          <div className="min-w-0 truncate">
                            <div className="font-bold truncate">{grp.name}</div>
                            <div className="text-[10px] text-slate-400 truncate">
                              {grp.target_category || ''} {grp.target_location ? `• ${grp.target_location}` : ''}
                            </div>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <Badge variant="primary" className="text-[9px]">
                            {grp.total_leads_count} {t('campaignGroups.businesses')}
                          </Badge>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
