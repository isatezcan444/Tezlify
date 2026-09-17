import React, { useState } from 'react';
import { Target, Plus, FolderKanban, Sparkles } from 'lucide-react';
import { Card, Button } from '../../../components/ui';
import { FormField, TextInput, FormSection } from '../../../components/forms';
import { SectorAutocomplete, LocationMultiSelect } from '../../leads/components';
import { ApiClient } from '../../../api/client';
import { useToast } from '../../../context/ToastContext';
import { useI18n } from '../../../context/I18nContext';

export interface CampaignGroupCreateViewProps {
  onCancel: () => void;
  onSuccess: () => void;
}

export const CampaignGroupCreateView: React.FC<CampaignGroupCreateViewProps> = ({
  onCancel,
  onSuccess,
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const [createName, setCreateName] = useState('');
  const [createCategory, setCreateCategory] = useState('');
  const [createCity, setCreateCity] = useState('');
  const [createDistricts, setCreateDistricts] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmitting(true);
      const locationParts = [createCity, createDistricts.join(', ')].filter(Boolean);
      const targetLocation = locationParts.length > 0 ? locationParts.join(' - ') : undefined;

      const created = await ApiClient.createCampaignGroup({
        name: createName.trim() || undefined,
        target_category: createCategory.trim() || undefined,
        target_location: targetLocation,
      });

      toast.success(t('campaignGroups.groupCreated', { name: created.name }));
      setCreateName('');
      setCreateCategory('');
      setCreateCity('');
      setCreateDistricts([]);
      onSuccess();
    } catch (err: any) {
      toast.error(err.message || 'Grup oluşturulamadı.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleCreateGroup} noValidate className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-6">
          <Card className="p-6 space-y-6">
            <FormSection
              title={t('campaignGroups.modalCreateTitle')}
              subtitle={t('campaignGroups.modalCreateSubtitle')}
              icon={Target}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label={t('campaignGroups.groupNameLabel')} required>
                  <TextInput
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder={t('campaignGroups.groupNamePlaceholder')}
                    required
                  />
                </FormField>

                <FormField label={t('campaignGroups.sectorLabel')}>
                  <SectorAutocomplete
                    value={createCategory}
                    onChange={setCreateCategory}
                    placeholder={t('leadFinder.keywordPlaceholder')}
                  />
                </FormField>
              </div>

              <FormField label={t('campaignGroups.locationLabel')}>
                <LocationMultiSelect
                  selectedCity={createCity}
                  selectedDistricts={createDistricts}
                  onCityChange={(city) => {
                    setCreateCity(city);
                    setCreateDistricts([]);
                  }}
                  onDistrictsChange={setCreateDistricts}
                />
              </FormField>
            </FormSection>

            {/* Form Actions */}
            <div className="pt-4 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-end space-x-3">
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
                className="cursor-pointer"
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting}
                className="bg-[#7367F0] hover:bg-[#685dd8] text-white font-bold cursor-pointer shadow-md shadow-[#7367F0]/25 space-x-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>{isSubmitting ? t('common.loading') : t('campaignGroups.createBtn')}</span>
              </Button>
            </div>
          </Card>
        </div>

        {/* Sidebar Guide Card */}
        <div className="lg:col-span-4 space-y-6">
          <Card className="p-6 space-y-4 border-slate-200/80 dark:border-white/[0.05]">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center font-bold">
                <FolderKanban className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-slate-800 dark:text-white">
                  {t('campaignGroups.guideTitle')}
                </h4>
                <p className="text-[11px] text-slate-400">{t('campaignGroups.guideSubtitle')}</p>
              </div>
            </div>
            <p className="text-xs text-slate-500 dark:text-[#7E7F96] leading-relaxed">
              {t('campaignGroups.guideDesc')}
            </p>
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.05] text-[11px] text-slate-400 space-y-1">
              <div className="font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#7367F0]" />
                <span>{t('campaignGroups.guideQuickTitle')}</span>
              </div>
              <p>{t('campaignGroups.guideQuickDesc')}</p>
            </div>
          </Card>
        </div>
      </div>
    </form>
  );
};
