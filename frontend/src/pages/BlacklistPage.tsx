import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  ShieldAlert,
  Plus, 
  Trash2, 
  Phone,
  Loader2,
  RotateCcw 
} from 'lucide-react';
import { ApiClient } from '../api/client';
import { BlacklistEntry } from '../types';
import {
  Button,
  IconButton,
  Badge,
  Card,
  PageHeader,
  BulkActionToolbar,
  ToolbarActionButton,
  EmptyState,
  Pagination
} from '../components/ui';
import { SearchInput, Select } from '../components/forms';
import { DataTable, type ColumnDef } from '../components/data-display';
import { BlacklistAddModal } from '../features/leads/components';
import { useToast } from '../context/ToastContext';
import { useI18n } from '../context/I18nContext';

export const BlacklistPage: React.FC = () => {
  const toast = useToast();
  const { t } = useI18n();
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);

  // Table Search & Filter State (SearchInput debounces internally)
  const [search, setSearch] = useState('');
  const [reasonFilter, setReasonFilter] = useState('');

  // Multi-Selection State (Gmail-style)
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [isBulkRemoving, setIsBulkRemoving] = useState(false);

  // Fetch paginated blacklist from server
  // Memoised so the effect below can depend on it directly. The filters it
  // reads ARE the effect's trigger, so the request fires on exactly the same
  // changes as before — the only difference is that the identity is stable, so
  // React stops warning and stops risking a stale closure.
  const fetchBlacklist = useCallback(async () => {
    setLoading(true);
    try {
      const data = await ApiClient.getBlacklist({
        page,
        size: pageSize,
        search: search.trim() || undefined,
        reason: reasonFilter || undefined,
      });
      setBlacklist(data.items || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, reasonFilter, toast, t]);

  useEffect(() => {
    fetchBlacklist();
  }, [fetchBlacklist]);

  // Clear selection on page/filter change unless all-matching is active
  useEffect(() => {
    if (!selectAllMatching) {
      setSelectedIds([]);
    }
  }, [page, pageSize, search, reasonFilter, selectAllMatching]);

  // Selection Checkbox Logic
  const currentPageIds = blacklist.map((item) => item.id);
  const isAllCurrentPageSelected =
    blacklist.length > 0 && currentPageIds.every((id) => selectedIds.includes(id));
  const isSomeCurrentPageSelected =
    currentPageIds.some((id) => selectedIds.includes(id)) && !isAllCurrentPageSelected;

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
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSelectAllAcrossPages = () => {
    setSelectAllMatching(true);
    setSelectedIds(currentPageIds);
  };

  const handleClearSelection = () => {
    setSelectedIds([]);
    setSelectAllMatching(false);
  };

  const selectedCount = selectAllMatching ? total : selectedIds.length;

  const handleOpenAddModal = () => {
    setIsAddOpen(true);
  };

  const handleRemove = async (id: number, phone: string, leadName?: string) => {
    const displayName = leadName || phone;
    const ok = await toast.confirm({
      title: t('blacklist.confirmRemoveTitle'),
      message: t('blacklist.confirmRemoveMsg', { name: displayName, phone }),
      confirmText: t('blacklist.unblockButton'),
      cancelText: t('common.cancel'),
      variant: 'warning',
    });
    if (!ok) return;

    try {
      await ApiClient.removeFromBlacklist(id);
      toast.success(t('blacklist.removedSuccess'), t('common.success'));
      setSelectedIds((prev) => prev.filter((x) => x !== id));
      fetchBlacklist();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    }
  };

  const handleBulkRemove = async () => {
    if (selectedCount === 0) return;

    const ok = await toast.confirm({
      title: selectAllMatching ? t('blacklist.confirmClearAllTitle') : t('blacklist.confirmBulkRemoveTitle'),
      message: selectAllMatching
        ? t('blacklist.confirmClearAllMsg', { total })
        : t('blacklist.confirmBulkRemoveMsg', { count: selectedCount }),
      confirmText: selectAllMatching ? t('blacklist.unblockAllButton', { total }) : t('blacklist.unblockBulkButton', { count: selectedCount }),
      cancelText: t('common.cancel'),
      variant: 'warning',
    });
    if (!ok) return;

    setIsBulkRemoving(true);
    try {
      const res = await ApiClient.bulkRemoveFromBlacklist(
        selectAllMatching
          ? {
              delete_all_matching: true,
              search: search.trim() || undefined,
              reason: reasonFilter || undefined,
            }
          : { ids: selectedIds }
      );
      toast.success(t('blacklist.bulkRemovedSuccess', { count: res.deleted_count }), t('common.success'));
      handleClearSelection();
      fetchBlacklist();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    } finally {
      setIsBulkRemoving(false);
    }
  };

  const getReasonLabel = (reason: string) => {
    switch (reason) {
      case 'USER_REQUEST':
        return t('blacklist.reasonUserRequest');
      case 'BOUNCED':
        return t('blacklist.reasonBounced');
      case 'SPAM_COMPLAINT':
        return t('blacklist.reasonSpamComplaint');
      case 'MANUAL_BLACKLIST':
        return t('blacklist.reasonManual');
      default:
        return reason;
    }
  };

  const columns = useMemo<ColumnDef<BlacklistEntry>[]>(
    () => [
      {
        id: 'profile',
        header: t('leads.colProfile'),
        className: 'max-w-[280px]',
        cell: (entry) => (
          <div>
            <div className="font-bold text-slate-800 dark:text-white text-xs truncate">
              {entry.lead_name || t('leads.noPhone')}
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#7367F0]/10 text-[#7367F0] dark:bg-[#7367F0]/20 dark:text-[#A59DF8]">
                {entry.lead_category || t('common.general')}
              </span>
              {(entry.lead_district || entry.lead_city) && (
                <span className="text-[10px] text-slate-400 font-medium">
                  • {[entry.lead_district, entry.lead_city].filter(Boolean).join(', ')}
                </span>
              )}
            </div>
          </div>
        ),
      },
      {
        id: 'contact',
        header: t('leads.colContact'),
        className: 'whitespace-nowrap',
        cell: (entry) => (
          <div className="flex items-center space-x-2 font-mono font-bold text-xs text-slate-700 dark:text-slate-200">
            <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>{entry.phone_e164}</span>
          </div>
        ),
      },
      {
        id: 'reason',
        header: t('blacklist.blockReasonLabel'),
        className: 'whitespace-nowrap',
        cell: (entry) => (
          <Badge variant="danger" className="text-[11px] font-bold">
            {getReasonLabel(entry.reason)}
          </Badge>
        ),
      },
      {
        id: 'date',
        header: t('common.date'),
        className: 'whitespace-nowrap text-slate-500 dark:text-[#7E7F96] font-sans',
        cell: (entry) => new Date(entry.created_at).toLocaleString(),
      },
      {
        id: 'actions',
        header: t('common.actions'),
        align: 'right',
        className: 'text-right whitespace-nowrap',
        cell: (entry) => (
          <IconButton
            icon={Trash2}
            size="sm"
            variant="ghost"
            tooltip={t('blacklist.confirmRemoveTitle')}
            onClick={() => handleRemove(entry.id, entry.phone_e164, entry.lead_name)}
            className="text-slate-400 hover:text-[#EA5455] hover:bg-[#EA5455]/10"
          />
        ),
      },
    ],
    [t, getReasonLabel, handleRemove]
  );

  return (
    <div className="space-y-6 pb-16 select-none animate-fade-in">
      {/* Page Header & Top Actions */}
      <PageHeader
        title={`${t('blacklist.title')} ${t('blacklist.countBadge', { count: total })}`}
        subtitle={t('blacklist.subtitle')}
        icon={ShieldAlert}
        actions={
          <Button
            variant="destructive"
            size="sm"
            onClick={handleOpenAddModal}
            className="space-x-1.5 font-bold cursor-pointer shadow-md shadow-[#EA5455]/20"
          >
            <Plus className="w-4 h-4" />
            <span>{t('blacklist.addNumber')}</span>
          </Button>
        }
      />

      {/* Filter & Search Bar */}
      <Card className="p-4">
        <div className="flex flex-col md:flex-row items-center gap-3">
          <div className="flex-1 w-full">
            <SearchInput
              value={search}
              onChange={(val) => {
                setSearch(val);
                setPage(1);
              }}
              placeholder={t('blacklist.searchPlaceholder')}
            />
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto">
            <div className="w-full md:w-56">
              <Select
                value={reasonFilter}
                onChange={(e) => {
                  setReasonFilter(e.target.value);
                  setPage(1);
                }}
                options={[
                  { value: '', label: t('blacklist.filterAllReasons') },
                  { value: 'USER_REQUEST', label: t('blacklist.reasonUserRequest') },
                  { value: 'BOUNCED', label: t('blacklist.reasonBounced') },
                  { value: 'SPAM_COMPLAINT', label: t('blacklist.reasonSpamComplaint') },
                  { value: 'MANUAL_BLACKLIST', label: t('blacklist.reasonManual') },
                ]}
              />
            </div>

            {(search || reasonFilter) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setReasonFilter('');
                  setPage(1);
                }}
                className="text-xs font-bold shrink-0 space-x-1 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{t('common.clear')}</span>
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Centralized Bulk Action Toolbar */}
      <BulkActionToolbar
        selectedCount={selectedCount}
        totalCount={total}
        selectAllMatching={selectAllMatching}
        onSelectAllMatching={handleSelectAllAcrossPages}
        onClearSelection={handleClearSelection}
        actions={
          <ToolbarActionButton
            tone="danger"
            disabled={isBulkRemoving}
            onClick={handleBulkRemove}
          >
            {isBulkRemoving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{t('common.loading')}</span>
              </>
            ) : (
              <>
                <Trash2 className="w-3.5 h-3.5" />
                <span>
                  {selectAllMatching
                    ? t('blacklist.bulkDeleteAllButton', { total })
                    : t('blacklist.bulkDeleteButton', { count: selectedCount })}
                </span>
              </>
            )}
          </ToolbarActionButton>
        }
      />

      {/* Blacklist Table using unified DataTable */}
      <DataTable<BlacklistEntry>
        columns={columns}
        data={blacklist}
        loading={loading}
        rowKey={(entry) => entry.id}
        selectable
        selectedIds={selectedIds}
        isRowSelected={(entry) => selectedIds.includes(entry.id) || selectAllMatching}
        onToggleSelect={handleToggleSingleSelect}
        onToggleSelectAll={handleToggleSelectAllPage}
        isAllSelected={selectAllMatching || isAllCurrentPageSelected}
        isSomeSelected={isSomeCurrentPageSelected}
        emptyState={
          <EmptyState
            icon={ShieldAlert}
            title={total === 0 ? t('blacklist.emptyList') : t('blacklist.emptySearch')}
            description={t('blacklist.subtitle')}
          />
        }
        pagination={
          total > 0 ? (
            <Pagination
              currentPage={page}
              totalItems={total}
              pageSize={pageSize}
              onPageChange={(newPage) => setPage(newPage)}
              onPageSizeChange={(newSize) => {
                setPageSize(newSize);
                setPage(1);
              }}
            />
          ) : null
        }
      />

      {/* Centralized Add to Blacklist Modal */}
      <BlacklistAddModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onSuccess={() => {
          setIsAddOpen(false);
          fetchBlacklist();
        }}
      />
    </div>
  );
};
