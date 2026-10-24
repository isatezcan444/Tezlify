import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { MapPin, Search, Check, ChevronDown, X, Building2, Filter, Loader2, ArrowRight } from 'lucide-react';
import { TURKEY_LOCATIONS, CityData, getDistrictPopulation, formatPopulation } from '../../../data/turkeyLocations';
import { TurkeyLocationService } from '../../../services/turkeyLocationService';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { useI18n } from '../../../context/I18nContext';

interface LocationMultiSelectProps {
  selectedCity: string;
  selectedDistricts: string[];
  selectedNeighborhoods?: string[];
  onChange?: (city: string, districts: string[], neighborhoods?: string[]) => void;
  onCityChange?: (city: string) => void;
  onDistrictsChange?: (districts: string[]) => void;
  onNeighborhoodsChange?: (neighborhoods: string[]) => void;
  disabled?: boolean;
}

export const LocationMultiSelect: React.FC<LocationMultiSelectProps> = ({
  selectedCity,
  selectedDistricts = [],
  selectedNeighborhoods = [],
  onChange,
  onCityChange,
  onDistrictsChange,
  onNeighborhoodsChange,
  disabled = false,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [activeCityName, setActiveCityName] = useState(selectedCity || 'İstanbul');
  const [localDistricts, setLocalDistricts] = useState<string[]>(selectedDistricts || []);
  const [localNeighborhoods, setLocalNeighborhoods] = useState<string[]>(selectedNeighborhoods || []);
  const [citySearch, setCitySearch] = useState('');
  const [districtSearch, setDistrictSearch] = useState('');
  const [nhSearch, setNhSearch] = useState('');
  const [minPopFilter, setMinPopFilter] = useState<number>(0);
  const [activeDistrictForNh, setActiveDistrictForNh] = useState<string | null>(null);
  const [availableNeighborhoods, setAvailableNeighborhoods] = useState<string[]>([]);
  const [isLoadingNh, setIsLoadingNh] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Sync when props change or modal opens
  useEffect(() => {
    if (selectedCity) setActiveCityName(selectedCity);
    setLocalDistricts(selectedDistricts || []);
    setLocalNeighborhoods(selectedNeighborhoods || []);
  }, [selectedCity, selectedDistricts, selectedNeighborhoods, isOpen]);

  // Find active city object
  const activeCity = useMemo(() => {
    return TURKEY_LOCATIONS.find((c) => c.name === activeCityName) || TURKEY_LOCATIONS[0];
  }, [activeCityName]);

  // Filter cities with Turkish diacritics support
  const filteredCities = useMemo(() => {
    return TURKEY_LOCATIONS.filter((c) =>
      c.name.toLocaleLowerCase('tr-TR').includes(citySearch.trim().toLocaleLowerCase('tr-TR'))
    );
  }, [citySearch]);

  // Filter districts with search and population filter
  const filteredDistricts = useMemo(() => {
    return activeCity.districts.filter((d) => {
      const matchesSearch = d.toLocaleLowerCase('tr-TR').includes(districtSearch.trim().toLocaleLowerCase('tr-TR'));
      if (!matchesSearch) return false;
      if (minPopFilter > 0) {
        const pop = getDistrictPopulation(activeCityName, d);
        if (pop < minPopFilter) return false;
      }
      return true;
    });
  }, [activeCity, activeCityName, districtSearch, minPopFilter]);

  // Load neighborhoods when active district changes
  useEffect(() => {
    let isCancelled = false;
    if (activeDistrictForNh) {
      setIsLoadingNh(true);
      TurkeyLocationService.fetchNeighborhoods(activeCityName, activeDistrictForNh)
        .then((nhList) => {
          if (!isCancelled) {
            setAvailableNeighborhoods(nhList);
            setIsLoadingNh(false);
          }
        })
        .catch(() => {
          if (!isCancelled) {
            setAvailableNeighborhoods([]);
            setIsLoadingNh(false);
          }
        });
    } else {
      setAvailableNeighborhoods([]);
    }
    return () => {
      isCancelled = true;
    };
  }, [activeCityName, activeDistrictForNh]);

  const filteredNeighborhoods = useMemo(() => {
    if (!nhSearch.trim()) return availableNeighborhoods;
    return availableNeighborhoods.filter((nh) =>
      nh.toLocaleLowerCase('tr-TR').includes(nhSearch.trim().toLocaleLowerCase('tr-TR'))
    );
  }, [availableNeighborhoods, nhSearch]);

  const handleCitySelect = (cityName: string) => {
    setActiveCityName(cityName);
    setLocalDistricts([]);
    setLocalNeighborhoods([]);
    setActiveDistrictForNh(null);
  };

  const handleToggleDistrict = (district: string) => {
    setLocalDistricts((prev) => {
      const next = prev.includes(district) ? prev.filter((d) => d !== district) : [...prev, district];
      // If removed, clean up its neighborhoods
      if (!next.includes(district) && activeDistrictForNh === district) {
        setActiveDistrictForNh(null);
      }
      return next;
    });
  };

  const handleSelectAllDistricts = () => {
    setLocalDistricts([...filteredDistricts]);
  };

  const handleClearDistricts = () => {
    setLocalDistricts([]);
    setLocalNeighborhoods([]);
    setActiveDistrictForNh(null);
  };

  const handleToggleNeighborhood = (nh: string) => {
    setLocalNeighborhoods((prev) =>
      prev.includes(nh) ? prev.filter((item) => item !== nh) : [...prev, nh]
    );
  };

  const handleSelectAllNeighborhoods = () => {
    setLocalNeighborhoods((prev) => Array.from(new Set([...prev, ...filteredNeighborhoods])));
  };

  const handleClearNeighborhoods = () => {
    setLocalNeighborhoods([]);
  };

  const handleConfirm = () => {
    if (onChange) onChange(activeCityName, localDistricts, localNeighborhoods);
    if (onCityChange) onCityChange(activeCityName);
    if (onDistrictsChange) onDistrictsChange(localDistricts);
    if (onNeighborhoodsChange) onNeighborhoodsChange(localNeighborhoods);
    setIsOpen(false);
  };

  const getSummaryLabel = () => {
    if (!selectedCity) return t('leadFinder.cityPlaceholder');
    const districts = selectedDistricts || [];
    const nhCount = selectedNeighborhoods?.length || 0;

    if (districts.length === 0) return `${selectedCity} (${t('leadFinder.allDistricts')})`;
    if (districts.length === 1) {
      if (nhCount > 0) {
        return `${selectedCity} > ${districts[0]} (${nhCount} ${t('leadFinder.neighborhoodsLabel')})`;
      }
      return `${selectedCity} > ${districts[0]}`;
    }
    return `${selectedCity} (${districts.length} ${t('common.location')}: ${districts.slice(0, 2).join(', ')}${districts.length > 2 ? '...' : ''})`;
  };

  const modalContent = isOpen && mounted ? (
    <div 
      className="fixed inset-0 z-[99999] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 overflow-hidden select-none animate-fade-in"
      onClick={() => setIsOpen(false)}
    >
      <div 
        className="w-full max-w-4xl bg-white dark:bg-[#2F3349] rounded-xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-white/[0.1] flex flex-col h-[90vh] sm:h-[600px] max-h-[94vh] overflow-hidden animate-scale-up"
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
        <div className="px-3.5 sm:px-5 py-2 bg-slate-50 dark:bg-[#25293C] border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-2 shrink-0">
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

            {localNeighborhoods.length > 0 && (
              <Badge variant="outline" className="text-[10px] sm:text-[11px] font-bold text-[#00CFE8] border-[#00CFE8]/40 shrink-0">
                {localNeighborhoods.length} {t('leadFinder.neighborhoodsLabel')}
              </Badge>
            )}
          </div>

          <span className="text-[11px] sm:text-xs font-bold text-slate-700 dark:text-slate-300 shrink-0 font-mono pl-2">
            {localDistricts.length} / {activeCity.districts.length}
          </span>
        </div>

        {/* Three-Column / Dual-Column Layout */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 sm:gap-3 p-3 sm:p-4 flex-1 overflow-hidden min-h-0 bg-slate-50/50 dark:bg-[#25293C]/40">
          {/* Left Column: Iller (4 cols) */}
          <div className="h-36 md:h-auto md:col-span-3 lg:col-span-3 flex flex-col border border-slate-200/80 dark:border-white/[0.08] rounded-xl p-2.5 bg-white dark:bg-[#2F3349] overflow-hidden">
            <div className="relative mb-2 shrink-0 flex items-center">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
              <input
                type="text"
                value={citySearch}
                onChange={(e) => setCitySearch(e.target.value)}
                placeholder={t('leadFinder.cityPlaceholder')}
                className="w-full pl-8 pr-2.5 py-1.5 rounded-lg vuexy-input text-xs font-medium"
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
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-between cursor-pointer ${
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

          {/* Middle Column: Ilceler Checklist & Nufus Filtresi (5 or 9 cols depending on mahalle active) */}
          <div className={`${activeDistrictForNh ? 'md:col-span-5 lg:col-span-5' : 'md:col-span-9 lg:col-span-9'} flex flex-col border border-slate-200/80 dark:border-white/[0.08] rounded-xl p-2.5 sm:p-3 bg-white dark:bg-[#2F3349] overflow-hidden`}>
            {/* Search and Action Bar */}
            <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
              <div className="relative flex-1 flex items-center">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
                <input
                  type="text"
                  value={districtSearch}
                  onChange={(e) => setDistrictSearch(e.target.value)}
                  placeholder={`${activeCityName}...`}
                  className="w-full pl-8 pr-2.5 py-1.5 rounded-lg vuexy-input text-xs font-medium"
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

            {/* Faz 3: Quick Population Filter Pills */}
            <div className="flex items-center gap-1.5 mb-2 overflow-x-auto pb-1 shrink-0 text-[10px] font-bold text-slate-500">
              <span className="shrink-0 flex items-center gap-1">
                <Filter className="w-3 h-3 text-[#7367F0]" />
                {t('leadFinder.populationFilter')}:
              </span>
              {[
                { label: t('leadFinder.allPopulations'), val: 0 },
                { label: t('leadFinder.over50k'), val: 50000 },
                { label: t('leadFinder.over100k'), val: 100000 },
                { label: t('leadFinder.over250k'), val: 250000 },
              ].map((pill) => (
                <button
                  key={pill.val}
                  type="button"
                  onClick={() => setMinPopFilter(pill.val)}
                  className={`px-2 py-0.5 rounded-full transition-all cursor-pointer shrink-0 ${
                    minPopFilter === pill.val
                      ? 'bg-[#7367F0] text-white shadow-xs'
                      : 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/[0.1]'
                  }`}
                >
                  {pill.label}
                </button>
              ))}
            </div>

            {/* District Grid */}
            <div className={`flex-1 overflow-y-auto grid ${activeDistrictForNh ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'} gap-1.5 pr-1 content-start`}>
              {filteredDistricts.map((district) => {
                const isSelected = localDistricts.includes(district);
                const pop = getDistrictPopulation(activeCityName, district);
                const popStr = formatPopulation(pop);
                const isNhActive = activeDistrictForNh === district;

                return (
                  <div
                    key={district}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-semibold select-none transition-all border ${
                      isSelected
                        ? 'bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25 dark:text-[#A59DF8] border-[#7367F0]/40 font-bold'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] border-transparent'
                    }`}
                  >
                    <div 
                      className="flex items-center space-x-2 flex-1 min-w-0 cursor-pointer"
                      onClick={() => handleToggleDistrict(district)}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        className="rounded border-slate-300 dark:border-slate-700 text-[#7367F0] focus:ring-0 w-3.5 h-3.5 shrink-0 pointer-events-none"
                      />
                      <span className="truncate">{district}</span>
                      {popStr && (
                        <span className={`text-[10px] px-1.5 py-0.2 rounded font-mono shrink-0 ${
                          isSelected ? 'bg-[#7367F0]/25 text-[#7367F0] dark:text-[#A59DF8]' : 'bg-slate-100 dark:bg-white/[0.05] text-slate-400'
                        }`}>
                          {popStr}
                        </span>
                      )}
                    </div>

                    {/* Faz 2: Mahalle Drilldown Button */}
                    <button
                      type="button"
                      title={t('leadFinder.selectNeighborhoods')}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isSelected) {
                          handleToggleDistrict(district);
                        }
                        setActiveDistrictForNh(isNhActive ? null : district);
                      }}
                      className={`ml-1.5 p-1 rounded-md text-[10px] transition-all cursor-pointer flex items-center gap-1 ${
                        isNhActive
                          ? 'bg-[#00CFE8] text-white'
                          : 'text-slate-400 hover:text-[#00CFE8] hover:bg-[#00CFE8]/10'
                      }`}
                    >
                      <Building2 className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Faz 2 Mahalleler Drilldown (4 cols) */}
          {activeDistrictForNh && (
            <div className="md:col-span-4 lg:col-span-4 flex flex-col border border-[#00CFE8]/30 dark:border-[#00CFE8]/20 rounded-xl p-2.5 sm:p-3 bg-white dark:bg-[#2F3349] overflow-hidden animate-fade-in">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-white/[0.08] mb-2 shrink-0">
                <div className="flex items-center gap-1.5 truncate">
                  <Building2 className="w-3.5 h-3.5 text-[#00CFE8] shrink-0" />
                  <span className="text-xs font-bold text-slate-800 dark:text-white truncate">
                    {activeDistrictForNh} ({t('leadFinder.neighborhoodsLabel')})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveDistrictForNh(null)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-white p-1 rounded cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Neighborhood Search & Actions */}
              <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
                <div className="relative flex-1 flex items-center">
                  <Search className="w-3 h-3 text-slate-400 absolute left-2.5 pointer-events-none" />
                  <input
                    type="text"
                    value={nhSearch}
                    onChange={(e) => setNhSearch(e.target.value)}
                    placeholder={t('leadFinder.selectNeighborhoods')}
                    className="w-full pl-7 pr-2 py-1 rounded-lg vuexy-input text-[11px] font-medium"
                  />
                </div>
                <div className="flex items-center space-x-1 shrink-0 text-[10px]">
                  <button
                    type="button"
                    onClick={handleSelectAllNeighborhoods}
                    className="font-bold text-[#00CFE8] hover:underline px-1 cursor-pointer"
                  >
                    {t('common.selectAll') || 'All'}
                  </button>
                  <button
                    type="button"
                    onClick={handleClearNeighborhoods}
                    className="font-bold text-slate-400 hover:text-[#EA5455] px-1 cursor-pointer"
                  >
                    {t('common.clear') || 'Clear'}
                  </button>
                </div>
              </div>

              {/* Neighborhoods List */}
              <div className="flex-1 overflow-y-auto space-y-1 pr-1">
                {isLoadingNh ? (
                  <div className="flex items-center justify-center py-8 text-xs text-slate-400 gap-2">
                    <Loader2 className="w-4 h-4 text-[#00CFE8] animate-spin" />
                    <span>{t('leadFinder.loadingNeighborhoods')}</span>
                  </div>
                ) : filteredNeighborhoods.length === 0 ? (
                  <div className="text-center py-8 text-xs text-slate-400">
                    {t('leadFinder.noNeighborhoods')}
                  </div>
                ) : (
                  filteredNeighborhoods.map((nh) => {
                    const isNhSelected = localNeighborhoods.includes(nh);
                    return (
                      <div
                        key={nh}
                        onClick={() => handleToggleNeighborhood(nh)}
                        className={`flex items-center space-x-2 px-2 py-1.5 rounded-lg text-xs font-semibold cursor-pointer select-none transition-all border ${
                          isNhSelected
                            ? 'bg-[#00CFE8]/15 text-[#00CFE8] dark:bg-[#00CFE8]/25 border-[#00CFE8]/40 font-bold'
                            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] border-transparent'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isNhSelected}
                          onChange={() => {}}
                          className="rounded border-slate-300 dark:border-slate-700 text-[#00CFE8] focus:ring-0 w-3.5 h-3.5 shrink-0 pointer-events-none"
                        />
                        <span className="truncate">{nh}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-3.5 sm:p-4 border-t border-slate-100 dark:border-white/[0.08] flex items-center justify-between shrink-0 bg-white dark:bg-[#2F3349]">
          <p className="text-xs text-slate-500 dark:text-[#7E7F96] font-medium hidden sm:block">
            {localDistricts.length > 0
              ? `${localDistricts.length} ${t('common.location')}${localNeighborhoods.length > 0 ? ` (${localNeighborhoods.length} ${t('leadFinder.neighborhoodsLabel')})` : ''}`
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
