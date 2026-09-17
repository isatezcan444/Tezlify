import { useState, useMemo } from 'react';
import { Lead } from '../../../types';

export interface UseLeadSelectionProps {
  leads: Lead[];
  total: number;
}

export function useLeadSelection({ leads, total }: UseLeadSelectionProps) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  const currentPageIds = useMemo(() => leads.map((l) => l.id), [leads]);

  const isAllCurrentPageSelected = useMemo(
    () => leads.length > 0 && currentPageIds.every((id) => selectedIds.includes(id)),
    [leads.length, currentPageIds, selectedIds]
  );

  const isSomeCurrentPageSelected = useMemo(
    () => currentPageIds.some((id) => selectedIds.includes(id)) && !isAllCurrentPageSelected,
    [currentPageIds, selectedIds, isAllCurrentPageSelected]
  );

  const handleToggleSelectAllPage = () => {
    if (selectAllMatching) {
      setSelectAllMatching(false);
      setSelectedIds([]);
      return;
    }

    if (isAllCurrentPageSelected) {
      setSelectedIds((prev) => prev.filter((id) => !currentPageIds.includes(id)));
    } else {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...currentPageIds])));
    }
  };

  const handleToggleSingleSelect = (id: number) => {
    if (selectAllMatching) {
      setSelectAllMatching(false);
      setSelectedIds(currentPageIds.filter((x) => x !== id));
      return;
    }

    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSelectAllAcrossPages = () => {
    setSelectAllMatching(true);
    setSelectedIds(currentPageIds);
  };

  const handleClearSelection = () => {
    setSelectAllMatching(false);
    setSelectedIds([]);
  };

  const selectedCount = selectAllMatching ? total : selectedIds.length;

  return {
    selectedIds,
    setSelectedIds,
    selectAllMatching,
    setSelectAllMatching,
    isAllCurrentPageSelected,
    isSomeCurrentPageSelected,
    handleToggleSelectAllPage,
    handleToggleSingleSelect,
    handleSelectAllAcrossPages,
    handleClearSelection,
    selectedCount,
  };
}
