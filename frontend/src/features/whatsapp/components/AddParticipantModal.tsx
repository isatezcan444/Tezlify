import React, { useState, useEffect, useMemo } from 'react';
import {
  UserPlus,
  Users,
  Search,
  Phone,
  Check,
  Loader2,
  AlertCircle,
  X,
} from 'lucide-react';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/button';
import { Avatar } from '../../../components/ui/Avatar';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { WhatsAppRepository } from '../data/whatsappRepository';
import { WhatsAppApi } from '../api/whatsappApi';
import { formatPhoneNumber, stripJidPrefix } from '../lib/whatsappIdentity';

export interface AddParticipantModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: number;
  groupSubject?: string;
  existingParticipants: Array<{ id: string; phone?: string; name?: string }>;
  onParticipantsAdded?: () => void;
}

export const AddParticipantModal: React.FC<AddParticipantModalProps> = ({
  isOpen,
  onClose,
  conversationId,
  groupSubject,
  existingParticipants = [],
  onParticipantsAdded,
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<'contacts' | 'manual'>('contacts');
  const [contacts, setContacts] = useState<any[]>([]);
  const [loadingContacts, setLoadingContacts] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedJids, setSelectedJids] = useState<Set<string>>(new Set());

  // Manual Phone State
  const [manualPhone, setManualPhone] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Set of existing normalized phones/JIDs to detect already added members
  const existingPhonesSet = useMemo(() => {
    const s = new Set<string>();
    for (const p of existingParticipants) {
      if (p.id) {
        s.add(p.id.toLowerCase());
        const stripped = stripJidPrefix(p.id).replace(/\D/g, '');
        if (stripped) s.add(stripped);
      }
      if (p.phone) {
        const clean = p.phone.replace(/\D/g, '');
        if (clean) s.add(clean);
      }
    }
    return s;
  }, [existingParticipants]);

  // Load contacts when modal opens
  useEffect(() => {
    if (!isOpen) {
      setSelectedJids(new Set());
      setManualPhone('');
      setSearchQuery('');
      return;
    }

    let isMounted = true;
    setLoadingContacts(true);
    WhatsAppRepository.getWhatsAppContacts()
      .then((data) => {
        if (!isMounted) return;
        if (Array.isArray(data)) {
          setContacts(data);
        }
      })
      .catch((err) => {
        console.warn('[AddParticipantModal] Failed to load contacts:', err);
      })
      .finally(() => {
        if (isMounted) setLoadingContacts(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  // Filtered contacts based on search query
  const filteredContacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return contacts.filter((c) => {
      const name = (c.name || '').toLowerCase();
      const phoneDigits = (c.phone || c.id || '').replace(/\D/g, '');
      if (!q) return true;
      return name.includes(q) || phoneDigits.includes(q);
    });
  }, [contacts, searchQuery]);

  const toggleSelectContact = (jid: string) => {
    setSelectedJids((prev) => {
      const next = new Set(prev);
      if (next.has(jid)) {
        next.delete(jid);
      } else {
        next.add(jid);
      }
      return next;
    });
  };

  const handleAddParticipants = async () => {
    const toAdd: string[] = [];

    if (activeTab === 'contacts') {
      toAdd.push(...Array.from(selectedJids));
    } else {
      const clean = manualPhone.replace(/\D/g, '');
      if (!clean || clean.length < 7) {
        toast.error(t('whatsapp.invalidPhoneNumber'));
        return;
      }
      if (existingPhonesSet.has(clean)) {
        toast.error(t('whatsapp.phoneAlreadyInGroup'));
        return;
      }
      toAdd.push(`${clean}@s.whatsapp.net`);
    }

    if (toAdd.length === 0) return;

    setSubmitting(true);
    try {
      await WhatsAppApi.updateGroupParticipants(conversationId, toAdd, 'add');
      toast.success(t('whatsapp.participantsAddedSuccess'));
      onParticipantsAdded?.();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || t('whatsapp.participantsAddError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('whatsapp.addParticipantTitle')}
      icon={UserPlus}
      maxWidth="md"
    >

      <div className="space-y-4">
        {groupSubject && (
          <div className="flex items-center space-x-2 px-3 py-2 rounded-xl bg-slate-50 dark:bg-white/[0.04] border border-slate-200/60 dark:border-white/[0.06] text-xs">
            <Users className="w-4 h-4 text-[#7367F0] shrink-0" />
            <span className="font-bold text-slate-700 dark:text-slate-200 truncate">
              {groupSubject}
            </span>
          </div>
        )}

        {/* Tab Switcher */}
        <div className="flex p-1 bg-slate-100 dark:bg-black/20 rounded-xl gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('contacts')}
            className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center justify-center space-x-1.5 ${
              activeTab === 'contacts'
                ? 'bg-white dark:bg-[#202c33] text-[#7367F0] shadow-sm'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>{t('whatsapp.selectFromContacts')}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('manual')}
            className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center justify-center space-x-1.5 ${
              activeTab === 'manual'
                ? 'bg-white dark:bg-[#202c33] text-[#7367F0] shadow-sm'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Phone className="w-3.5 h-3.5" />
            <span>{t('whatsapp.addByPhone')}</span>
          </button>
        </div>

        {activeTab === 'contacts' ? (
          <div className="space-y-3">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('whatsapp.searchParticipants')}
                className="w-full pl-9 pr-3.5 py-2 text-xs rounded-xl border border-slate-200/80 dark:border-white/10 bg-slate-50/70 dark:bg-[#111b21] text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-[#7367F0] transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Contacts List */}
            <div className="max-h-64 overflow-y-auto custom-scrollbar space-y-1 pr-1 border border-slate-100 dark:border-white/[0.06] rounded-xl p-1.5">
              {loadingContacts ? (
                <div className="py-8 flex flex-col items-center justify-center text-slate-400 space-y-2">
                  <Loader2 className="w-5 h-5 animate-spin text-[#7367F0]" />
                  <span className="text-xs">{t('common.loading')}</span>
                </div>
              ) : filteredContacts.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400">
                  {t('whatsapp.noContactsAvailable')}
                </div>
              ) : (
                filteredContacts.map((contact) => {
                  const jid = contact.id || `${contact.phone}@s.whatsapp.net`;
                  const cleanPhone = (contact.phone || contact.id || '').replace(/\D/g, '');
                  const isAlreadyIn = existingPhonesSet.has(jid.toLowerCase()) || (cleanPhone && existingPhonesSet.has(cleanPhone));
                  const isSelected = selectedJids.has(jid);
                  const displayName = contact.name || formatPhoneNumber(contact.phone) || contact.phone || jid;

                  return (
                    <div
                      key={jid}
                      onClick={() => {
                        if (!isAlreadyIn) toggleSelectContact(jid);
                      }}
                      className={`flex items-center justify-between p-2 rounded-xl transition-all select-none ${
                        isAlreadyIn
                          ? 'opacity-50 cursor-not-allowed bg-slate-50 dark:bg-white/[0.02]'
                          : isSelected
                          ? 'bg-[#7367F0]/10 border border-[#7367F0]/30 cursor-pointer'
                          : 'hover:bg-slate-100/70 dark:hover:bg-white/[0.04] cursor-pointer border border-transparent'
                      }`}
                    >
                      <div className="flex items-center space-x-2.5 min-w-0 flex-1 pr-2">
                        <Avatar
                          name={displayName}
                          phone={contact.phone || undefined}
                          size="sm"
                          shape="circle"
                          className="w-7 h-7 text-[10px] shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                            {displayName}
                          </p>
                          {contact.phone && contact.name && (
                            <p className="text-[10px] text-slate-400 font-mono truncate">
                              {formatPhoneNumber(contact.phone)}
                            </p>
                          )}
                        </div>
                      </div>

                      {isAlreadyIn ? (
                        <span className="text-[10px] font-medium text-slate-400 bg-slate-200/60 dark:bg-white/10 px-2 py-0.5 rounded-md">
                          {t('whatsapp.alreadyInGroup')}
                        </span>
                      ) : (
                        <div
                          className={`w-4 h-4 rounded-md border flex items-center justify-center transition-colors ${
                            isSelected
                              ? 'bg-[#7367F0] border-[#7367F0] text-white'
                              : 'border-slate-300 dark:border-white/20'
                          }`}
                        >
                          {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {selectedJids.size > 0 && (
              <p className="text-xs font-bold text-[#7367F0]">
                {t('whatsapp.selectedParticipantsCount', { count: String(selectedJids.size) })}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1.5">
                {t('whatsapp.enterPhoneToAdd')}
              </label>
              <input
                type="tel"
                value={manualPhone}
                onChange={(e) => setManualPhone(e.target.value)}
                placeholder={t('whatsapp.phonePlaceholder')}
                className="w-full px-3.5 py-2.5 text-xs font-mono rounded-xl border border-slate-200/80 dark:border-white/10 bg-slate-50/70 dark:bg-[#111b21] text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-[#7367F0]"
                autoFocus
              />
              <p className="text-[10px] text-slate-400 mt-1">
                {t('whatsapp.addParticipantDesc')}
              </p>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="pt-2 flex items-center justify-end space-x-2 border-t border-slate-100 dark:border-white/[0.06]">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={submitting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleAddParticipants}

            disabled={submitting || (activeTab === 'contacts' ? selectedJids.size === 0 : !manualPhone.trim())}
            className="bg-[#00a884] hover:bg-[#009272] text-white"
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
            ) : (
              <UserPlus className="w-3.5 h-3.5 mr-1.5" />
            )}
            <span>
              {activeTab === 'contacts' && selectedJids.size > 0
                ? t('whatsapp.addSelectedParticipantsBtn')
                : t('whatsapp.addParticipant')}
            </span>
          </Button>
        </div>
      </div>
    </Modal>
  );
};
