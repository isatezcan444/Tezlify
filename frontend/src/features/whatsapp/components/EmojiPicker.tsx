import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import {
  EMOJI_BY_CATEGORY,
  EMOJI_CATEGORIES,
  EmojiCategoryId,
  EmojiEntry,
  loadRecentEmojis,
  pushRecentEmoji,
  searchEmojis,
} from '../lib/emojiData';

export interface EmojiPickerProps {
  /** Called with the chosen character. The panel stays open, like WhatsApp Web. */
  onPick: (char: string) => void;
  onClose?: () => void;
  /** Height of the scrollable grid. */
  className?: string;
}

/**
 * iOS/WhatsApp-Web style emoji panel: search on top, a grid in the middle, and
 * the category bar pinned to the bottom.
 *
 * Deliberately NOT a modal: WhatsApp Web keeps the draft field usable while the
 * panel is open, so this renders inside the composer and never steals focus.
 * Every mouse interaction on the panel is prevented from moving focus, and the
 * caller refocuses the input after `onPick`.
 */
export const EmojiPicker: React.FC<EmojiPickerProps> = ({ onPick, onClose, className }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>(() => loadRecentEmojis());
  // Opening on an empty "recently used" tab would show a first-time user a panel
  // with nothing in it, so the first visit lands on the smileys instead.
  const [activeCategory, setActiveCategory] = useState<EmojiCategoryId>(() =>
    loadRecentEmojis().length > 0 ? 'recent' : 'smileys',
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();

  const results = useMemo<EmojiEntry[]>(() => {
    if (trimmed) return searchEmojis(trimmed);
    if (activeCategory !== 'recent') return EMOJI_BY_CATEGORY[activeCategory] ?? [];
    // Recents are stored as characters; resolve them against the catalogue so
    // the grid always renders entries with the same shape as the other tabs.
    const byChar = new Map(
      Object.values(EMOJI_BY_CATEGORY).flat().map((e) => [e.char, e]),
    );
    return recents.map((c) => byChar.get(c)).filter((e): e is EmojiEntry => Boolean(e));
  }, [trimmed, activeCategory, recents]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // A new query or category must show results from the top, not wherever the
  // previous list happened to be scrolled to.
  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }, [trimmed, activeCategory]);

  const handlePick = useCallback(
    (char: string) => {
      setRecents(pushRecentEmoji(char));
      onPick(char);
    },
    [onPick],
  );

  // The tab bar hides "recent" until something has actually been used, so the
  // panel does not open on an empty tab.
  const tabs = useMemo(
    () => EMOJI_CATEGORIES.filter((c) => c.id !== 'recent' || recents.length > 0),
    [recents.length],
  );

  const sectionLabel = trimmed
    ? t('whatsapp.emojiSearchResults')
    : t(
        (EMOJI_CATEGORIES.find((c) => c.id === activeCategory) ?? EMOJI_CATEGORIES[1]).labelKey,
      );

  return (
    <div
      className={`flex w-[340px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-white/[0.1] dark:bg-[#1E2333] ${className ?? ''}`}
      // Keep the draft focused: mousedown on the panel must not move focus away
      // from the text input, otherwise typing stops mid-pick.
      onMouseDown={(e) => e.preventDefault()}
      role="dialog"
      aria-label={t('whatsapp.emojiPickerTitle')}
    >
      <div className="flex items-center gap-2 border-b border-slate-200/80 px-3 py-2 dark:border-white/[0.08]">
        <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('whatsapp.emojiSearchPlaceholder')}
          aria-label={t('whatsapp.emojiSearchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-xs font-medium text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-200"
        />
        {query ? (
          <button
            type="button"
            aria-label={t('common.clear')}
            onClick={() => {
              setQuery('');
              searchRef.current?.focus();
            }}
            className="shrink-0 rounded-lg p-1 text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/[0.08]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="px-3 pt-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {sectionLabel}
      </div>

      <div
        ref={gridRef}
        className="h-[240px] overflow-y-auto px-2 py-2"
        data-testid="emoji-grid"
      >
        {results.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] font-medium text-slate-400 dark:text-slate-500">
            {activeCategory === 'recent' && !trimmed
              ? t('whatsapp.emojiNoRecent')
              : t('whatsapp.emojiNoResults')}
          </p>
        ) : (
          <div className="grid grid-cols-8 gap-0.5">
            {results.map((entry) => (
              <button
                key={entry.char}
                type="button"
                // The catalogue name is what a screen reader announces; the
                // glyph alone is a single unpronounceable codepoint.
                aria-label={entry.keywords.split(' ').slice(0, 3).join(' ')}
                title={entry.keywords}
                onClick={() => handlePick(entry.char)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-xl leading-none transition-transform hover:scale-110 hover:bg-slate-100 dark:hover:bg-white/[0.08]"
              >
                {entry.char}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-slate-200/80 px-1 py-1 dark:border-white/[0.08]">
        {tabs.map((cat) => (
          <button
            key={cat.id}
            type="button"
            aria-label={t(cat.labelKey)}
            aria-pressed={!trimmed && activeCategory === cat.id}
            title={t(cat.labelKey)}
            onClick={() => {
              setQuery('');
              setActiveCategory(cat.id);
            }}
            className={`flex h-8 w-8 items-center justify-center rounded-lg text-base transition-all ${
              !trimmed && activeCategory === cat.id
                ? 'bg-[#7367F0]/12 ring-1 ring-[#7367F0]/30'
                : 'opacity-60 hover:bg-slate-100 hover:opacity-100 dark:hover:bg-white/[0.08]'
            }`}
          >
            {cat.icon}
          </button>
        ))}
      </div>
    </div>
  );
};
