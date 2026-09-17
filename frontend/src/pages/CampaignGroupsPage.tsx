import React, { useState, useEffect } from 'react';
import { 
  Users, 
  Trash2, 
  Plus, 
  FolderKanban,
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

interface CampaignGroupsPageProps {
  onNavigate: (tab: string, prefillData?: any) => void;
  onRefreshStats?: () => void;
}

export const CampaignGroupsPage: React.FC<CampaignGroupsPageProps> = ({
  onNavigate,
  onRefreshStats,
}) => {
  const { t } = useI18n();
  const toast = useToast();

  const [groups, setGroups] = useState<CampaignGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'list' | 'create'>('list');

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

  const fetchGroups = async () => {
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
  };

  useEffect(() => {
    fetchGroups();
  }, []);

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
      toast.error(err.message || 'Grup silinemedi.');
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

  const currentPageGroups = groups.slice((page - 1) * pageSize, page * pageSize);
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
    setSelectedIds(groups.map((g) => g.id));
    setSelectAllMatching(true);
  };

  const handleClearSelection = () => {
    setSelectedIds([]);
    setSelectAllMatching(false);
  };

  const handleBulkDelete = async () => {
    const count = selectAllMatching ? groups.length : selectedIds.length;
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
      const targetIds = selectAllMatching ? groups.map((g) => g.id) : selectedIds;
      const res = await ApiClient.bulkDeleteCampaignGroups(targetIds);
      toast.success(res.message || `${res.deleted_count} grup silindi.`);
      setSelectedIds([]);
      setSelectAllMatching(false);
      fetchGroups();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || 'Toplu silme işlemi başarısız oldu.');
    } finally {
      setIsBulkDeleting(false);
    }
  };

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
              {/* Centralized Bulk Action Toolbar (Identical to LeadCRMPage & CampaignsPage) */}
              <BulkActionToolbar
                selectedCount={selectedIds.length}
                totalCount={groups.length}
                selectAllMatching={selectAllMatching}
                onSelectAllMatching={groups.length > selectedIds.length ? handleSelectAllMatching : undefined}
                onClearSelection={handleClearSelection}
                actions={
                  <ToolbarActionButton tone="danger" onClick={handleBulkDelete} disabled={isBulkDeleting}>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isBulkDeleting ? t('common.loading') : t('campaignGroups.bulkDeleteSelected', { count: selectedIds.length })}</span>
                  </ToolbarActionButton>
                }
              />

              {/* Selection & Controls Bar (Slim Aesthetic Card Layout) */}
              <Card className="px-4 py-3 sm:px-5 flex items-center justify-between border-slate-100 dark:border-white/[0.05] bg-white dark:bg-[#2F3349] shadow-sm">
                <label className="flex items-center space-x-2.5 cursor-pointer font-bold text-xs text-slate-700 dark:text-slate-200 select-none group">
                  <input
                    type="checkbox"
                    checked={isAllPageSelected}
                    onChange={handleToggleSelectAllPage}
                    className="w-4 h-4 rounded text-[#7367F0] focus:ring-[#7367F0] focus:ring-offset-0 border-slate-300 dark:border-white/20 dark:bg-[#25293C] cursor-pointer transition-all"
                  />
                  <span className="group-hover:text-[#7367F0] transition-colors">
                    Bu Sayfadakileri Seç ({currentPageGroups.length})
                  </span>
                </label>

                {selectedIds.length > 0 ? (
                  <Badge variant="primary" className="text-[10px] font-mono px-2 py-0.5">
                    {selectedIds.length} / {groups.length} Seçildi
                  </Badge>
                ) : (
                  <span className="text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium hidden sm:inline">
                    Toplu işlem için grupları seçebilirsiniz
                  </span>
                )}
              </Card>

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

              {/* Centralized Pagination matching LeadCRMPage & CampaignsPage */}
              {groups.length > 0 && (
                <Card className="overflow-hidden border-slate-100 dark:border-white/[0.05]">
                  <Pagination
                    currentPage={page}
                    totalItems={groups.length}
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
