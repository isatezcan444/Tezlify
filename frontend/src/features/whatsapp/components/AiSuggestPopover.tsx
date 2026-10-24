import React, { useState, useEffect, useCallback } from 'react';
import {
  Sparkles,
  X,
  RefreshCw,
  Check,
  Zap,
  MessageSquare,
  ArrowRight,
  TrendingUp,
  Briefcase,
  PhoneCall,
  Loader2,
} from 'lucide-react';
import { WhatsAppApi } from '../api/whatsappApi';
import { AiSuggestReplyResponse, AiSuggestionItem, AiMatchedQuickReply } from '../../../types';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { useI18n } from '../../../context/I18nContext';

export interface AiSuggestPopoverProps {
  conversationId: number;
  isOpen: boolean;
  onClose: () => void;
  onSelectSuggestion: (text: string) => void;
}

export const AiSuggestPopover: React.FC<AiSuggestPopoverProps> = ({
  conversationId,
  isOpen,
  onClose,
  onSelectSuggestion,
}) => {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AiSuggestReplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);

  const fetchSuggestions = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await WhatsAppApi.getAiSuggestedReplies(conversationId);
      setData(res);
    } catch (err: any) {
      setError(err.message || t('whatsapp.aiErrorFetching'));
    } finally {
      setLoading(false);
    }
  }, [conversationId, t]);

  useEffect(() => {
    if (isOpen) {
      fetchSuggestions();
    } else {
      setData(null);
      setError(null);
      setAppliedId(null);
    }
  }, [isOpen, fetchSuggestions]);

  if (!isOpen) return null;

  const handleApply = (id: string, text: string) => {
    setAppliedId(id);
    onSelectSuggestion(text);
    setTimeout(() => {
      onClose();
    }, 200);
  };

  const getToneBadge = (tone: string) => {
    switch (tone) {
      case 'PERSUASIVE':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#7367F0]/10 text-[#7367F0] border border-[#7367F0]/20">
            <TrendingUp className="w-2.5 h-2.5" />
            <span>{t('whatsapp.tonePersuasive')}</span>
          </span>
        );
      case 'CALL_TO_ACTION':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#28C76F]/10 text-[#28C76F] border border-[#28C76F]/20">
            <PhoneCall className="w-2.5 h-2.5" />
            <span>{t('whatsapp.toneCta')}</span>
          </span>
        );
      case 'PROFESSIONAL':
      default:
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <Briefcase className="w-2.5 h-2.5" />
            <span>{t('whatsapp.toneProfessional')}</span>
          </span>
        );
    }
  };

  return (
    <div
      role="dialog"
      aria-labelledby="ai-copilot-title"
      className="absolute bottom-full left-0 right-0 mb-2 z-40 bg-white/95 dark:bg-[#2F3349]/95 backdrop-blur-md rounded-2xl border border-slate-200/80 dark:border-white/[0.08] shadow-2xl p-4 sm:p-5 max-h-[460px] overflow-y-auto space-y-4 animate-in fade-in slide-in-from-bottom-3 duration-200"
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-200/70 dark:border-white/[0.08]">
        <div className="flex items-center space-x-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-[#7367F0] to-[#9E95F5] flex items-center justify-center text-white shrink-0 shadow-xs">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <h4 id="ai-copilot-title" className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white leading-tight truncate">
              {t('whatsapp.aiCoPilotTitle')}
            </h4>
            {data?.intent_label && (
              <p className="text-[11px] font-semibold text-[#7367F0] truncate">
                {t('whatsapp.aiDetectedIntent')}: {data.intent_label}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center space-x-1.5 shrink-0">
          <button
            type="button"
            onClick={fetchSuggestions}
            disabled={loading}
            aria-label={t('common.refresh')}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
            title={t('common.refresh')}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
            title={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body States */}
      {loading ? (
        <div className="py-8 flex flex-col items-center justify-center space-y-2.5 text-center">
          <Loader2 className="w-6 h-6 animate-spin text-[#7367F0]" />
          <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
            {t('whatsapp.aiAnalyzingConversation')}
          </p>
          <p className="text-[11px] text-slate-400">
            {t('whatsapp.aiGeneratingPersonalizedReplies')}
          </p>
        </div>
      ) : error ? (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 text-xs flex items-center justify-between">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={fetchSuggestions} className="text-xs font-bold ml-2">
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div className="space-y-3.5">
          {/* Latest customer query quote */}
          {data?.latest_customer_message && (
            <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-white/[0.03] border-l-3 border-[#7367F0] text-xs">
              <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 block uppercase">
                {data.contact_name ? `${data.contact_name}:` : t('whatsapp.lastIncomingMessage')}
              </span>
              <p className="text-slate-700 dark:text-slate-200 italic font-medium truncate mt-0.5">
                "{data.latest_customer_message}"
              </p>
            </div>
          )}

          {/* 3 Suggestion Cards */}
          <div className="space-y-2.5">
            {data?.suggestions.map((sug) => {
              const isApplied = appliedId === sug.id;
              return (
                <div
                  key={sug.id}
                  onClick={() => handleApply(sug.id, sug.text)}
                  className={`group p-3 rounded-xl border transition-all cursor-pointer text-left ${
                    isApplied
                      ? 'bg-[#28C76F]/10 border-[#28C76F] shadow-sm'
                      : 'bg-slate-50/70 dark:bg-white/[0.02] border-slate-200/70 dark:border-white/[0.06] hover:border-[#7367F0] hover:bg-[#7367F0]/[0.03] hover:shadow-sm'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-extrabold text-slate-800 dark:text-white group-hover:text-[#7367F0] transition-colors">
                        {sug.title}
                      </span>
                      {getToneBadge(sug.tone)}
                    </div>
                    <div className="flex items-center space-x-1 text-[11px] font-bold text-[#7367F0] opacity-0 group-hover:opacity-100 transition-opacity">
                      <span>{t('whatsapp.useReply')}</span>
                      <ArrowRight className="w-3 h-3" />
                    </div>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-normal">
                    {sug.text}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Matched Quick Replies if any */}
          {data?.matching_quick_replies && data.matching_quick_replies.length > 0 && (
            <div className="pt-2 border-t border-slate-200/60 dark:border-white/[0.06] space-y-2">
              <label className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase flex items-center gap-1.5">
                <Zap className="w-3 h-3 text-amber-500" />
                <span>{t('whatsapp.matchedQuickReplies')}</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {data.matching_quick_replies.map((qr) => (
                  <button
                    key={qr.id}
                    type="button"
                    onClick={() => handleApply(`qr_${qr.id}`, qr.content)}
                    className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-white/[0.04] hover:bg-[#7367F0]/10 hover:border-[#7367F0]/30 border border-slate-200/80 dark:border-white/[0.08] text-xs font-semibold text-slate-700 dark:text-slate-300 transition-all cursor-pointer"
                  >
                    <span className="font-mono text-[11px] text-[#7367F0] font-bold">{qr.shortcut}</span>
                    <span className="text-[11px] text-slate-400">•</span>
                    <span className="text-[11px] truncate max-w-[140px]">{qr.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer hint */}
      <div className="pt-2 border-t border-slate-200/60 dark:border-white/[0.06] flex items-center justify-between text-[11px] text-slate-400 dark:text-slate-500">
        <span>💡 {t('whatsapp.aiCoPilotHint')}</span>
      </div>
    </div>
  );
};
