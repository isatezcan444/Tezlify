import { useState, useMemo, useCallback } from 'react';

export interface UseLeadFiltersReturn {
  search: string;
  setSearch: (val: string) => void;
  selectedCity: string;
  setSelectedCity: (city: string) => void;
  selectedDistricts: string[];
  setSelectedDistricts: (districts: string[]) => void;
  selectedCategories: string[];
  setSelectedCategories: (categories: string[]) => void;
  statusFilter: string;
  setStatusFilter: (status: string) => void;
  waOnly: boolean;
  setWaOnly: (waOnly: boolean) => void;
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (pageSize: number) => void;
  hasActiveFilters: boolean;
  resetAllFilters: () => void;
  buildQueryParams: () => {
    page: number;
    size: number;
    search?: string;
    city?: string;
    districts?: string[];
    categories?: string[];
    status?: string;
    whatsapp_eligible_only?: boolean;
  };
  buildExportParams: () => {
    search?: string;
    city?: string;
    districts?: string[];
    categories?: string[];
    status?: string;
  };
}

export function useLeadFilters(initialPageSize = 20): UseLeadFiltersReturn {
  const [search, setSearch] = useState('');
  const [selectedCity, setSelectedCity] = useState('');
  const [selectedDistricts, setSelectedDistricts] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [waOnly, setWaOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const hasActiveFilters = useMemo(() => {
    return Boolean(
      search.trim() ||
      selectedCity ||
      selectedDistricts.length > 0 ||
      selectedCategories.length > 0 ||
      statusFilter ||
      waOnly
    );
  }, [search, selectedCity, selectedDistricts, selectedCategories, statusFilter, waOnly]);

  const resetAllFilters = useCallback(() => {
    setSearch('');
    setSelectedCity('');
    setSelectedDistricts([]);
    setSelectedCategories([]);
    setStatusFilter('');
    setWaOnly(false);
    setPage(1);
  }, []);

  const buildQueryParams = useCallback(() => {
    return {
      page,
      size: pageSize,
      search: search.trim() || undefined,
      city: selectedCity || undefined,
      districts: selectedDistricts.length > 0 ? selectedDistricts : undefined,
      categories: selectedCategories.length > 0 ? selectedCategories : undefined,
      status: statusFilter || undefined,
      whatsapp_eligible_only: waOnly,
    };
  }, [page, pageSize, search, selectedCity, selectedDistricts, selectedCategories, statusFilter, waOnly]);

  const buildExportParams = useCallback(() => {
    return {
      search: search.trim() || undefined,
      city: selectedCity || undefined,
      districts: selectedDistricts.length > 0 ? selectedDistricts : undefined,
      categories: selectedCategories.length > 0 ? selectedCategories : undefined,
      status: statusFilter || undefined,
    };
  }, [search, selectedCity, selectedDistricts, selectedCategories, statusFilter]);

  return {
    search,
    setSearch,
    selectedCity,
    setSelectedCity,
    selectedDistricts,
    setSelectedDistricts,
    selectedCategories,
    setSelectedCategories,
    statusFilter,
    setStatusFilter,
    waOnly,
    setWaOnly,
    page,
    setPage,
    pageSize,
    setPageSize,
    hasActiveFilters,
    resetAllFilters,
    buildQueryParams,
    buildExportParams,
  };
}
