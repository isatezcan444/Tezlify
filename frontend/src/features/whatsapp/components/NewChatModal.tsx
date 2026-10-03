import React, { useState, useEffect, useMemo } from 'react';
import {
  MessageSquarePlus,
  Send,
  Loader2,
  Phone,
  User,
  MessageSquare,
  Users,
  Search,
  Smartphone,
  Check,
  X,
} from 'lucide-react';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/button';
import { TextInput } from '../../../components/forms/TextInput';
import { Avatar } from '../../../components/ui/Avatar';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { WhatsAppRepository } from '../data/whatsappRepository';
import { ConversationDetail, WhatsAppSession } from '../../../types';
import { translateApiError } from '../lib/translateError';

export interface NewChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (conv: ConversationDetail) => void;
  sessions?: WhatsAppSession[];
}

const isSavedContact = (c: any): boolean => {
  if (!c) return false;
  const name = (c.name || '').trim();
  const phone = (c.phone || '').trim();
  if (!name) return false;
  if (name === phone) return false;
  if (name.startsWith('+')) return false;
  if (
    name.startsWith('jid:') ||
    name.includes('@lid') ||
    name.includes('@g.us') ||
    name.includes('@s.whatsapp.net') ||
    name.includes('@c.us')
  ) {
    return false;
  }
  const letters = name.replace(/[\s\d+().\-_/]/g, '');
  return letters.length > 0;
};

export const NewChatModal: React.FC<NewChatModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  sessions = [],
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const connectedSessions = useMemo(() => {
    return (sessions || []).filter((s) => s.status === 'CONNECTED');
  }, [sessions]);

  const [activeTab, setActiveTab] = useState<'contacts' | 'manual'>('contacts');
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);

  // Contacts Tab State
  const [contacts, setContacts] = useState<any[]>([]);
  const [loadingContacts, setLoadingContacts] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedContact, setSelectedContact] = useState<any | null>(null);

  // Manual Tab State
  const [manualPhone, setManualPhone] = useState<string>('');
  const [manualName, setManualName] = useState<string>('');

  // Common Message State
  const [message, setMessage] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Initialize selected session when modal opens or connected sessions change
  useEffect(() => {
    if (isOpen) {
      if (connectedSessions.length > 0) {
        if (!selectedSessionId || !connectedSessions.some((s) => s.id === selectedSessionId)) {
          setSelectedSessionId(connectedSessions[0].id);
        }
      } else {
        setSelectedSessionId(null);
      }
    }
  }, [isOpen, connectedSessions, selectedSessionId]);

  // Fetch contacts for current selected session
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoadingContacts(true);
    WhatsAppRepository.getWhatsAppContacts(selectedSessionId || undefined)
      .then((data) => {
        if (!cancelled) {
          const list = Array.isArray(data) ? data : [];
          setContacts(list.filter(isSavedContact));
        }
      })
      .catch((err) => {
        console.warn('[NewChatModal] Failed to load contacts:', err);
        if (!cancelled) setContacts([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingContacts(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, selectedSessionId]);

  // Reset local state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSelectedContact(null);
      setManualPhone('');
      setManualName('');
      setMessage('');
      setSubmitting(false);
    }
  }, [isOpen]);

  const filteredContacts = useMemo(() => {
    const valid = (contacts || []).filter(isSavedContact);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return valid;
    return valid.filter((c) => {
      const name = (c.name || '').toLowerCase();
      const phone = (c.phone || '').toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [contacts, searchQuery]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let targetPhone = '';
    let targetName: string | undefined = undefined;

    if (activeTab === 'contacts') {
      if (!selectedContact) {
        toast.error(t('whatsapp.selectContactPrompt'));
        return;
      }
      targetPhone = (selectedContact.phone || '').trim();
      targetName = selectedContact.name || undefined;
    } else {
      targetPhone = manualPhone.trim();
      targetName = manualName.trim() || undefined;
      if (!targetPhone) {
        toast.error(t('whatsapp.phoneRequired'));
        return;
      }
    }

    if (!targetPhone) {
      toast.error(t('whatsapp.phoneRequired'));
      return;
    }

    setSubmitting(true);
    try {
      const conv = await WhatsAppRepository.startConversation({
        phone: targetPhone,
        name: targetName,
        message: message.trim() || undefined,
        sessionId: selectedSessionId || undefined,
      });

      const newConv: ConversationDetail = { ...conv, messages: [] };
      toast.success(t('whatsapp.chatStarted'));
      onClose();
      onSuccess(newConv);
    } catch (err: any) {
      console.error('[NewChatModal] Failed to start conversation:', err);
      toast.error(translateApiError(err, t) || t('whatsapp.chatStartFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('whatsapp.newChatModalTitle')}
      subtitle={t('whatsapp.newChatModalSubtitle')}
      icon={MessageSquarePlus}
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Device/Session Switcher (Tab System matching WhatsAppQrConnectModal) */}
        {connectedSessions.length > 1 && (
          <div>
            <label className="block text-[11px] font-bold text-slate-500 dark:text-slate-400 mb-1 flex items-center gap-1.5">
              <Smartphone className="w-3.5 h-3.5 text-[#7367F0]" />
              <span>{t('whatsapp.deviceLineLabel')}</span>
            </label>
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-white/[0.06] overflow-x-auto" role="tablist">
              {connectedSessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setSelectedSessionId(s.id);
                    setSelectedContact(null);
                  }}
                  className={`flex-1 min-w-[120px] flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg text-[11px] font-bold transition-all cursor-pointer truncate ${
                    selectedSessionId === s.id
                      ? 'bg-white dark:bg-[#2F3349] text-[#7367F0] shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                  }`}
                >
                  <Smartphone className="w-3 h-3 shrink-0" />
                  <span className="truncate">{s.session_name || s.phone_number || `Hat #${s.id}`}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Tab Switcher: Rehberden Seç | Numara ile Başlat */}
        <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-white/[0.06]" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'contacts'}
            onClick={() => setActiveTab('contacts')}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'contacts'
                ? 'bg-white dark:bg-[#2F3349] text-[#7367F0] shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>{t('whatsapp.tabFromContacts')}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'manual'}
            onClick={() => setActiveTab('manual')}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'manual'
                ? 'bg-white dark:bg-[#2F3349] text-[#28C76F] shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
          >
            <Phone className="w-3.5 h-3.5" />
            <span>{t('whatsapp.tabManualNumber')}</span>
          </button>
        </div>

        {/* TAB 1: Rehberden Seç */}
        {activeTab === 'contacts' && (
          <div className="space-y-3">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('whatsapp.searchContactsPlaceholder')}
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.04] text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#7367F0]/40 transition-all"
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

            {/* Selected Contact Banner */}
            {selectedContact && (
              <div className="p-2.5 rounded-xl bg-[#7367F0]/10 border border-[#7367F0]/30 flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar
                    name={selectedContact.name}
                    image={selectedContact.avatar_url}
                    phone={selectedContact.phone}
                    size="sm"
                    shape="rounded"
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-900 dark:text-white truncate">
                      {selectedContact.name}
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate">
                      {selectedContact.phone}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedContact(null)}
                  className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-white/20 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Contacts List */}
            <div className="border border-slate-200 dark:border-white/[0.08] rounded-xl overflow-hidden">
              {loadingContacts ? (
                <div className="p-8 text-center text-xs text-slate-400 flex flex-col items-center justify-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin text-[#7367F0]" />
                  <span>{t('whatsapp.loadingContacts')}</span>
                </div>
              ) : filteredContacts.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400 dark:text-slate-500">
                  <Users className="w-7 h-7 mx-auto mb-1.5 opacity-30" />
                  <p>
                    {contacts.length === 0
                      ? t('whatsapp.noSavedContactsFound')
                      : t('whatsapp.noContactsFound')}
                  </p>
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 dark:divide-white/[0.04]">
                  {filteredContacts.map((c) => {
                    const isSelected = selectedContact?.id === c.id || selectedContact?.phone === c.phone;
                    return (
                      <button
                        key={c.id || c.phone}
                        type="button"
                        onClick={() => setSelectedContact(c)}
                        className={`w-full text-left p-2.5 flex items-center justify-between transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-[#7367F0]/15 dark:bg-[#7367F0]/20'
                            : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Avatar
                            name={c.name}
                            image={c.avatar_url}
                            phone={c.phone}
                            size="sm"
                            shape="rounded"
                          />
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate">
                              {c.name}
                            </p>
                            <p className="text-[11px] text-slate-400 font-mono truncate">
                              {c.phone}
                            </p>
                          </div>
                        </div>
                        {isSelected && (
                          <div className="w-5 h-5 rounded-full bg-[#7367F0] flex items-center justify-center text-white shrink-0 ml-2">
                            <Check className="w-3 h-3 stroke-[3]" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: Numara ile Başlat */}
        {activeTab === 'manual' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
                <Phone className="w-3.5 h-3.5 text-[#25D366]" />
                <span>{t('whatsapp.phoneLabel')}</span>
                <span className="text-red-500">*</span>
              </label>
              <TextInput
                type="tel"
                value={manualPhone}
                onChange={(e) => setManualPhone(e.target.value)}
                placeholder={t('whatsapp.phonePlaceholder')}
                required={activeTab === 'manual'}
                autoFocus
                className="font-mono text-sm"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                {t('whatsapp.phoneHint')}
              </p>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-[#7367F0]" />
                <span>{t('whatsapp.contactNameLabel')}</span>
              </label>
              <TextInput
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder={t('whatsapp.contactNamePlaceholder')}
              />
            </div>
          </div>
        )}

        {/* Common: Initial Message */}
        <div>
          <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5 text-[#28C76F]" />
            <span>{t('whatsapp.initialMessageLabel')}</span>
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('whatsapp.initialMessagePlaceholder')}
            rows={2}
            className="w-full rounded-xl border border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.04] p-3 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#7367F0]/40 transition-all resize-none"
          />
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100 dark:border-white/[0.08]">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={submitting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={
              submitting ||
              (activeTab === 'contacts' && !selectedContact) ||
              (activeTab === 'manual' && !manualPhone.trim())
            }
            className="space-x-1.5 bg-[#25D366] hover:bg-[#20ba59] text-white font-bold cursor-pointer"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            <span>{t('whatsapp.startChatBtn')}</span>
          </Button>
        </div>
      </form>
    </Modal>
  );
};
