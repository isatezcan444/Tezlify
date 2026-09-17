import React from 'react';
import { Plus } from 'lucide-react';
import { Modal, Button } from '../../../components/ui';
import { useI18n } from '../../../context/I18nContext';

export interface LeadAddManualModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  formError: string;
  newLeadName: string;
  setNewLeadName: (val: string) => void;
  newLeadPhone: string;
  setNewLeadPhone: (val: string) => void;
  newLeadCategory: string;
  setNewLeadCategory: (val: string) => void;
  newLeadCity: string;
  setNewLeadCity: (val: string) => void;
  newLeadDistrict: string;
  setNewLeadDistrict: (val: string) => void;
}

export const LeadAddManualModal: React.FC<LeadAddManualModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  formError,
  newLeadName,
  setNewLeadName,
  newLeadPhone,
  setNewLeadPhone,
  newLeadCategory,
  setNewLeadCategory,
  newLeadCity,
  setNewLeadCity,
  newLeadDistrict,
  setNewLeadDistrict,
}) => {
  const { t } = useI18n();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('leads.addNewLeadTitle')}
      subtitle={t('leads.addNewLeadSubtitle')}
      icon={Plus}
      variant="primary"
      maxWidth="md"
    >
      {formError && (
        <div className="mb-4 p-3 rounded-lg bg-rose-50 text-[#EA5455] text-xs font-bold border border-rose-200">
          {formError}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-3.5 text-xs">
        <div>
          <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">
            {t('leads.leadNameRequired')}
          </label>
          <input
            type="text"
            value={newLeadName}
            onChange={(e) => setNewLeadName(e.target.value)}
            placeholder="e.g. Dentgroup Ataşehir"
            className="w-full px-3 py-2 rounded-lg vuexy-input"
            required
          />
        </div>

        <div>
          <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">
            {t('leads.leadPhoneRequired')}
          </label>
          <input
            type="text"
            value={newLeadPhone}
            onChange={(e) => setNewLeadPhone(e.target.value)}
            placeholder="e.g. +905321234567"
            className="w-full px-3 py-2 rounded-lg vuexy-input font-mono"
            required
          />
        </div>

        <div>
          <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">
            {t('leads.categoryLabel')}
          </label>
          <input
            type="text"
            value={newLeadCategory}
            onChange={(e) => setNewLeadCategory(e.target.value)}
            placeholder="e.g. Dental Clinic"
            className="w-full px-3 py-2 rounded-lg vuexy-input"
          />
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">
              {t('leads.cityLabel')}
            </label>
            <input
              type="text"
              value={newLeadCity}
              onChange={(e) => setNewLeadCity(e.target.value)}
              placeholder="İstanbul"
              className="w-full px-3 py-2 rounded-lg vuexy-input"
            />
          </div>
          <div>
            <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">
              {t('leads.districtLabel')}
            </label>
            <input
              type="text"
              value={newLeadDistrict}
              onChange={(e) => setNewLeadDistrict(e.target.value)}
              placeholder="Ataşehir"
              className="w-full px-3 py-2 rounded-lg vuexy-input"
            />
          </div>
        </div>

        <div className="pt-3 flex items-center justify-end space-x-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            className="cursor-pointer"
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            className="font-bold shadow-md shadow-[#7367F0]/30 cursor-pointer"
          >
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
