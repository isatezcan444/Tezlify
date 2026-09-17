import React, { useState, useEffect } from 'react';
import { Modal, Button } from '../../../components/ui';
import { TextInput } from '../../../components/forms/TextInput';
import { CampaignGroup } from '../../../types';
import { useI18n } from '../../../context/I18nContext';

export interface LeadFinderSaveModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (mode: 'NEW' | 'EXISTING', groupName: string, groupId: number | null) => void;
  isSavingGroup: boolean;
  savedLeadsCount: number;
  existingGroups: CampaignGroup[];
  defaultMode?: 'NEW' | 'EXISTING';
  defaultGroupName?: string;
}

export const LeadFinderSaveModal: React.FC<LeadFinderSaveModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  isSavingGroup,
  savedLeadsCount,
  existingGroups,
  defaultMode = 'NEW',
  defaultGroupName = '',
}) => {
  const { t } = useI18n();
  const [saveMode, setSaveMode] = useState<'NEW' | 'EXISTING'>(defaultMode);
  const [saveGroupName, setSaveGroupName] = useState(defaultGroupName);
  const [saveGroupId, setSaveGroupId] = useState<number | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSaveMode(defaultMode);
      setSaveGroupName(defaultGroupName);
      if (existingGroups.length > 0) {
        setSaveGroupId(existingGroups[0].id);
      } else {
        setSaveGroupId(null);
      }
    }
  }, [isOpen, defaultMode, defaultGroupName, existingGroups]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(saveMode, saveGroupName, saveGroupId);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('leadFinder.saveModalTitle')}
      subtitle={t('leadFinder.saveModalSubtitle')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Options Radios */}
        <div className="space-y-2">
          <label
            onClick={() => setSaveMode('NEW')}
            className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
              saveMode === 'NEW'
                ? 'border-[#7367F0] bg-[#7367F0]/5 dark:bg-[#7367F0]/10'
                : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/[0.02]'
            }`}
          >
            <input
              type="radio"
              name="saveMode"
              checked={saveMode === 'NEW'}
              onChange={() => setSaveMode('NEW')}
              className="mt-0.5 text-[#7367F0] focus:ring-[#7367F0]"
            />
            <div className="min-w-0">
              <span className="text-xs font-bold text-slate-800 dark:text-white block">
                {t('leadFinder.saveOptionNew')}
              </span>
              <span className="text-[11px] text-slate-400">
                {t('leadFinder.saveOptionNewDesc')}
              </span>
            </div>
          </label>

          <label
            onClick={() => {
              if (existingGroups.length > 0) setSaveMode('EXISTING');
            }}
            className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
              saveMode === 'EXISTING'
                ? 'border-[#7367F0] bg-[#7367F0]/5 dark:bg-[#7367F0]/10'
                : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/[0.02]'
            }`}
          >
            <input
              type="radio"
              name="saveMode"
              checked={saveMode === 'EXISTING'}
              onChange={() => setSaveMode('EXISTING')}
              disabled={existingGroups.length === 0}
              className="mt-0.5 text-[#7367F0] focus:ring-[#7367F0]"
            />
            <div className="min-w-0">
              <span className="text-xs font-bold text-slate-800 dark:text-white block">
                {t('leadFinder.saveOptionExisting')}
              </span>
              <span className="text-[11px] text-slate-400">
                {existingGroups.length === 0
                  ? t('leadFinder.noExistingGroups')
                  : t('leadFinder.saveOptionExistingDesc')}
              </span>
            </div>
          </label>
        </div>

        {/* New Group Name Input */}
        {saveMode === 'NEW' && (
          <div className="pt-2">
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
              {t('campaignGroups.groupNameLabel')}
            </label>
            <TextInput
              value={saveGroupName}
              onChange={(e) => setSaveGroupName(e.target.value)}
              placeholder={t('campaignGroups.groupNamePlaceholder')}
              className="w-full"
              required
            />
          </div>
        )}

        {/* Existing Group Selection List */}
        {saveMode === 'EXISTING' && existingGroups.length > 0 && (
          <div className="pt-2 space-y-2 max-h-48 overflow-y-auto rounded-xl border border-slate-100 dark:border-white/10 p-2">
            {existingGroups.map((g) => (
              <label
                key={g.id}
                onClick={() => setSaveGroupId(g.id)}
                className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-all ${
                  saveGroupId === g.id
                    ? 'border-[#7367F0] bg-[#7367F0]/10 font-bold text-[#7367F0]'
                    : 'border-transparent hover:bg-slate-50 dark:hover:bg-white/[0.04] text-slate-700 dark:text-slate-300'
                }`}
              >
                <div className="flex items-center gap-2 text-xs truncate">
                  <input
                    type="radio"
                    name="existingGroup"
                    checked={saveGroupId === g.id}
                    onChange={() => setSaveGroupId(g.id)}
                    className="text-[#7367F0] focus:ring-[#7367F0]"
                  />
                  <span className="truncate">{g.name}</span>
                </div>
                <span className="text-[11px] text-slate-400 font-normal shrink-0">
                  {g.total_leads_count} {t('campaignGroups.businesses')}
                </span>
              </label>
            ))}
          </div>
        )}

        {/* Info Badge */}
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.05] space-y-1">
          <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
            {t('leadFinder.savingLeadsCount', { count: savedLeadsCount })}
          </p>
          <p className="text-[11px] text-slate-400">
            {t('leadFinder.duplicateNotice')}
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-white/[0.06]">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="text-xs font-semibold cursor-pointer"
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={isSavingGroup || (saveMode === 'EXISTING' && !saveGroupId)}
            className="bg-[#7367F0] hover:bg-[#685dd8] text-white text-xs font-bold px-5 cursor-pointer"
          >
            {isSavingGroup ? t('common.loading') : t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
