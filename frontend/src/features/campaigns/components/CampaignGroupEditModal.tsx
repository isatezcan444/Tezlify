import React, { useState, useEffect, useRef } from 'react';
import {
  Users,
  Target,
  Search,
  Check,
  Plus,
  X,
  Building2,
  Loader2,
} from 'lucide-react';
import { Modal, Button, Badge } from '../../../components/ui';
import { FormField, TextInput } from '../../../components/forms';
import { SectorAutocomplete, LocationMultiSelect } from '../../leads/components';
import { ApiClient } from '../../../api/client';
import { CampaignGroup, Lead } from '../../../types';
import { useToast } from '../../../context/ToastContext';
import { useI18n } from '../../../context/I18nContext';

export interface CampaignGroupEditModalProps {
  isOpen: boolean;
  group: CampaignGroup | null;
  onClose: () => void;
  onSuccess: () => void;
}

export const CampaignGroupEditModal: React.FC<CampaignGroupEditModalProps> = ({
  isOpen,
  group,
  onClose,
  onSuccess,
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editCity, setEditCity] = useState('');
  const [editDistricts, setEditDistricts] = useState<string[]>([]);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const [leadSearchQuery, setLeadSearchQuery] = useState('');
  const [isSearchingLeads, setIsSearchingLeads] = useState(false);
  const [leadSearchResults, setLeadSearchResults] = useState<Lead[]>([]);
  const [showLeadSuggestions, setShowLeadSuggestions] = useState(false);
  const [selectedLeadsToAdd, setSelectedLeadsToAdd] = useState<Lead[]>([]);
  const leadSearchContainerRef = useRef<HTMLDivElement>(null);
  const leadSearchRequestIdRef = useRef(0);

  useEffect(() => {
    if (group) {
      setEditName(group.name);
      setEditCategory(group.target_category || '');
      setLeadSearchQuery('');
      setLeadSearchResults([]);
      setSelectedLeadsToAdd([]);
      setShowLeadSuggestions(false);

      if (group.target_location) {
        const parts = group.target_location.split(' - ');
        setEditCity(parts[0] || '');
        if (parts[1]) {
          setEditDistricts(parts[1].split(', ').filter(Boolean));
        } else {
          setEditDistricts([]);
        }
      } else {
        setEditCity('');
        setEditDistricts([]);
      }
    }
  }, [group]);

  // Click outside suggestions dropdown
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        leadSearchContainerRef.current &&
        !leadSearchContainerRef.current.contains(e.target as Node)
      ) {
        setShowLeadSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced CRM search
  useEffect(() => {
    if (!leadSearchQuery.trim()) {
      setLeadSearchResults([]);
      setShowLeadSuggestions(false);
      setIsSearchingLeads(false);
      return;
    }

    const timer = setTimeout(async () => {
      const requestId = ++leadSearchRequestIdRef.current;
      setIsSearchingLeads(true);
      try {
        const res = await ApiClient.getLeads({
          search: leadSearchQuery.trim(),
          size: 8,
        });
        if (requestId !== leadSearchRequestIdRef.current) return;
        setLeadSearchResults(res.items || []);
        setShowLeadSuggestions(true);
      } catch (err) {
        console.error('Lead search error in edit group modal:', err);
      } finally {
        if (requestId === leadSearchRequestIdRef.current) setIsSearchingLeads(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [leadSearchQuery]);

  const handleSaveGroupEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!group) return;

    try {
      setIsSavingEdit(true);
      const locationParts = [editCity, editDistricts.join(', ')].filter(Boolean);
      const targetLocation = locationParts.length > 0 ? locationParts.join(' - ') : undefined;

      const updated = await ApiClient.updateCampaignGroup(group.id, {
        name: editName.trim() || undefined,
        target_category: editCategory.trim() || undefined,
        target_location: targetLocation,
      });

      if (selectedLeadsToAdd.length > 0) {
        const leadIds = selectedLeadsToAdd.map((l) => l.id);
        const addRes = await ApiClient.addLeadsToCampaignGroup(group.id, leadIds);
        toast.success(addRes.message || `${selectedLeadsToAdd.length} işletme gruba eklendi.`);
      } else {
        toast.success(t('campaignGroups.groupUpdated', { name: updated.name }));
      }

      onClose();
      onSuccess();
    } catch (err: any) {
      toast.error(err.message || 'Grup güncellenemedi.');
    } finally {
      setIsSavingEdit(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen && group !== null}
      onClose={onClose}
      title={`${t('campaignGroups.editGroup')} — ${group?.name || ''}`}
      subtitle={t('campaignGroups.editGroupSubtitle')}
    >
      {group ? (
        <form onSubmit={handleSaveGroupEdit} className="space-y-5">
          {/* Group Metadata Form */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.05] space-y-3">
            <h5 className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5 text-[#7367F0]" />
              <span>{t('campaignGroups.modalCreateTitle')}</span>
            </h5>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label={t('campaignGroups.groupNameLabel')} required>
                <TextInput
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={t('campaignGroups.groupNamePlaceholder')}
                  required
                />
              </FormField>
              <FormField label={t('campaignGroups.sectorLabel')}>
                <SectorAutocomplete
                  value={editCategory}
                  onChange={setEditCategory}
                  placeholder={t('leadFinder.keywordPlaceholder')}
                />
              </FormField>
            </div>
            <FormField label={t('campaignGroups.locationLabel')}>
              <LocationMultiSelect
                selectedCity={editCity}
                selectedDistricts={editDistricts}
                onCityChange={(city) => {
                  setEditCity(city);
                  setEditDistricts([]);
                }}
                onDistrictsChange={setEditDistricts}
              />
            </FormField>
          </div>

          {/* 2. Add Leads from CRM Selector */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.05] space-y-3">
            <div className="flex items-center justify-between">
              <h5 className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-[#7367F0]" />
                <span>{t('campaignGroups.addLeadsToGroupTitle')}</span>
              </h5>
              {selectedLeadsToAdd.length > 0 && (
                <Badge variant="primary" className="text-[10px] font-mono px-2 py-0.5">
                  {selectedLeadsToAdd.length} {t('common.selected')}
                </Badge>
              )}
            </div>

            <div ref={leadSearchContainerRef} className="relative">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={leadSearchQuery}
                  onChange={(e) => setLeadSearchQuery(e.target.value)}
                  onFocus={() => {
                    if (leadSearchResults.length > 0) setShowLeadSuggestions(true);
                  }}
                  placeholder={t('campaignGroups.searchLeadsPlaceholder')}
                  className="w-full pl-9 pr-8 py-2 text-xs rounded-xl bg-white dark:bg-[#2F3349] border border-slate-200/80 dark:border-white/[0.08] focus:border-[#7367F0] focus:ring-1 focus:ring-[#7367F0] outline-none transition-all placeholder:text-slate-400 text-slate-800 dark:text-white"
                />
                {isSearchingLeads ? (
                  <Loader2 className="w-3.5 h-3.5 text-[#7367F0] animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
                ) : leadSearchQuery ? (
                  <button
                    type="button"
                    onClick={() => {
                      setLeadSearchQuery('');
                      setLeadSearchResults([]);
                      setShowLeadSuggestions(false);
                    }}
                    className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer p-0.5"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                ) : null}
              </div>

              {/* Dropdown Suggestions */}
              {showLeadSuggestions && leadSearchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1.5 bg-white dark:bg-[#2F3349] border border-slate-200/80 dark:border-white/[0.08] rounded-xl shadow-2xl z-50 max-h-52 overflow-y-auto divide-y divide-slate-100 dark:divide-white/[0.04] animate-scale-in">
                  {leadSearchResults.map((lead) => {
                    const isAlreadySelected = selectedLeadsToAdd.some((l) => l.id === lead.id);
                    return (
                      <div
                        key={lead.id}
                        onClick={() => {
                          if (isAlreadySelected) {
                            setSelectedLeadsToAdd((prev) => prev.filter((l) => l.id !== lead.id));
                          } else {
                            setSelectedLeadsToAdd((prev) => [...prev, lead]);
                          }
                        }}
                        className={`p-2.5 flex items-center justify-between gap-2.5 hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors cursor-pointer text-xs ${
                          isAlreadySelected ? 'bg-[#7367F0]/10 dark:bg-[#7367F0]/15' : ''
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-slate-800 dark:text-white truncate">
                              {lead.name}
                            </span>
                            {lead.is_whatsapp_eligible ? (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#28C76F]/15 text-[#28C76F] font-bold shrink-0">
                                WA
                              </span>
                            ) : null}
                          </div>
                          <div className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                            <span className="font-mono">{lead.phone_e164 || lead.phone || t('leads.noPhone')}</span>
                            {lead.category && <span>• {lead.category}</span>}
                            {lead.city && <span>• {lead.city}</span>}
                          </div>
                        </div>

                        <div className="shrink-0">
                          {isAlreadySelected ? (
                            <span className="w-5 h-5 rounded-md bg-[#7367F0] text-white flex items-center justify-center shadow-xs">
                              <Check className="w-3.5 h-3.5 stroke-[3]" />
                            </span>
                          ) : (
                            <span className="w-5 h-5 rounded-md border border-slate-300 dark:border-white/20 flex items-center justify-center text-slate-400 hover:border-[#7367F0] hover:text-[#7367F0]">
                              <Plus className="w-3 h-3" />
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Selected Leads Chips */}
            {selectedLeadsToAdd.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap pt-1 max-h-24 overflow-y-auto">
                {selectedLeadsToAdd.map((lead) => (
                  <span
                    key={lead.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#7367F0]/10 text-[#7367F0] text-xs font-semibold border border-[#7367F0]/20 animate-fade-in"
                  >
                    <Building2 className="w-3 h-3 shrink-0" />
                    <span className="truncate max-w-[140px]">{lead.name}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedLeadsToAdd((prev) => prev.filter((l) => l.id !== lead.id))}
                      className="hover:text-rose-500 rounded p-0.5 transition-colors cursor-pointer"
                      title={t('common.delete')}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Modal Bottom Actions */}
          <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-end space-x-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="text-xs cursor-pointer"
            >
              {t('common.cancel')}
            </Button>

            <Button
              type="submit"
              disabled={isSavingEdit}
              className="bg-[#7367F0] hover:bg-[#685dd8] text-white text-xs font-bold px-4 py-2 rounded-xl shadow-md shadow-[#7367F0]/25 cursor-pointer"
            >
              {isSavingEdit ? t('common.loading') : t('campaignGroups.editGroupBtn')}
            </Button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
};
