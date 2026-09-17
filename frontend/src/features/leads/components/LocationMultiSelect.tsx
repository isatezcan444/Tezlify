import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { MapPin, Search, Check, ChevronDown, X } from 'lucide-react';
import { TURKEY_LOCATIONS, CityData } from '../../../data/turkeyLocations';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { useI18n } from '../../../context/I18nContext';

interface LocationMultiSelectProps {
  selectedCity: string;
  selectedDistricts: string[];
  onChange?: (city: string, districts: string[]) => void;
  onCityChange?: (city: string) => void;
  onDistrictsChange?: (districts: string[]) => void;
  disabled?: boolean;
}

export const LocationMultiSelect: React.FC<LocationMultiSelectProps> = ({
  selectedCity,
  selectedDistricts = [],
  onChange,
  onCityChange,
  onDistrictsChange,
  disabled = false,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [activeCityName, setActiveCityName] = useState(selectedCity || 'İstanbul');
  const [localDistricts, setLocalDistricts] = useState<string[]>(selectedDistricts || []);
  const [citySearch, setCitySearch] = useState('');
  const [districtSearch, setDistrictSearch] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Sync when props change or modal opens
  useEffect(() => {
    if (selectedCity) setActiveCityName(selectedCity);
    setLocalDistricts(selectedDistricts || []);
  }, [selectedCity, selectedDistricts, isOpen]);

  // Find active city object
  const activeCity = TURKEY_LOCATIONS.find((c) => c.name === activeCityName) || TURKEY_LOCATIONS[0];

  // Filter cities and districts
  const filteredCities = TURKEY_LOCATIONS.filter((c) =>
    c.name.toLowerCase().includes(citySearch.toLowerCase())
  );

  const filteredDistricts = activeCity.districts.filter((d) =>
    d.toLowerCase().includes(districtSearch.toLowerCase())
  );

  const handleCitySelect = (cityName: string) => {
    setActiveCityName(cityName);
    setLocalDistricts([]); // Reset districts when changing city
  };

  const handleToggleDistrict = (district: string) => {
    setLocalDistricts((prev) =>
      prev.includes(district)
        ? prev.filter((d) => d !== district)
        : [...prev, district]
    );
  };

  const handleSelectAllDistricts = () => {
    setLocalDistricts([...activeCity.districts]);
  };

  const handleClearDistricts = () => {
    setLocalDistricts([]);
  };

  const handleConfirm = () => {
    if (onChange) onChange(activeCityName, localDistricts);
    if (onCityChange) onCityChange(activeCityName);
    if (onDistrictsChange) onDistrictsChange(localDistricts);
    setIsOpen(false);
  };

  const getSummaryLabel = () => {
    if (!selectedCity) return t('leadFinder.cityPlaceholder');
    const districts = selectedDistricts || [];
    if (districts.length === 0) return `${selectedCity} (${t('leadFinder.allDistricts')})`;
    if (districts.length === 1) return `${selectedCity} > ${districts[0]}`;
    return `${selectedCity} (${districts.length} ${t('common.location')}: ${districts.slice(0, 2).join(', ')}${districts.length > 2 ? '...' : ''})`;
  };

  const modalContent = isOpen && mounted ? (
    <div 
      className="fixed inset-0 z-[99999] flex items-center justify-center p-2.5 sm:p-4 bg-slate-900/60 overflow-hidden select-none animate-fade-in"
      onClick={() => setIsOpen(false)}
    >
      <div 
        className="w-full max-w-2xl bg-white dark:bg-[#2F3349] rounded-xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-white/[0.1] flex flex-col h-[88vh] sm:h-[560px] max-h-[92vh] overflow-hidden animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="p-3.5 sm:p-5 border-b border-slate-100 dark:border-white/[0.08] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-[#00CFE8]/15 text-[#00CFE8] flex items-center justify-center font-bold shrink-0">
              <MapPin className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-extrabold text-slate-800 dark:text-white leading-tight">
                {t('leadFinder.locationLabel')}
              </h3>
              <p className="text-[10px] sm:text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium">
                {t('leadFinder.districtsPlaceholder')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Selected Badges Preview Bar */}
        <div className="px-3.5 sm:px-5 py-2 sm:py-2.5 bg-slate-50 dark:bg-[#25293C] border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center space-x-1.5 flex-wrap gap-y-1 overflow-x-auto max-h-14 sm:max-h-16 py-0.5">
            <span className="text-[10px] sm:text-[11px] font-bold text-slate-500 dark:text-[#7E7F96] mr-1 shrink-0">{t('common.selected') || 'Selected'}:</span>
            <Badge variant="primary" className="text-[10px] sm:text-[11px] font-bold shrink-0">
              {activeCityName}
            </Badge>
            {localDistricts.length === 0 ? (
              <span className="text-[10px] sm:text-[11px] text-slate-400 italic shrink-0">({t('leadFinder.allDistricts')})</span>
            ) : (
              localDistricts.map((dist) => (
                <span
                  key={dist}
                  className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-bold px-2 py-0.5 rounded bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25 dark:text-[#A59DF8] shrink-0"
                >
                  {dist}
                  <button
                    type="button"
                    onClick={() => handleToggleDistrict(dist)}
                    className="hover:text-[#EA5455] p-0.5 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))
            )}
          </div>

          <span className="text-[11px] sm:text-xs font-bold text-slate-700 dark:text-slate-300 shrink-0 font-mono pl-2">
            {localDistricts.length} / {activeCity.districts.length}
          </span>
        </div>

        {/* Two-Column Selector Body */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 sm:gap-3 p-3 sm:p-4 flex-1 overflow-hidden min-h-0 bg-slate-50/50 dark:bg-[#25293C]/40">
          {/* Left Column: Iller */}
          <div className="h-40 sm:h-auto sm:col-span-5 flex flex-col border border-slate-200/80 dark:border-white/[0.08] rounded-xl p-2.5 sm:p-3 bg-white dark:bg-[#2F3349] overflow-hidden shrink-0 sm:shrink">
            <div className="relative mb-2.5 shrink-0 flex items-center">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
              <input
                type="text"
                value={citySearch}
                onChange={(e) => setCitySearch(e.target.value)}
                placeholder={t('leadFinder.cityPlaceholder')}
                className="w-full pl-9 pr-3 py-2 rounded-lg vuexy-input text-xs font-medium"
              />
            </div>

            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {filteredCities.map((city) => {
                const isCityActive = activeCityName === city.name;
                return (
                  <button
                    key={city.name}
                    type="button"
                    onClick={() => handleCitySelect(city.name)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-between cursor-pointer ${
                      isCityActive
                        ? 'bg-[#7367F0] text-white shadow-sm'
                        : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05]'
                    }`}
                  >
                    <span>{city.name}</span>
                    <span className={`text-[10px] ${isCityActive ? 'text-white/80' : 'text-slate-400'}`}>
                      {city.districts.length}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Column: Ilceler Checklist */}
          <div className="sm:col-span-7 flex flex-col border border-slate-200/80 dark:border-white/[0.08] rounded-xl p-3 bg-white dark:bg-[#2F3349] overflow-hidden">
            <div className="flex items-center justify-between gap-2 mb-2.5 shrink-0">
              <div className="relative flex-1 flex items-center">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
                <input
                  type="text"
                  value={districtSearch}
                  onChange={(e) => setDistrictSearch(e.target.value)}
                  placeholder={`${activeCityName}...`}
                  className="w-full pl-9 pr-3 py-2 rounded-lg vuexy-input text-xs font-medium"
                />
              </div>
              <div className="flex items-center space-x-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleSelectAllDistricts}
                  className="text-[11px] font-bold text-[#7367F0] hover:underline px-1 py-0.5 cursor-pointer"
                >
                  {t('common.selectAll') || 'Select All'}
                </button>
                <span className="text-slate-300 dark:text-slate-600">|</span>
                <button
                  type="button"
                  onClick={handleClearDistricts}
                  className="text-[11px] font-bold text-slate-400 hover:text-[#EA5455] px-1 py-0.5 cursor-pointer"
                >
                  {t('common.clear') || 'Clear'}
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto grid grid-cols-2 gap-1.5 pr-1 content-start">
              {filteredDistricts.map((district) => {
                const isSelected = localDistricts.includes(district);
                return (
                  <div
                    key={district}
                    onClick={() => handleToggleDistrict(district)}
                    className={`flex items-center space-x-2 px-2.5 py-2 rounded-lg text-xs font-semibold cursor-pointer select-none transition-all border ${
                      isSelected
                        ? 'bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25 dark:text-[#A59DF8] border-[#7367F0]/40 font-bold'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] border-transparent'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}} // Handled by parent click
                      className="rounded border-slate-300 dark:border-slate-700 text-[#7367F0] focus:ring-0 w-3.5 h-3.5 shrink-0 pointer-events-none"
                    />
                    <span className="truncate">{district}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-100 dark:border-white/[0.08] flex items-center justify-between shrink-0 bg-white dark:bg-[#2F3349]">
          <p className="text-xs text-slate-500 dark:text-[#7E7F96] font-medium hidden sm:block">
            {localDistricts.length > 0
              ? `${localDistricts.length} ${t('common.location')}`
              : `${activeCityName} (${t('leadFinder.allDistricts')})`}
          </p>

          <div className="flex items-center space-x-2.5 ml-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsOpen(false)}
            >
              {t('common.close')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleConfirm}
              className="font-bold shadow-md shadow-[#7367F0]/30 space-x-1.5"
            >
              <Check className="w-4 h-4" />
              <span>{t('common.apply')}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="relative">
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className="w-full h-11 flex items-center justify-between px-3.5 rounded-lg vuexy-input text-xs font-medium bg-white dark:bg-[#25293C] text-left transition-all border border-slate-300 dark:border-white/[0.12] hover:border-[#7367F0] focus:outline-none"
      >
        <div className="flex items-center space-x-2 truncate">
          <MapPin className="w-3.5 h-3.5 text-[#00CFE8] shrink-0" />
          <span className={`truncate ${selectedCity ? 'font-medium text-slate-800 dark:text-white' : 'font-normal text-slate-400 dark:text-[#7E7F96]'}`}>
            {getSummaryLabel()}
          </span>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180 text-[#7367F0]' : ''}`} />
      </button>

      {/* Render via Portal at document body level */}
      {mounted && typeof document !== 'undefined' && createPortal(modalContent, document.body)}
    </div>
  );
};
