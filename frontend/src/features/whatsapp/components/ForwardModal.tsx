import React, { useState, useMemo } from 'react';
import {
  Send,
  Search,
  Users,
  Check,
  FileText,
  Image as ImageIcon,
  Loader2,
  Share2,
} from 'lucide-react';
import { Conversation, Message } from '../../../types';
import { Modal } from '../../../components/ui/Modal';
import { Avatar } from '../../../components/ui/Avatar';
import { useI18n } from '../../../context/I18nContext';
import { getConversationDisplayName, extractCleanPhone, formatPhoneNumber } from '../lib/whatsappIdentity';

export interface ForwardModalProps {
  isOpen: boolean;
  onClose: () => void;
  messagesToForward: Message[];
  conversations: Conversation[];
  onConfirmForward: (targetConversationIds: number[], messages: Message[]) => Promise<void> | void;
}

export const ForwardModal: React.FC<ForwardModalProps> = ({
  isOpen,
  onClose,
  messagesToForward,
  conversations,
  onConfirmForward,
}) => {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [forwarding, setForwarding] = useState(false);

  // Filter conversations matching query
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const q = searchQuery.toLowerCase().trim();
    return conversations.filter((c) => {
      const name = getConversationDisplayName(c, t).toLowerCase();
      const rawPhone = c.lead_phone || (c as any).phone || '';
      const cleanPhone = extractCleanPhone(rawPhone) || '';
      return name.includes(q) || cleanPhone.includes(q);
    });
  }, [conversations, searchQuery, t]);

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSend = async () => {
    if (selectedIds.size === 0 || messagesToForward.length === 0 || forwarding) return;
    setForwarding(true);
    try {
      await onConfirmForward(Array.from(selectedIds), messagesToForward);
      setSelectedIds(new Set());
      setSearchQuery('');
      onClose();
    } catch (err) {
      console.error('[ForwardModal] Forwarding failed:', err);
    } finally {
      setForwarding(false);
    }
  };

  const renderMessagePreview = () => {
    if (messagesToForward.length === 0) return null;
    if (messagesToForward.length === 1) {
      const msg = messagesToForward[0];
      return (
        <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-white/[0.04] border border-slate-200/80 dark:border-white/[0.06] text-xs text-slate-600 dark:text-slate-300">
          {msg.media_filename ? (
            <div className="flex items-center space-x-2 text-[#7367F0] font-semibold">
              <FileText className="w-4 h-4 shrink-0" />
              <span className="truncate">{msg.media_filename}</span>
            </div>
          ) : msg.body ? (
            <p className="line-clamp-2 italic">"{msg.body}"</p>
          ) : (
            <div className="flex items-center space-x-1.5 text-slate-400">
              <ImageIcon className="w-4 h-4" />
              <span>{t('whatsapp.mediaTab')}</span>
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="p-2.5 rounded-xl bg-[#7367F0]/10 border border-[#7367F0]/20 text-xs font-bold text-[#7367F0] flex items-center justify-between">
        <span>{t('whatsapp.forwardCount', { count: messagesToForward.length })}</span>
      </div>
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('whatsapp.forwardTo')}
      icon={Share2}
      variant="primary"
      maxWidth="md"
    >
      <div className="space-y-3" data-testid="forward-modal">
        {/* Message preview summary */}
        {renderMessagePreview()}

        {/* Search input */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('whatsapp.searchChats')}
            data-testid="forward-search-input"
            className="w-full pl-9 pr-4 py-2 text-xs rounded-xl bg-slate-100 dark:bg-white/[0.05] border border-slate-200 dark:border-white/[0.1] text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#7367F0]"
          />
        </div>

        {/* Target conversation list */}
        <div className="max-h-64 overflow-y-auto space-y-1 pr-1 custom-scrollbar" data-testid="forward-target-list">
          {filteredConversations.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              {t('whatsapp.noTargetChats')}
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const displayName = getConversationDisplayName(conv, t);
              const rawPhone = conv.lead_phone || (conv as any).phone || '';
              const cleanPhone = extractCleanPhone(rawPhone);
              const isSelected = selectedIds.has(conv.id);

              return (
                <div
                  key={conv.id}
                  onClick={() => toggleSelect(conv.id)}
                  data-testid={`forward-target-${conv.id}`}
                  className={`p-2.5 rounded-xl flex items-center justify-between cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-[#7367F0]/15 border border-[#7367F0]/30 dark:bg-[#7367F0]/25'
                      : 'hover:bg-slate-100 dark:hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  <div className="flex items-center space-x-3 min-w-0">
                    <Avatar
                      name={displayName}
                      image={conv.lead_avatar_url}
                      phone={cleanPhone}
                      size="sm"
                      shape="rounded"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center space-x-1.5">
                        {conv.is_group && (
                          <span className="shrink-0 inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#7367F0]/15 text-[#7367F0]">
                            <Users className="w-2.5 h-2.5 mr-0.5" />
                            <span>{t('whatsapp.group')}</span>
                          </span>
                        )}
                        <h5 className="font-bold text-xs text-slate-800 dark:text-slate-100 truncate">
                          {displayName}
                        </h5>
                      </div>
                      {cleanPhone && (
                        <p className="text-[10px] font-mono text-slate-400 truncate">
                          {formatPhoneNumber(cleanPhone)}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Checkbox circle indicator */}
                  <div
                    className={`w-5 h-5 rounded-full border flex items-center justify-center transition-all shrink-0 ${
                      isSelected
                        ? 'bg-[#25D366] border-[#25D366] text-white'
                        : 'border-slate-300 dark:border-white/20'
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Modal actions */}
        <div className="pt-3 border-t border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {selectedIds.size > 0 ? `${selectedIds.size} ${t('common.selected') || 'seçildi'}` : ''}
          </span>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={selectedIds.size === 0 || forwarding}
              data-testid="confirm-forward-btn"
              className="px-4 py-1.5 rounded-xl text-xs font-bold bg-[#25D366] text-white hover:bg-[#20ba59] shadow-md shadow-[#25D366]/20 transition-all cursor-pointer disabled:opacity-50 disabled:pointer-events-none flex items-center space-x-1.5"
            >
              {forwarding ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              <span>{t('whatsapp.forwardSend') || t('whatsapp.forwardMessage')}</span>
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
};
