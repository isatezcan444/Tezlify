import React, { useState, useRef, useEffect } from 'react';
import { Search, Sparkles, Check, X } from 'lucide-react';
import { SECTORS } from '../../../data/sectors';
import { ApiClient } from '../../../api/client';
import { useI18n } from '../../../context/I18nContext';

import { matchTurkishSearch } from '../../../lib/utils';

export interface SectorAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export const SectorAutocomplete: React.FC<SectorAutocompleteProps> = ({
  value,
  onChange,
  placeholder,
  disabled = false,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [availableSectors, setAvailableSectors] = useState<string[]>(SECTORS);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Use curated industry sectors from sectors.ts as the authoritative source
  useEffect(() => {
    const fetchDBCategories = async () => {
      try {
        const dbCats = await ApiClient.getLeadCategories();
        if (dbCats && dbCats.length > 0) {
          // Strictly validate: only keep short, single-line category strings without numbers or parentheses
          const cleanDBCats = dbCats.filter(
            (c) =>
              c &&
              typeof c === 'string' &&
              c.length >= 2 &&
              c.length <= 35 &&
              !/\d/.test(c) &&
              !/[\n\r\(\)\|]/.test(c) &&
              !SECTORS.includes(c)
          );
          setAvailableSectors([...SECTORS, ...cleanDBCats]);
        }
      } catch (e) {
        // Fallback to static SECTORS
        setAvailableSectors(SECTORS);
      }
    };
    fetchDBCategories();
  }, []);

  // Filter when user has typed something, or show top sectors when focused
  const filteredSectors = value.trim()
    ? availableSectors.filter((s) => matchTurkishSearch(s, value.trim()))
    : availableSectors.slice(0, 20);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && filteredSectors.length > 0) {
      setIsOpen(true);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev < filteredSectors.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : filteredSectors.length - 1));
    } else if (e.key === 'Enter') {
      if (isOpen && highlightedIndex >= 0 && highlightedIndex < filteredSectors.length) {
        e.preventDefault();
        onChange(filteredSectors[highlightedIndex]);
        setIsOpen(false);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleSelect = (sector: string) => {
    onChange(sector);
    setIsOpen(false);
  };

  return (
    <div ref={wrapperRef} className="relative z-50 w-full">
      <div className="relative flex items-center w-full">
        <div className="absolute left-3 text-slate-400 pointer-events-none flex items-center justify-center">
          <Search className="w-4 h-4" />
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setIsOpen(true);
            setHighlightedIndex(-1);
          }}
          onFocus={() => {
            setIsOpen(true);
          }}
          onClick={() => {
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || t('leadFinder.keywordPlaceholder')}
          disabled={disabled}
          className="w-full h-11 pl-10 pr-10 text-xs font-medium placeholder:font-normal placeholder:text-slate-400 dark:placeholder:text-[#7E7F96] rounded-lg vuexy-input transition-all"
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              onChange('');
              setIsOpen(false);
            }}
            className="absolute right-2.5 p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Floating Autocomplete Dropdown */}
      {isOpen && filteredSectors.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-[100] rounded-xl bg-white dark:bg-[#2F3349] border border-slate-200 dark:border-white/[0.12] shadow-2xl overflow-hidden max-h-60 overflow-y-auto animate-fade-in">
          <div className="px-3 pt-2.5 pb-1 text-[10px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider border-b border-slate-100 dark:border-white/[0.06]">
            {t('leadFinder.keywordLabel')} ({filteredSectors.length})
          </div>
          <div className="p-1.5 space-y-0.5">
            {filteredSectors.map((sector, idx) => {
              const isSelected = value.toLowerCase() === sector.toLowerCase();
              const isHighlighted = highlightedIndex === idx;
              return (
                <button
                  key={sector}
                  type="button"
                  onClick={() => handleSelect(sector)}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center justify-between transition-colors ${
                    isHighlighted || isSelected
                      ? 'bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25 dark:text-[#A59DF8] font-bold'
                      : 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <Sparkles className="w-3.5 h-3.5 text-[#7367F0] shrink-0" />
                    <span>{sector}</span>
                  </div>
                  {isSelected && <Check className="w-3.5 h-3.5 text-[#7367F0]" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
