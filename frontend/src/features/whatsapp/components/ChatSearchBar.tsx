import React, { useEffect, useRef } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

export interface ChatSearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  totalMatches: number;
  currentMatchIndex: number;
  onNextMatch: () => void;
  onPrevMatch: () => void;
  onClose: () => void;
}

export const ChatSearchBar: React.FC<ChatSearchBarProps> = ({
  query,
  onQueryChange,
  totalMatches,
  currentMatchIndex,
  onNextMatch,
  onPrevMatch,
  onClose,
}) => {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onPrevMatch();
      } else {
        onNextMatch();
      }
    }
  };

  const hasMatches = totalMatches > 0;
  const isQueryActive = query.trim().length > 0;

  return (
    <div
      role="search"
      aria-label={t('whatsapp.searchInChat')}
      className="shrink-0 px-3 py-2 bg-white/95 dark:bg-[#1f2c34]/95 backdrop-blur-md border-b border-slate-200/80 dark:border-white/[0.08] shadow-sm flex items-center gap-2 z-20 animate-in slide-in-from-top-2 duration-150"
    >
      <div className="relative flex-1 flex items-center min-w-0">
        <Search className="absolute left-3 w-4 h-4 text-slate-400 dark:text-[#8696a0] pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('whatsapp.searchInChat')}
          aria-label={t('whatsapp.searchInChat')}
          className="w-full pl-9 pr-8 py-1.5 text-xs rounded-lg bg-slate-100 dark:bg-[#111b21] text-slate-800 dark:text-[#e9edef] placeholder-slate-400 dark:placeholder-[#8696a0] border border-transparent focus:border-[#00a884] dark:focus:border-[#00a884] focus:outline-none transition-colors"
        />
        {isQueryActive && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            className="absolute right-2 p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer"
            aria-label={t('common.clear')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {isQueryActive && (
        <div className="flex items-center gap-1.5 shrink-0 text-xs select-none">
          <span className="text-[11px] font-semibold text-slate-500 dark:text-[#8696a0] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/[0.06]">
            {hasMatches
              ? t('whatsapp.searchMatches', {
                  current: String(currentMatchIndex + 1),
                  total: String(totalMatches),
                })
              : t('whatsapp.noSearchMatches')}
          </span>

          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={onPrevMatch}
              disabled={!hasMatches}
              title={t('whatsapp.searchPrev')}
              aria-label={t('whatsapp.searchPrev')}
              className="p-1 rounded-md text-slate-500 dark:text-[#8696a0] hover:text-slate-800 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.08] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onNextMatch}
              disabled={!hasMatches}
              title={t('whatsapp.searchNext')}
              aria-label={t('whatsapp.searchNext')}
              className="p-1 rounded-md text-slate-500 dark:text-[#8696a0] hover:text-slate-800 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.08] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onClose}
        title={t('whatsapp.closeSearch')}
        aria-label={t('whatsapp.closeSearch')}
        className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 dark:text-[#8696a0] dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors cursor-pointer shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};
