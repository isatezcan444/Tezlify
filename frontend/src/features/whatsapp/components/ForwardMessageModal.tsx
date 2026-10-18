import React, { useState, useMemo } from 'react';
import {
  Forward,
  Search,
  Check,
  Loader2,
  X,
  FileText,
  Image as ImageIcon,
  Mic,
  Video as VideoIcon,
  Users,
} from 'lucide-react';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/button';
import { Avatar } from '../../../components/ui/Avatar';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { WhatsAppApi } from '../api/whatsappApi';
import { formatPhoneNumber } from '../lib/whatsappIdentity';
import { Conversation, Message } from '../../../types';

export interface ForwardMessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  message: Message | null;
  currentConversationId: number;
  conversations: Conversation[];
  onForwardSuccess?: (targetConversationIds: number[]) => void;
}

const MAX_FORWARD_TARGETS = 5;

export const ForwardMessageModal: React.FC<ForwardMessageModalProps> = ({
  isOpen,
  onClose,
  message,
  currentConversationId,
  conversations,
  onForwardSuccess,
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // Reset selection and query when opening/closing
  React.useEffect(() => {
    if (isOpen) {
      setSelectedIds(new Set());
      setSearchQuery('');
    }
  }, [isOpen]);

  // Filter conversations
  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return conversations.filter((conv) => {
      // Exclude current conversation or keep it optionally, but WhatsApp Web excludes current chat or allows sending to it
      if (conv.id === currentConversationId) return false;
      if (!q) return true;
      const name = (conv.lead_name || '').toLowerCase();
      const phone = (conv.lead_phone || '').toLowerCase();
      const preview = (conv.last_message_preview || '').toLowerCase();
      return name.includes(q) || phone.includes(q) || preview.includes(q);
    });
  }, [conversations, currentConversationId, searchQuery]);

  const toggleSelect = (convId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(convId)) {
        next.delete(convId);
      } else {
        if (next.size >= MAX_FORWARD_TARGETS) {
          toast.warning(t('whatsapp.maxForwardLimitReached', { max: String(MAX_FORWARD_TARGETS) }));
          return prev;
        }
        next.add(convId);
      }
      return next;
    });
  };

  const handleForward = async () => {
    if (!message || selectedIds.size === 0) return;
    setSubmitting(true);
    try {
      const targetIds = Array.from(selectedIds);
      const res = await WhatsAppApi.forwardMessage(currentConversationId, message.id, targetIds);
      toast.success(t('whatsapp.forwardSuccess', { count: String(res.forwarded_count || targetIds.length) }));
      onForwardSuccess?.(targetIds);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || t('whatsapp.forwardError'));
    } finally {
      setSubmitting(false);
    }
  };

  const renderMessagePreview = () => {
    if (!message) return null;
    const isMedia = message.message_type !== 'TEXT';

    return (
      <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#111b21] border border-slate-200/80 dark:border-white/[0.08] mb-3 select-none flex items-start space-x-3">
        <div className="w-8 h-8 rounded-lg bg-[#00a884]/10 dark:bg-[#00a884]/20 text-[#00a884] dark:text-[#25D366] flex items-center justify-center shrink-0 mt-0.5">
          {message.message_type === 'IMAGE' && <ImageIcon className="w-4 h-4" />}
          {message.message_type === 'VIDEO' && <VideoIcon className="w-4 h-4" />}
          {message.message_type === 'AUDIO' && <Mic className="w-4 h-4" />}
          {message.message_type === 'DOCUMENT' && <FileText className="w-4 h-4" />}
          {message.message_type === 'TEXT' && <Forward className="w-4 h-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            <span>{t('whatsapp.forwardMessagePreview')}</span>
            {isMedia && (
              <span className="px-1.5 py-0.2 rounded text-[10px] bg-slate-200/60 dark:bg-white/10 font-bold uppercase tracking-wider">
                {message.message_type}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-700 dark:text-slate-200 truncate mt-0.5">
            {message.body || message.media_caption || message.media_filename || (isMedia ? t('whatsapp.mediaMessage') : '')}
          </p>
        </div>
      </div>
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('whatsapp.forwardMessage')}
      subtitle={t('whatsapp.forwardSubtitle', { max: String(MAX_FORWARD_TARGETS) })}
      icon={Forward}
      variant="primary"
      maxWidth="md"
    >
      <div className="space-y-3">
        {/* Message preview snippet */}
        {renderMessagePreview()}

        {/* Search Bar */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('whatsapp.searchChats')}
            className="w-full pl-9 pr-8 py-2 text-xs rounded-xl bg-slate-100/70 dark:bg-[#111b21] border border-slate-200/80 dark:border-white/10 text-slate-800 dark:text-[#e9edef] focus:outline-none focus:ring-1 focus:ring-[#7367F0]"
            autoFocus
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-0.5 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Selected count badge */}
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 px-0.5">
          <span>{t('whatsapp.chatsSelected', { count: String(selectedIds.size), max: String(MAX_FORWARD_TARGETS) })}</span>
          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-[11px] text-[#7367F0] hover:underline cursor-pointer"
            >
              {t('common.clear')}
            </button>
          )}
        </div>

        {/* Conversations List */}
        <div className="max-h-64 overflow-y-auto custom-scrollbar divide-y divide-slate-100 dark:divide-white/[0.04] rounded-xl border border-slate-200/70 dark:border-white/[0.08] bg-white dark:bg-[#1c272e]">
          {filteredConversations.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              {t('whatsapp.noParticipantsFound')}
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const isSelected = selectedIds.has(conv.id);
              const name = conv.lead_name || (conv.lead_phone ? formatPhoneNumber(conv.lead_phone) : t('whatsapp.unnamedChat'));
              const phone = conv.lead_phone && conv.lead_name ? formatPhoneNumber(conv.lead_phone) : null;

              return (
                <div
                  key={conv.id}
                  data-testid={`forward-target-conv-${conv.id}`}
                  onClick={() => toggleSelect(conv.id)}
                  className={`flex items-center justify-between p-2.5 transition-colors cursor-pointer select-none ${
                    isSelected
                      ? 'bg-[#7367F0]/10 dark:bg-[#7367F0]/20'
                      : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <Avatar
                      name={name}
                      phone={conv.lead_phone}
                      size="sm"
                      shape="circle"
                      className="w-9 h-9 text-xs shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center space-x-1.5">
                        <span className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                          {name}
                        </span>
                        {conv.is_group && (
                          <span className="px-1.5 py-0.5 rounded text-[9.5px] font-bold bg-[#7367F0]/10 text-[#7367F0] border border-[#7367F0]/20 shrink-0 flex items-center space-x-0.5">
                            <Users className="w-2.5 h-2.5" />
                            <span>{t('whatsapp.group')}</span>
                          </span>
                        )}
                      </div>
                      {phone && (
                        <p className="text-[11px] text-slate-400 dark:text-slate-400 font-mono truncate">
                          {phone}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 ml-3">
                    <div
                      className={`w-5 h-5 rounded-md flex items-center justify-center transition-all ${
                        isSelected
                          ? 'bg-[#7367F0] text-white shadow-sm shadow-[#7367F0]/30'
                          : 'border border-slate-300 dark:border-white/20 bg-transparent'
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100 dark:border-white/[0.08]">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={submitting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={handleForward}
            disabled={submitting || selectedIds.size === 0}
            data-testid="forward-submit-btn"
            className="min-w-[90px]"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <div className="flex items-center space-x-1.5 font-bold">
                <Forward className="w-3.5 h-3.5" />
                <span>
                  {t('whatsapp.forwardActionBtn', { count: String(selectedIds.size) })}
                </span>
              </div>
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
