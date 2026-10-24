import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Users, 
  Trash2, 
  Plus, 
  FolderKanban,
  Search,
  X,
  Filter,
} from 'lucide-react';
import { 
  Card, 
  Button, 
  Badge, 
  PageHeader, 
  EmptyState, 
  Pagination,
  BulkActionToolbar,
  ToolbarActionButton
} from '../components/ui';
import { 
  CampaignGroupCard,
  CampaignGroupDetailModal,
  CampaignGroupEditModal,
  CampaignGroupCreateView,
} from '../features/campaigns/components';
import { useToast } from '../context/ToastContext';
import { useI18n } from '../context/I18nContext';
import { ApiClient } from '../api/client';
import { CampaignGroup } from '../types';
import { cn } from '../lib/utils';

interface CampaignGroupsPageProps {
  onNavigate: (tab: string, prefillData?: any) => void;
  onRefreshStats?: () => void;
}

type GroupFilterType = 'ALL' | 'WHATSAPP_READY' | 'CATEGORIZED';

export const CampaignGroupsPage: React.FC<CampaignGroupsPageProps> = ({
  onNavigate,
  onRefreshStats,
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const [groups, setGroups] = useState<CampaignGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'list' | 'create'>('list');

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filterType, setFilterType] = useState<GroupFilterType>('ALL');

  // Pagination State
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Group Selection & Bulk Actions State
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // Modals state
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [editingGroup, setEditingGroup] = useState<CampaignGroup | null>(null);

  // 300ms Debounce for Search (Rule 3)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchGroups = useCallback(async () => {
    try {
      setLoading(true);
      const data = await ApiClient.getCampaignGroups();
      setGroups(data);
    } catch (err) {
      console.error('Error loading campaign groups:', err);
      toast.error(t('campaignGroups.loadError'));
    } finally {
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  const handleDeleteGroup = async (group: CampaignGroup) => {
    const confirmed = await toast.confirm({
      title: t('campaignGroups.deleteGroup'),
      message: t('campaignGroups.deleteConfirm', { name: group.name }),
      confirmText: t('campaignGroups.deleteGroup'),
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await ApiClient.deleteCampaignGroup(group.id);
      toast.success(t('campaignGroups.groupDeleted'));
      setGroups((prev) => prev.filter((g) => g.id !== group.id));
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('campaignGroups.deleteGroupTitle'));
    }
  };

  const handleLaunchCampaign = (group: CampaignGroup) => {
    onNavigate('campaigns', {
      groupId: group.id,
      groupName: group.name,
      targetCategory: group.target_category || '',
      totalLeads: group.total_leads_count,
      whatsappEligible: group.whatsapp_eligible_count,
    });
  };

  const handleToggleSelect = (groupId: number) => {
    setSelectedIds((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId]
    );
  };

  // Filtered Groups Logic
  const filteredGroups = useMemo(() => {
    return groups.filter((group) => {
      // Type Filter
      if (filterType === 'WHATSAPP_READY' && (group.whatsapp_eligible_count ?? 0) <= 0) {
        return false;
      }
      if (filterType === 'CATEGORIZED' && !group.target_category) {
        return false;
      }

      // Search Filter
      if (debouncedQuery.trim()) {
        const q = debouncedQuery.toLowerCase();
        const matchName = group.name.toLowerCase().includes(q);
        const matchCategory = group.target_category?.toLowerCase().includes(q);
        const matchLocation = group.target_location?.toLowerCase().includes(q);
        if (!matchName && !matchCategory && !matchLocation) {
          return false;
        }
      }

      return true;
    });
  }, [groups, filterType, debouncedQuery]);

  // Counts for tabs
  const counts = useMemo(() => {
    return {
      ALL: groups.length,
      WHATSAPP_READY: groups.filter((g) => (g.whatsapp_eligible_count ?? 0) > 0).length,
      CATEGORIZED: groups.filter((g) => !!g.target_category).length,
    };
  }, [groups]);

  const currentPageGroups = filteredGroups.slice((page - 1) * pageSize, page * pageSize);
  const currentPageIds = currentPageGroups.map((g) => g.id);
  const isAllPageSelected = currentPageIds.length > 0 && currentPageIds.every((id) => selectedIds.includes(id));

  const handleToggleSelectAllPage = () => {
    if (isAllPageSelected) {
      setSelectedIds((prev) => prev.filter((id) => !currentPageIds.includes(id)));
      setSelectAllMatching(false);
    } else {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...currentPageIds])));
    }
  };

  const handleSelectAllMatching = () => {
    setSelectedIds(filteredGroups.map((g) => g.id));
    setSelectAllMatching(true);
  };

  const handleClearSelection = () => {
    setSelectedIds([]);
    setSelectAllMatching(false);
  };

  const handleBulkDelete = async () => {
    const count = selectAllMatching ? filteredGroups.length : selectedIds.length;
    if (count === 0) return;

    const confirmed = await toast.confirm({
      title: `${t('campaignGroups.deleteGroup')} (${count})`,
      message: t('campaignGroups.bulkDeleteConfirm', { count }),
      confirmText: t('common.delete') || 'Sil',
      variant: 'danger',
    });
    if (!confirmed) return;

    setIsBulkDeleting(true);
    try {
      const targetIds = selectAllMatching ? filteredGroups.map((g) => g.id) : selectedIds;
      const res = await ApiClient.bulkDeleteCampaignGroups(targetIds);
      toast.success(res.message || t('campaignGroups.bulkDeleteSuccess', { count: res.deleted_count }));
      setSelectedIds([]);
      setSelectAllMatching(false);
      fetchGroups();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('campaignGroups.bulkDeleteError'));
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const filterTabs: Array<{ id: GroupFilterType; label: string; count: number }> = [
    { id: 'ALL', label: t('campaignGroups.filterAll'), count: counts.ALL },
    { id: 'WHATSAPP_READY', label: t('campaignGroups.filterWhatsAppReady'), count: counts.WHATSAPP_READY },
    { id: 'CATEGORIZED', label: t('campaignGroups.filterWithSector'), count: counts.CATEGORIZED },
  ];

  return (
    <div className="space-y-4 sm:space-y-6 pb-16 select-none animate-fade-in">
      {/* Top Header & Mode Tabs */}
      <Card className="p-4 sm:p-6">
        <PageHeader
          title={t('campaignGroups.title')}
          subtitle={t('campaignGroups.pageSubtitle')}
          icon={Users}
          actions={
            <div className="flex items-center space-x-2">
              <Button
                variant={activeTab === 'list' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('list')}
                className={`cursor-pointer font-bold ${activeTab === 'list' ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30' : ''}`}
              >
                {t('campaignGroups.allGroupsTab')} ({groups.length})
              </Button>
              <Button
                variant={activeTab === 'create' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('create')}
                className={`space-x-1.5 font-bold cursor-pointer ${activeTab === 'create' ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30' : ''}`}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('campaignGroups.createGroupTab')}</span>
              </Button>
            </div>
          }
        />
      </Card>

      {activeTab === 'list' ? (
        /* Groups Grid View */
        <div className="space-y-4">
          {groups.length === 0 ? (
            <Card className="p-8 text-center">
              <EmptyState
                icon={FolderKanban}
                title={t('campaignGroups.emptyTitle')}
                description={t('campaignGroups.emptyDesc')}
                action={{
                  label: t('campaignGroups.createGroupTab'),
                  onClick: () => setActiveTab('create'),
                  icon: Plus,
                }}
              />
            </Card>
          ) : (
            <>
              {/* Search & Filter Bar (Matching CampaignsPage & LeadCRMPage) */}
              <Card className="p-4 space-y-3.5 border-slate-100 dark:border-white/[0.05] bg-white dark:bg-[#2F3349] shadow-sm">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  {/* Search Input with 300ms Debounce */}
                  <div className="relative flex-1 max-w-md">
                    <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={t('campaignGroups.searchPlaceholder')}
                      className="w-full pl-9 pr-9 py-2 rounded-lg text-xs font-medium border border-slate-200 dark:border-white/10 bg-slate-50/60 dark:bg-[#25293C] text-slate-800 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#7367F0]/20 focus:border-[#7367F0] transition-all"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-white cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Filter Pills */}
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
                    {filterTabs.map((tab) => {
                      const isActive = filterType === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => {
                            setFilterType(tab.id);
                            setPage(1);
                          }}
                          className={cn(
                            'px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer flex items-center space-x-1.5',
                            isActive
                              ? 'bg-[#7367F0] text-white shadow-xs'
                              : 'bg-slate-100/80 dark:bg-white/[0.04] text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/[0.08]'
                          )}
                        >
                          <span>{tab.label}</span>
                          <span
                            className={cn(
                              'text-[10px] font-mono px-1.5 py-0.2 rounded-full',
                              isActive
                                ? 'bg-white/20 text-white'
                                : 'bg-slate-200 dark:bg-white/10 text-slate-600 dark:text-slate-300'
                            )}
                          >
                            {tab.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Card>

              {/* Centralized Bulk Action Toolbar */}
              <BulkActionToolbar
                selectedCount={selectedIds.length}
                totalCount={filteredGroups.length}
                selectAllMatching={selectAllMatching}
                onSelectAllMatching={filteredGroups.length > selectedIds.length ? handleSelectAllMatching : undefined}
                onClearSelection={handleClearSelection}
                actions={
                  <ToolbarActionButton tone="danger" onClick={handleBulkDelete} disabled={isBulkDeleting}>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isBulkDeleting ? t('common.loading') : t('campaignGroups.bulkDeleteSelected', { count: selectedIds.length })}</span>
                  </ToolbarActionButton>
                }
              />

              {/* Selection & Controls Bar */}
              <Card className="px-4 py-3 sm:px-5 flex items-center justify-between border-slate-100 dark:border-white/[0.05] bg-white dark:bg-[#2F3349] shadow-sm">
                <label className="flex items-center space-x-2.5 cursor-pointer font-bold text-xs text-slate-700 dark:text-slate-200 select-none group">
                  <input
                    type="checkbox"
                    checked={isAllPageSelected}
                    onChange={handleToggleSelectAllPage}
                    aria-label={t('campaigns.selectCurrentPage', { count: currentPageGroups.length })}
                    className="w-4 h-4 rounded text-[#7367F0] focus:ring-[#7367F0] focus:ring-offset-0 border-slate-300 dark:border-white/20 dark:bg-[#25293C] cursor-pointer transition-all"
                  />
                  <span className="group-hover:text-[#7367F0] transition-colors">
                    {t('campaigns.selectCurrentPage', { count: currentPageGroups.length })}
                  </span>
                </label>

                {selectedIds.length > 0 ? (
                  <Badge variant="primary" className="text-[10px] font-mono px-2 py-0.5">
                    {t('campaigns.selectedBadgeCount', { selected: selectedIds.length, total: filteredGroups.length })}
                  </Badge>
                ) : (
                  <span className="text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium hidden sm:inline">
                    {t('campaignGroups.bulkSelectHint')}
                  </span>
                )}
              </Card>

              {/* Groups Grid or Filter Empty State */}
              {filteredGroups.length === 0 ? (
                <Card className="p-8 text-center space-y-3">
                  <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/[0.05] text-slate-400 flex items-center justify-center mx-auto">
                    <Filter className="w-5 h-5" />
                  </div>
                  <h4 className="text-sm font-extrabold text-slate-800 dark:text-white">
                    {t('campaignGroups.noSearchResults')}
                  </h4>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSearchQuery('');
                      setFilterType('ALL');
                    }}
                    className="text-xs font-bold cursor-pointer border-slate-300 dark:border-white/10"
                  >
                    <span>{t('campaignGroups.clearSearch') || 'Aramayı Temizle'}</span>
                  </Button>
                </Card>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {currentPageGroups.map((group) => (
                    <CampaignGroupCard
                      key={group.id}
                      group={group}
                      isSelected={selectedIds.includes(group.id)}
                      onToggleSelect={handleToggleSelect}
                      onLaunch={handleLaunchCampaign}
                      onView={() => setSelectedGroupId(group.id)}
                      onEdit={() => setEditingGroup(group)}
                      onDelete={handleDeleteGroup}
                    />
                  ))}
                </div>
              )}

              {/* Centralized Pagination */}
              {filteredGroups.length > 0 && (
                <Card className="overflow-hidden border-slate-100 dark:border-white/[0.05]">
                  <Pagination
                    currentPage={page}
                    totalItems={filteredGroups.length}
                    pageSize={pageSize}
                    onPageChange={(newPage) => setPage(newPage)}
                    onPageSizeChange={(newSize) => {
                      setPageSize(newSize);
                      setPage(1);
                    }}
                    pageSizeOptions={[10, 20, 50, 100]}
                  />
                </Card>
              )}
            </>
          )}
        </div>
      ) : (
        /* Create Group View */
        <CampaignGroupCreateView
          onCancel={() => setActiveTab('list')}
          onSuccess={() => {
            setActiveTab('list');
            fetchGroups();
            if (onRefreshStats) onRefreshStats();
          }}
        />
      )}

      {/* 1. Pure Read-Only View Modal */}
      <CampaignGroupDetailModal
        isOpen={selectedGroupId !== null}
        groupId={selectedGroupId}
        onClose={() => setSelectedGroupId(null)}
        onEdit={(group) => {
          setSelectedGroupId(null);
          setEditingGroup(group);
        }}
        onLaunchCampaign={(group) => {
          setSelectedGroupId(null);
          handleLaunchCampaign(group);
        }}
        allGroups={groups}
      />

      {/* 2. Focused Edit Group Modal (Metadata Only) */}
      <CampaignGroupEditModal
        isOpen={editingGroup !== null}
        group={editingGroup}
        onClose={() => setEditingGroup(null)}
        onSuccess={() => {
          setEditingGroup(null);
          fetchGroups();
          if (onRefreshStats) onRefreshStats();
        }}
      />
    </div>
  );
};
