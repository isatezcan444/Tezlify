import React, { useState, useEffect, useCallback } from 'react';
import {
  Sparkles,
  RefreshCw,
  Maximize2,
  X,
  TrendingUp,
  Briefcase,
  PhoneCall,
  Loader2,
  Check,
} from 'lucide-react';
import { WhatsAppApi } from '../api/whatsappApi';
import { AiSuggestReplyResponse } from '../../../types';
import { Tooltip } from '../../../components/ui/Tooltip';
import { useI18n } from '../../../context/I18nContext';

export interface AiSmartReplyBarProps {
  conversationId: number;
  onSelectSuggestion: (text: string) => void;
  onOpenFullModal: () => void;
  isVisible: boolean;
  onToggleVisible: () => void;
}

export const AiSmartReplyBar: React.FC<AiSmartReplyBarProps> = ({
  conversationId,
  onSelectSuggestion,
  onOpenFullModal,
  isVisible,
  onToggleVisible,
}) => {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AiSuggestReplyResponse | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);

  const fetchSuggestions = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    try {
      const res = await WhatsAppApi.getAiSuggestedReplies(conversationId);
      setData(res);
    } catch {
      // Fail closed gracefully without alerting or throwing
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (conversationId) {
      fetchSuggestions();
    } else {
      setData(null);
    }
  }, [conversationId, fetchSuggestions]);

  if (!conversationId || !isVisible || (!loading && (!data?.suggestions || data.suggestions.length === 0))) {
    return null;
  }

  const handleApply = (id: string, text: string) => {
    setAppliedId(id);
    onSelectSuggestion(text);
    setTimeout(() => setAppliedId(null), 1200);
  };

  const getToneIcon = (tone: string) => {
    switch (tone) {
      case 'PERSUASIVE':
        return <TrendingUp className="w-3 h-3 text-[#7367F0] shrink-0" />;
      case 'CALL_TO_ACTION':
        return <PhoneCall className="w-3 h-3 text-[#28C76F] shrink-0" />;
      case 'PROFESSIONAL':
      default:
        return <Briefcase className="w-3 h-3 text-blue-500 shrink-0" />;
    }
  };

  return (
    <div className="mb-2 rounded-xl border border-[#7367F0]/20 dark:border-white/[0.08] bg-white/90 dark:bg-[#2F3349]/90 backdrop-blur-md shadow-xs p-2 transition-all animate-in fade-in slide-in-from-bottom-2 duration-150">
      <div className="flex items-center justify-between gap-2">
        {/* Left: AI Intent Badge */}
        <div className="flex items-center space-x-1.5 shrink-0 min-w-0">
          <div className="w-5 h-5 rounded-md bg-gradient-to-tr from-[#7367F0] to-[#9E95F5] flex items-center justify-center text-white shrink-0">
            <Sparkles className="w-3 h-3" />
          </div>
          <span className="text-[11px] font-extrabold text-[#7367F0] dark:text-[#A59DF8] truncate max-w-[120px] sm:max-w-[160px]">
            {data?.intent_label || t('whatsapp.aiSmartBarTitle')}
          </span>
          {loading && <Loader2 className="w-3 h-3 animate-spin text-[#7367F0] shrink-0" />}
        </div>

        {/* Center: Suggestion Chips (horizontal scrollable) */}
        {!loading && data?.suggestions && (
          <div className="flex-1 flex items-center gap-1.5 overflow-x-auto scrollbar-none [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden min-w-0 px-1">
            {data.suggestions.map((sug) => {
              const isApplied = appliedId === sug.id;
              return (
                <Tooltip key={sug.id} content={sug.text}>
                  <button
                    type="button"
                    onClick={() => handleApply(sug.id, sug.text)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all active:scale-95 cursor-pointer shrink-0 border ${
                      isApplied
                        ? 'bg-[#28C76F]/15 border-[#28C76F]/40 text-[#28C76F]'
                        : 'bg-slate-100/80 hover:bg-[#7367F0]/10 hover:border-[#7367F0]/30 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] border-slate-200/60 dark:border-white/[0.06] text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    {isApplied ? (
                      <Check className="w-3 h-3 text-[#28C76F] shrink-0" />
                    ) : (
                      getToneIcon(sug.tone)
                    )}
                    <span className="font-bold text-[11px] truncate max-w-[90px] sm:max-w-[120px]">
                      {sug.title}
                    </span>
                    <span className="text-slate-400 dark:text-slate-500 text-[10px] hidden md:inline truncate max-w-[140px]">
                      {sug.text.slice(0, 30)}...
                    </span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        )}

        {/* Right Action Icons: Refresh, Full Modal, Minimize */}
        <div className="flex items-center space-x-1 shrink-0">
          <Tooltip content={t('common.refresh')}>
            <button
              type="button"
              onClick={fetchSuggestions}
              disabled={loading}
              aria-label={t('common.refresh')}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </Tooltip>

          <Tooltip content={t('whatsapp.aiExpandDetails')}>
            <button
              type="button"
              onClick={onOpenFullModal}
              aria-label={t('whatsapp.aiExpandDetails')}
              className="p-1 rounded-lg text-slate-400 hover:text-[#7367F0] hover:bg-[#7367F0]/10 transition-colors cursor-pointer"
            >
              <Maximize2 className="w-3 h-3" />
            </button>
          </Tooltip>

          <Tooltip content={t('whatsapp.aiHideBar')}>
            <button
              type="button"
              onClick={onToggleVisible}
              aria-label={t('whatsapp.aiHideBar')}
              className="p-1 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};
