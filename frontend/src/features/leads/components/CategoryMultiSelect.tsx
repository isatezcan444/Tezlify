import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Layers, Check, X, Search, ChevronDown, Sparkles } from 'lucide-react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { SECTORS } from '../../../data/sectors';
import { ApiClient } from '../../../api/client';
import { useI18n } from '../../../context/I18nContext';

interface CategoryMultiSelectProps {
  selectedCategories: string[];
  onChange: (categories: string[]) => void;
  disabled?: boolean;
}

export const CategoryMultiSelect: React.FC<CategoryMultiSelectProps> = ({
  selectedCategories,
  onChange,
  disabled = false,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [localCategories, setLocalCategories] = useState<string[]>(selectedCategories || []);
  const [availableCategories, setAvailableCategories] = useState<string[]>(SECTORS);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Fetch distinct categories from database to combine with sector presets
    const fetchDBCategories = async () => {
      try {
        const dbCats = await ApiClient.getLeadCategories();
        if (dbCats && dbCats.length > 0) {
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
          setAvailableCategories([...SECTORS, ...cleanDBCats]);
        }
      } catch (e) {
        // Fallback to static SECTORS
        setAvailableCategories(SECTORS);
      }
    };
    fetchDBCategories();
  }, []);

  useEffect(() => {
    if (isOpen) {
      setLocalCategories(selectedCategories || []);
      setSearch('');
    }
  }, [isOpen, selectedCategories]);

  const filtered = availableCategories.filter((c) =>
    c.toLowerCase().includes(search.toLowerCase())
  );

  const handleToggleCategory = (cat: string) => {
    setLocalCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const handleConfirm = () => {
    onChange(localCategories);
    setIsOpen(false);
  };

  const handleClear = () => {
    setLocalCategories([]);
  };

  const getSummaryLabel = () => {
    if (!selectedCategories || selectedCategories.length === 0) return t('leads.filterByCategory') || 'Kategori ve Sektörler';
    if (selectedCategories.length === 1) return selectedCategories[0];
    if (selectedCategories.length === 2) return `${selectedCategories[0]}, ${selectedCategories[1]}`;
    return `${selectedCategories.length} ${t('common.category') || 'Kategori'} (${selectedCategories.slice(0, 2).join(', ')}...)`;
  };

  const modalContent = isOpen && mounted ? (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 overflow-hidden select-none animate-fade-in"
      onClick={() => setIsOpen(false)}
    >
      <div
        className="w-full max-w-lg bg-white dark:bg-[#2F3349] rounded-xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-white/[0.1] flex flex-col h-[85vh] sm:h-[520px] max-h-[90vh] overflow-hidden animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-slate-100 dark:border-white/[0.08] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center font-bold shrink-0">
              <Layers className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-extrabold text-slate-800 dark:text-white leading-tight">
                {t('leadFinder.categoryFilterTitle')}
              </h3>
              <p className="text-[10px] sm:text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium">
                {t('leadFinder.categoryFilterSubtitle')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Selected Badges Preview Bar */}
        <div className="px-4 py-2.5 bg-slate-50 dark:bg-[#25293C] border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center space-x-1.5 flex-wrap gap-y-1 overflow-x-auto max-h-16 py-0.5">
            <span className="text-[10px] sm:text-[11px] font-bold text-slate-500 dark:text-[#7E7F96] mr-1 shrink-0">
              {t('leadFinder.selectedLabel')}
            </span>
            {localCategories.length === 0 ? (
              <span className="text-[11px] text-slate-400 italic shrink-0">
                {t('leadFinder.allCategoriesShown')}
              </span>
            ) : (
              localCategories.map((cat) => (
                <span
                  key={cat}
                  className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-bold px-2 py-0.5 rounded bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25 dark:text-[#A59DF8] shrink-0"
                >
                  <span className="max-w-[140px] truncate">{cat}</span>
                  <button
                    type="button"
                    onClick={() => handleToggleCategory(cat)}
                    className="hover:text-[#EA5455] p-0.5"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))
            )}
          </div>

          <span className="text-[11px] sm:text-xs font-bold text-slate-700 dark:text-slate-300 shrink-0 font-mono pl-2">
            {t('leadFinder.selectedCount', { count: localCategories.length })}
          </span>
        </div>

        {/* Search & List Body */}
        <div className="p-3 sm:p-4 flex-1 flex flex-col overflow-hidden min-h-0 bg-slate-50/50 dark:bg-[#25293C]/40">
          <div className="relative mb-2.5 shrink-0 flex items-center">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('leadFinder.searchCategoriesPlaceholder')}
              className="w-full pl-9 pr-3 py-2 rounded-lg vuexy-input text-xs font-medium"
            />
          </div>

          <div className="flex-1 overflow-y-auto space-y-1 pr-1 border border-slate-200/80 dark:border-white/[0.08] rounded-xl p-2 bg-white dark:bg-[#2F3349]">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                {t('leadFinder.noCategoryMatch')}
              </div>
            ) : (
              filtered.map((cat) => {
                const isChecked = localCategories.includes(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => handleToggleCategory(cat)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-between group ${
                      isChecked
                        ? 'bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25 dark:text-[#A59DF8] font-bold'
                        : 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/[0.03]'
                    }`}
                  >
                    <span className="truncate pr-2">{cat}</span>
                    <div
                      className={`w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${
                        isChecked
                          ? 'bg-[#7367F0] border-[#7367F0] text-white'
                          : 'border-slate-300 dark:border-slate-600 group-hover:border-[#7367F0]'
                      }`}
                    >
                      {isChecked && <Check className="w-3 h-3 stroke-[3]" />}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-3.5 sm:p-4 bg-white dark:bg-[#2F3349] border-t border-slate-100 dark:border-white/[0.08] flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={handleClear}
            className="text-xs font-bold text-slate-400 hover:text-[#EA5455] transition-colors"
          >
            {t('leadFinder.clearCategorySelection')}
          </button>

          <div className="flex items-center space-x-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsOpen(false)}
            >
              {t('leadFinder.cancelSelection')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleConfirm}
              className="space-x-1.5 font-bold shadow-md shadow-[#7367F0]/30"
            >
              <Check className="w-4 h-4" />
              <span>{t('leadFinder.applySelection')}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(true)}
        className="w-full h-11 px-3.5 rounded-lg vuexy-input text-xs font-medium flex items-center justify-between text-left hover:border-[#7367F0] transition-colors group cursor-pointer"
      >
        <div className="flex items-center space-x-2 truncate">
          <Layers className="w-3.5 h-3.5 text-[#7367F0] shrink-0" />
          <span
            className={`truncate text-xs ${
              selectedCategories.length > 0
                ? 'font-medium text-slate-800 dark:text-white'
                : 'font-normal text-slate-400 dark:text-[#7E7F96]'
            }`}
          >
            {getSummaryLabel()}
          </span>
        </div>
        <div className="flex items-center space-x-1 shrink-0">
          {selectedCategories.length > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.2 rounded-full bg-[#7367F0]/15 text-[#7367F0]">
              {selectedCategories.length}
            </span>
          )}
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 group-hover:text-[#7367F0] transition-colors" />
        </div>
      </button>

      {mounted && modalContent && createPortal(modalContent, document.body)}
    </>
  );
};
