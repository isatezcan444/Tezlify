import React, { useState, useEffect, useRef } from 'react';
import { ShieldAlert, Loader2, Phone, Search, Building2, Save } from 'lucide-react';
import { ApiClient } from '../../../api/client';
import { Lead } from '../../../types';
import { Modal, Button, Badge } from '../../../components/ui';
import { useToast } from '../../../context/ToastContext';
import { useI18n } from '../../../context/I18nContext';

export interface BlacklistAddModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const BlacklistAddModal: React.FC<BlacklistAddModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const toast = useToast();
  const { t } = useI18n();

  const [newReason, setNewReason] = useState('USER_REQUEST');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Lead[]>([]);
  const [isSearchingLeads, setIsSearchingLeads] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSearchResults([]);
      setSelectedLead(null);
      setShowSuggestions(false);
      setNewReason('USER_REQUEST');
      setSubmitting(false);
    }
  }, [isOpen]);

  // Click outside suggestions
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced search for leads
  useEffect(() => {
    if (!searchQuery.trim() || selectedLead) {
      setSearchResults([]);
      setShowSuggestions(false);
      setIsSearchingLeads(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearchingLeads(true);
      try {
        const res = await ApiClient.getLeads({
          search: searchQuery.trim(),
          size: 8,
        });
        setSearchResults(res.items || []);
        setShowSuggestions(true);
      } catch (err) {
        console.error('Lead search error in blacklist modal:', err);
      } finally {
        setIsSearchingLeads(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [searchQuery, selectedLead]);

  const handleSelectLead = (lead: Lead) => {
    setSelectedLead(lead);
    setShowSuggestions(false);
    setSearchQuery('');
  };

  const handleClearSelectedLead = () => {
    setSelectedLead(null);
    setSearchQuery('');
    setSearchResults([]);
    setShowSuggestions(false);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLead) {
      toast.warning(t('blacklist.selectLeadWarning'));
      return;
    }

    const phone = selectedLead.phone_e164 || selectedLead.phone;
    if (!phone) {
      toast.error(t('blacklist.leadHasNoPhoneError'));
      return;
    }

    setSubmitting(true);
    try {
      await ApiClient.addToBlacklist(phone, newReason);
      toast.success(
        t('blacklist.addedSuccess', { name: selectedLead.name, phone }),
        t('common.success')
      );
      onClose();
      onSuccess();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !submitting && onClose()}
      title={t('blacklist.modalTitle')}
      subtitle={t('blacklist.modalSubtitle')}
      icon={ShieldAlert}
      variant="danger"
      maxWidth="md"
    >
      <form onSubmit={handleAdd} className="space-y-4">
        {/* Mandatory Lead Search Field */}
        <div ref={searchContainerRef} className="relative">
          <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1 flex items-center justify-between">
            <span>{t('blacklist.leadSearchLabel')}</span>
            {selectedLead && (
              <button
                type="button"
                onClick={handleClearSelectedLead}
                className="text-[10px] text-[#7367F0] hover:underline font-bold cursor-pointer"
              >
                {t('blacklist.changeSelection')}
              </button>
            )}
          </label>

          {!selectedLead ? (
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                {isSearchingLeads ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#7367F0]" />
                ) : (
                  <Search className="w-3.5 h-3.5" />
                )}
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => {
                  if (searchResults.length > 0) setShowSuggestions(true);
                }}
                placeholder={t('blacklist.leadSearchPlaceholder')}
                className="w-full pl-9 pr-3 py-2 rounded-lg vuexy-input text-xs font-medium"
                autoFocus
              />
            </div>
          ) : (
            /* Selected Lead Summary Card */
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-[#7367F0]/30 flex items-center justify-between animate-fade-in shadow-sm">
              <div className="space-y-1">
                <div className="font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5 text-xs">
                  <Building2 className="w-3.5 h-3.5 text-[#7367F0]" />
                  <span>{selectedLead.name}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-[#EA5455] font-mono font-bold">
                  <Phone className="w-3 h-3" />
                  <span>{selectedLead.phone_e164 || selectedLead.phone || t('leads.noPhone')}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-slate-400">
                  {selectedLead.category && <span>{selectedLead.category}</span>}
                  {(selectedLead.district || selectedLead.city) && (
                    <span>• {[selectedLead.district, selectedLead.city].filter(Boolean).join(', ')}</span>
                  )}
                </div>
              </div>

              <div className="flex flex-col items-end gap-1.5">
                <Badge variant="success" className="text-[9px] font-bold">
                  {t('common.selected')}
                </Badge>
                <button
                  type="button"
                  onClick={handleClearSelectedLead}
                  className="text-[10px] text-[#7367F0] hover:underline font-bold cursor-pointer"
                >
                  {t('blacklist.changeSelection')}
                </button>
              </div>
            </div>
          )}

          {/* Suggestions Dropdown */}
          {showSuggestions && searchResults.length > 0 && !selectedLead && (
            <div className="absolute left-0 right-0 top-full mt-1.5 bg-white dark:bg-[#25293C] rounded-xl shadow-xl border border-slate-200 dark:border-white/[0.1] max-h-56 overflow-y-auto z-50 divide-y divide-slate-100 dark:divide-white/[0.05] animate-scale-in">
              {searchResults.map((lead) => (
                <button
                  key={lead.id}
                  type="button"
                  onClick={() => handleSelectLead(lead)}
                  className="w-full p-2.5 text-left hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors flex items-center justify-between group cursor-pointer"
                >
                  <div className="space-y-0.5">
                    <div className="font-bold text-slate-800 dark:text-white flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-[#7367F0]" />
                      <span>{lead.name}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-slate-400">
                      {lead.category && <span>{lead.category}</span>}
                      {(lead.district || lead.city) && (
                        <span>
                          {[lead.district, lead.city].filter(Boolean).join(', ')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-right">
                    <span className="text-xs font-mono font-bold text-slate-700 dark:text-slate-300 block">
                      {lead.phone_e164 || lead.phone || t('leads.noPhone')}
                    </span>
                    <span className="text-[9px] text-[#7367F0] group-hover:underline font-bold">
                      {t('common.selected')} ↵
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Reason Selection */}
        <div>
          <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">
            {t('blacklist.blockReasonLabel')}
          </label>
          <select
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
            className="w-full p-2.5 rounded-lg vuexy-input text-xs font-bold cursor-pointer"
          >
            <option value="USER_REQUEST">{t('blacklist.reasonUserRequest')}</option>
            <option value="BOUNCED">{t('blacklist.reasonBounced')}</option>
            <option value="SPAM_COMPLAINT">{t('blacklist.reasonSpamComplaint')}</option>
            <option value="MANUAL_BLACKLIST">{t('blacklist.reasonManual')}</option>
          </select>
        </div>

        {/* Modal Actions */}
        <div className="pt-3 flex items-center space-x-2 border-t border-slate-100 dark:border-white/[0.08]">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="w-1/2 font-bold cursor-pointer"
            disabled={submitting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={submitting || !selectedLead}
            className="w-1/2 font-bold shadow-md shadow-[#EA5455]/30 cursor-pointer space-x-1.5"
          >
            {submitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{t('common.loading')}</span>
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                <span>{t('common.save')}</span>
              </>
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
