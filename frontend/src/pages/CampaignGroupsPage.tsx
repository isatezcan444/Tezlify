import React, { useState, useEffect, useRef } from 'react';
import { 
  Users, 
  Send, 
  Eye, 
  Trash2, 
  Plus, 
  FolderKanban,
  UserMinus,
  Sparkles,
  Target,
  ListPlus,
  Play,
  Edit2,
  Search,
  Check,
  RefreshCw,
  X,
  Building2,
  Loader2
} from 'lucide-react';
import { 
  Card, 
  Button, 
  Badge, 
  PageHeader, 
  EmptyState, 
  Modal,
  Pagination,
  BulkActionToolbar,
  ToolbarActionButton
} from '../components/ui';
import { 
  FormField, 
  TextInput, 
  FormSection 
} from '../components/forms';
import { SectorAutocomplete, LocationMultiSelect } from '../features/leads/components';
import { CampaignGroupCard } from '../features/campaigns/components';
import { useToast } from '../context/ToastContext';
import { useI18n } from '../context/I18nContext';
import { ApiClient } from '../api/client';
import { CampaignGroup, CampaignGroupDetail, Lead } from '../types';
import { matchTurkishSearch } from '../lib/utils';

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

  // Create Form State
  const [createName, setCreateName] = useState('');
  const [createCategory, setCreateCategory] = useState('');
  const [createCity, setCreateCity] = useState('');
  const [createDistricts, setCreateDistricts] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // View Detail Modal State (Read-only)
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [groupDetail, setGroupDetail] = useState<CampaignGroupDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [viewSearchTerm, setViewSearchTerm] = useState('');

  // Edit Modal State (Focused Metadata Form)
  const [editingGroup, setEditingGroup] = useState<CampaignGroup | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editCity, setEditCity] = useState('');
  const [editDistricts, setEditDistricts] = useState<string[]>([]);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Add Leads from CRM Selector inside Edit Modal
  const [leadSearchQuery, setLeadSearchQuery] = useState('');
  const [isSearchingLeads, setIsSearchingLeads] = useState(false);
  const [leadSearchResults, setLeadSearchResults] = useState<Lead[]>([]);
  const [showLeadSuggestions, setShowLeadSuggestions] = useState(false);
  const [selectedLeadsToAdd, setSelectedLeadsToAdd] = useState<Lead[]>([]);
  const leadSearchContainerRef = useRef<HTMLDivElement>(null);
  const leadSearchRequestIdRef = useRef(0);

  // Close lead suggestions on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (leadSearchContainerRef.current && !leadSearchContainerRef.current.contains(e.target as Node)) {
        setShowLeadSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced search for leads from CRM
  useEffect(() => {
    if (!leadSearchQuery.trim()) {
      setLeadSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      const requestId = ++leadSearchRequestIdRef.current;
      setIsSearchingLeads(true);
      try {
        const res = await ApiClient.getLeads({
          search: leadSearchQuery.trim(),
          size: 8,
        });
        if (requestId !== leadSearchRequestIdRef.current) return;
        setLeadSearchResults(res.items || []);
        setShowLeadSuggestions(true);
      } catch (err) {
        console.error('Lead search error in edit group modal:', err);
      } finally {
        if (requestId === leadSearchRequestIdRef.current) setIsSearchingLeads(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [leadSearchQuery]);

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

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmitting(true);
      const locationParts = [createCity, createDistricts.join(', ')].filter(Boolean);
      const targetLocation = locationParts.length > 0 ? locationParts.join(' - ') : undefined;

      const created = await ApiClient.createCampaignGroup({
        name: createName.trim() || undefined,
        target_category: createCategory.trim() || undefined,
        target_location: targetLocation,
      });

      toast.success(t('campaignGroups.groupCreated', { name: created.name }));
      setActiveTab('list');
      setCreateName('');
      setCreateCategory('');
      setCreateCity('');
      setCreateDistricts([]);
      fetchGroups();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || 'Grup oluşturulamadı.');
    } finally {
      setIsSubmitting(false);
    }
  };

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

  const handleOpenDetail = async (groupId: number) => {
    setSelectedGroupId(groupId);
    setViewSearchTerm('');
    try {
      setIsDetailLoading(true);
      const detail = await ApiClient.getCampaignGroup(groupId);
      setGroupDetail(detail);
    } catch (err: any) {
      toast.error(err.message || 'Grup detayı alınamadı.');
      setSelectedGroupId(null);
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleOpenEdit = (group: CampaignGroup) => {
    setEditingGroup(group);
    setEditName(group.name);
    setEditCategory(group.target_category || '');
    setLeadSearchQuery('');
    setLeadSearchResults([]);
    setSelectedLeadsToAdd([]);
    setShowLeadSuggestions(false);

    if (group.target_location) {
      const parts = group.target_location.split(' - ');
      setEditCity(parts[0] || '');
      if (parts[1]) {
        setEditDistricts(parts[1].split(', ').filter(Boolean));
      } else {
        setEditDistricts([]);
      }
    } else {
      setEditCity('');
      setEditDistricts([]);
    }
  };

  const handleSaveGroupEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingGroup) return;

    try {
      setIsSavingEdit(true);
      const locationParts = [editCity, editDistricts.join(', ')].filter(Boolean);
      const targetLocation = locationParts.length > 0 ? locationParts.join(' - ') : undefined;

      const updated = await ApiClient.updateCampaignGroup(editingGroup.id, {
        name: editName.trim() || undefined,
        target_category: editCategory.trim() || undefined,
        target_location: targetLocation,
      });

      if (selectedLeadsToAdd.length > 0) {
        const leadIds = selectedLeadsToAdd.map((l) => l.id);
        const addRes = await ApiClient.addLeadsToCampaignGroup(editingGroup.id, leadIds);
        toast.success(addRes.message || `${selectedLeadsToAdd.length} işletme gruba eklendi.`);
      } else {
        toast.success(t('campaignGroups.groupUpdated', { name: updated.name }));
      }

      setEditingGroup(null);
      setSelectedLeadsToAdd([]);
      fetchGroups();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || 'Grup güncellenemedi.');
    } finally {
      setIsSavingEdit(false);
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
      title: `${t('campaignGroups.deleteGroupTitle')} (${count})`,
      message: t('campaignGroups.bulkDeleteConfirm', { count }),
      confirmText: t('common.delete') || 'Sil',
      variant: 'danger',
    });
    if (!confirmed) return;

    setIsBulkDeleting(true);
    try {
      const targetIds = selectAllMatching ? groups.map((g) => g.id) : selectedIds;
      const res = await ApiClient.bulkDeleteCampaignGroups(targetIds);
      toast.success(res.message || `${res.deleted_count} kampanya grubu silindi.`, t('common.success'));
      setSelectedIds([]);
      setSelectAllMatching(false);
      fetchGroups();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || 'Toplu silme işlemi başarısız oldu.', t('toast.errorTitle'));
    } finally {
      setIsBulkDeleting(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6 pb-16 select-none animate-fade-in">
      {/* Top Header & Mode Tabs (Identical Vuexy layout as CampaignsPage) */}
      <Card className="p-4 sm:p-6">
        <PageHeader
          title={t('campaignGroups.pageTitle')}
          subtitle={t('campaignGroups.pageSubtitle')}
          icon={FolderKanban}
          actions={
            <div className="flex items-center space-x-2">
              <Button
                variant={activeTab === 'list' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('list')}
                className={`cursor-pointer font-bold ${activeTab === 'list' ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30' : ''}`}
              >
                {t('campaignGroups.pageTitle')} ({groups.length})
              </Button>
              <Button
                variant={activeTab === 'create' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('create')}
                className={`space-x-1.5 font-bold cursor-pointer ${activeTab === 'create' ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30' : ''}`}
              >
                <ListPlus className="w-3.5 h-3.5" />
                <span>{t('campaignGroups.newGroupBtn')}</span>
              </Button>
            </div>
          }
        />
      </Card>

      {activeTab === 'list' ? (
        /* Campaign Groups List View */
        <div className="space-y-4">
          {groups.length === 0 ? (
            <Card className="p-8 text-center">
              <EmptyState
                icon={FolderKanban}
                title={t('campaignGroups.noGroupsTitle')}
                description={t('campaignGroups.noGroupsDesc')}
                action={{
                  label: t('campaignGroups.newGroupBtn'),
                  onClick: () => setActiveTab('create'),
                  icon: Plus,
                }}
              />
            </Card>
          ) : (
            <>
              {/* Centralized Bulk Action Toolbar (Identical to LeadCRMPage) */}
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
                    onView={handleOpenDetail}
                    onEdit={handleOpenEdit}
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
        /* Create Group View (Identical Vuexy Form layout as Campaign Builder) */
        <form onSubmit={handleCreateGroup} noValidate className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 space-y-6">
              <Card className="p-6 space-y-6">
                <FormSection
                  title={t('campaignGroups.modalCreateTitle')}
                  subtitle={t('campaignGroups.modalCreateSubtitle')}
                  icon={Target}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField label={t('campaignGroups.groupNameLabel')} required>
                      <TextInput
                        value={createName}
                        onChange={(e) => setCreateName(e.target.value)}
                        placeholder={t('campaignGroups.groupNamePlaceholder')}
                        required
                      />
                    </FormField>

                    <FormField label={t('campaignGroups.sectorLabel')}>
                      <SectorAutocomplete
                        value={createCategory}
                        onChange={setCreateCategory}
                        placeholder={t('leadFinder.keywordPlaceholder')}
                      />
                    </FormField>
                  </div>

                  <FormField label={t('campaignGroups.locationLabel')}>
                    <LocationMultiSelect
                      selectedCity={createCity}
                      selectedDistricts={createDistricts}
                      onCityChange={(city) => {
                        setCreateCity(city);
                        setCreateDistricts([]);
                      }}
                      onDistrictsChange={setCreateDistricts}
                    />
                  </FormField>
                </FormSection>

                {/* Form Actions */}
                <div className="pt-4 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-end space-x-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setActiveTab('list')}
                    className="cursor-pointer"
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="bg-[#7367F0] hover:bg-[#685dd8] text-white font-bold cursor-pointer shadow-md shadow-[#7367F0]/25 space-x-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>{isSubmitting ? t('common.loading') : t('campaignGroups.createBtn')}</span>
                  </Button>
                </div>
              </Card>
            </div>

            {/* Sidebar Guide Card */}
            <div className="lg:col-span-4 space-y-6">
              <Card className="p-6 space-y-4 border-slate-200/80 dark:border-white/[0.05]">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center font-bold">
                    <FolderKanban className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-800 dark:text-white">
                      {t('campaignGroups.guideTitle')}
                    </h4>
                    <p className="text-[11px] text-slate-400">{t('campaignGroups.guideSubtitle')}</p>
                  </div>
                </div>
                <p className="text-xs text-slate-500 dark:text-[#7E7F96] leading-relaxed">
                  {t('campaignGroups.guideDesc')}
                </p>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.05] text-[11px] text-slate-400 space-y-1">
                  <div className="font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-[#7367F0]" />
                    <span>{t('campaignGroups.guideQuickTitle')}</span>
                  </div>
                  <p>{t('campaignGroups.guideQuickDesc')}</p>
                </div>
              </Card>
            </div>
          </div>
        </form>
      )}

      {/* 1. Pure Read-Only View Modal */}
      <Modal
        isOpen={selectedGroupId !== null}
        onClose={() => {
          setSelectedGroupId(null);
          setGroupDetail(null);
          setViewSearchTerm('');
        }}
        title={groupDetail?.name || t('campaignGroups.viewGroupTitle')}
        subtitle={t('campaignGroups.viewGroupSubtitle')}
      >
        {isDetailLoading ? (
          <div className="p-8 text-center text-xs text-slate-400">
            {t('common.loading')}
          </div>
        ) : groupDetail ? (
          <div className="space-y-4">
            {/* Meta summary card */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.05] flex items-center justify-between">
              <div className="space-y-1">
                <span className="text-xs font-bold text-slate-800 dark:text-white block">
                  {groupDetail.name}
                </span>
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  {groupDetail.target_category && <span>{groupDetail.target_category}</span>}
                  {groupDetail.target_location && <span>• {groupDetail.target_location}</span>}
                </div>
              </div>
              <div className="text-right">
                <Badge variant="primary" className="text-[10px] font-mono">
                  {groupDetail.total_leads_count} {t('campaignGroups.businesses')}
                </Badge>
                <div className="text-[11px] text-[#28C76F] font-semibold mt-1">
                  {groupDetail.whatsapp_eligible_count} {t('campaignGroups.whatsappEligible')}
                </div>
              </div>
            </div>

            {/* In-group search filter */}
            {groupDetail.leads.length > 0 && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-400" />
                <input
                  type="text"
                  value={viewSearchTerm}
                  onChange={(e) => setViewSearchTerm(e.target.value)}
                  placeholder={t('campaignGroups.searchInGroupPlaceholder')}
                  className="w-full pl-9 pr-4 py-2 rounded-xl bg-slate-50 dark:bg-white/[0.04] border border-slate-200 dark:border-white/10 text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:border-[#7367F0]"
                />
              </div>
            )}

            {/* Purely Read-only Leads List */}
            <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-100 dark:border-white/10 divide-y divide-slate-100 dark:divide-white/[0.05]">
              {groupDetail.leads.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  {t('campaignGroups.noLeadsInGroup')}
                </div>
              ) : (
                groupDetail.leads
                  .filter((lead) => {
                    if (!viewSearchTerm.trim()) return true;
                    return (
                      matchTurkishSearch(lead.name, viewSearchTerm.trim()) ||
                      matchTurkishSearch(lead.phone, viewSearchTerm.trim()) ||
                      matchTurkishSearch(lead.phone_e164, viewSearchTerm.trim()) ||
                      matchTurkishSearch(lead.category, viewSearchTerm.trim()) ||
                      matchTurkishSearch(lead.city, viewSearchTerm.trim())
                    );
                  })
                  .map((lead) => (
                    <div
                      key={lead.id}
                      className="p-3 flex items-center justify-between hover:bg-slate-50/80 dark:hover:bg-white/[0.02] transition-colors"
                    >
                      <div className="min-w-0 pr-3">
                        <div className="text-xs font-bold text-slate-800 dark:text-white truncate">
                          {lead.name}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate flex items-center gap-2">
                          <span>{lead.phone || lead.phone_e164 || '—'}</span>
                          {lead.category && <span>• {lead.category}</span>}
                          {lead.city && <span>• {lead.city}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {lead.is_whatsapp_eligible ? (
                          <Badge variant="success" className="text-[9px]">WhatsApp</Badge>
                        ) : (
                          <Badge variant="default" className="text-[9px]">No WA</Badge>
                        )}
                      </div>
                    </div>
                  ))
              )}
            </div>

            {/* Modal Bottom Actions */}
            <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between">
              <Button
                variant="outline"
                onClick={() => {
                  setSelectedGroupId(null);
                  setGroupDetail(null);
                  setViewSearchTerm('');
                }}
                className="text-xs cursor-pointer"
              >
                {t('common.close')}
              </Button>

              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    const targetGroup = groups.find((g) => g.id === groupDetail.id);
                    setSelectedGroupId(null);
                    setGroupDetail(null);
                    if (targetGroup) handleOpenEdit(targetGroup);
                  }}
                  className="text-xs font-bold border-[#7367F0]/30 text-[#7367F0] hover:bg-[#7367F0]/10 cursor-pointer space-x-1.5"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                  <span>{t('campaignGroups.editGroup')}</span>
                </Button>

                <Button
                  onClick={() => {
                    const targetGroup = groups.find((g) => g.id === groupDetail.id) || {
                      id: groupDetail.id,
                      name: groupDetail.name,
                      target_category: groupDetail.target_category,
                      total_leads_count: groupDetail.total_leads_count,
                      whatsapp_eligible_count: groupDetail.whatsapp_eligible_count,
                      created_at: groupDetail.created_at,
                      updated_at: groupDetail.updated_at,
                    };
                    setSelectedGroupId(null);
                    setGroupDetail(null);
                    handleLaunchCampaign(targetGroup);
                  }}
                  className="bg-[#7367F0] hover:bg-[#685dd8] text-white text-xs font-bold px-4 py-2 rounded-xl shadow-md shadow-[#7367F0]/25 flex items-center gap-1.5 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>{t('campaignGroups.startCampaignBtn')}</span>
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 2. Focused Edit Group Modal (Metadata Only) */}
      <Modal
        isOpen={editingGroup !== null}
        onClose={() => {
          setEditingGroup(null);
        }}
        title={`${t('campaignGroups.editGroup')} — ${editingGroup?.name || ''}`}
        subtitle={t('campaignGroups.editGroupSubtitle')}
      >
        {editingGroup ? (
          <form onSubmit={handleSaveGroupEdit} className="space-y-5">
            {/* Group Metadata Form */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.05] space-y-3">
              <h5 className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5 text-[#7367F0]" />
                <span>{t('campaignGroups.modalCreateTitle')}</span>
              </h5>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label={t('campaignGroups.groupNameLabel')} required>
                  <TextInput
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder={t('campaignGroups.groupNamePlaceholder')}
                    required
                  />
                </FormField>
                <FormField label={t('campaignGroups.sectorLabel')}>
                  <SectorAutocomplete
                    value={editCategory}
                    onChange={setEditCategory}
                    placeholder={t('leadFinder.keywordPlaceholder')}
                  />
                </FormField>
              </div>
              <FormField label={t('campaignGroups.locationLabel')}>
                <LocationMultiSelect
                  selectedCity={editCity}
                  selectedDistricts={editDistricts}
                  onCityChange={(city) => {
                    setEditCity(city);
                    setEditDistricts([]);
                  }}
                  onDistrictsChange={setEditDistricts}
                />
              </FormField>
            </div>

            {/* 2. Add Leads from CRM Selector */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.05] space-y-3">
              <div className="flex items-center justify-between">
                <h5 className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-[#7367F0]" />
                  <span>{t('campaignGroups.addLeadsToGroupTitle')}</span>
                </h5>
                {selectedLeadsToAdd.length > 0 && (
                  <Badge variant="primary" className="text-[10px] font-mono px-2 py-0.5">
                    {selectedLeadsToAdd.length} {t('common.selected')}
                  </Badge>
                )}
              </div>

              <div ref={leadSearchContainerRef} className="relative">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={leadSearchQuery}
                    onChange={(e) => setLeadSearchQuery(e.target.value)}
                    onFocus={() => {
                      if (leadSearchResults.length > 0) setShowLeadSuggestions(true);
                    }}
                    placeholder={t('campaignGroups.searchLeadsPlaceholder')}
                    className="w-full pl-9 pr-8 py-2 text-xs rounded-xl bg-white dark:bg-[#2F3349] border border-slate-200/80 dark:border-white/[0.08] focus:border-[#7367F0] focus:ring-1 focus:ring-[#7367F0] outline-none transition-all placeholder:text-slate-400 text-slate-800 dark:text-white"
                  />
                  {isSearchingLeads ? (
                    <Loader2 className="w-3.5 h-3.5 text-[#7367F0] animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
                  ) : leadSearchQuery ? (
                    <button
                      type="button"
                      onClick={() => {
                        setLeadSearchQuery('');
                        setLeadSearchResults([]);
                        setShowLeadSuggestions(false);
                      }}
                      className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer p-0.5"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                </div>

                {/* Dropdown Suggestions */}
                {showLeadSuggestions && leadSearchResults.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1.5 bg-white dark:bg-[#2F3349] border border-slate-200/80 dark:border-white/[0.08] rounded-xl shadow-2xl z-50 max-h-52 overflow-y-auto divide-y divide-slate-100 dark:divide-white/[0.04] animate-scale-in">
                    {leadSearchResults.map((lead) => {
                      const isAlreadySelected = selectedLeadsToAdd.some((l) => l.id === lead.id);
                      return (
                        <div
                          key={lead.id}
                          onClick={() => {
                            if (isAlreadySelected) {
                              setSelectedLeadsToAdd((prev) => prev.filter((l) => l.id !== lead.id));
                            } else {
                              setSelectedLeadsToAdd((prev) => [...prev, lead]);
                            }
                          }}
                          className={`p-2.5 flex items-center justify-between gap-2.5 hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors cursor-pointer text-xs ${
                            isAlreadySelected ? 'bg-[#7367F0]/10 dark:bg-[#7367F0]/15' : ''
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-slate-800 dark:text-white truncate">
                                {lead.name}
                              </span>
                              {lead.is_whatsapp_eligible ? (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#28C76F]/15 text-[#28C76F] font-bold shrink-0">
                                  WA
                                </span>
                              ) : null}
                            </div>
                            <div className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                              <span className="font-mono">{lead.phone_e164 || lead.phone || t('leads.noPhone')}</span>
                              {lead.category && <span>• {lead.category}</span>}
                              {lead.city && <span>• {lead.city}</span>}
                            </div>
                          </div>

                          <div className="shrink-0">
                            {isAlreadySelected ? (
                              <span className="w-5 h-5 rounded-md bg-[#7367F0] text-white flex items-center justify-center shadow-xs">
                                <Check className="w-3.5 h-3.5 stroke-[3]" />
                              </span>
                            ) : (
                              <span className="w-5 h-5 rounded-md border border-slate-300 dark:border-white/20 flex items-center justify-center text-slate-400 hover:border-[#7367F0] hover:text-[#7367F0]">
                                <Plus className="w-3 h-3" />
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Selected Leads Chips */}
              {selectedLeadsToAdd.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap pt-1 max-h-24 overflow-y-auto">
                  {selectedLeadsToAdd.map((lead) => (
                    <span
                      key={lead.id}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#7367F0]/10 text-[#7367F0] text-xs font-semibold border border-[#7367F0]/20 animate-fade-in"
                    >
                      <Building2 className="w-3 h-3 shrink-0" />
                      <span className="truncate max-w-[140px]">{lead.name}</span>
                      <button
                        type="button"
                        onClick={() => setSelectedLeadsToAdd((prev) => prev.filter((l) => l.id !== lead.id))}
                        className="hover:text-rose-500 rounded p-0.5 transition-colors cursor-pointer"
                        title={t('common.delete')}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Modal Bottom Actions */}
            <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-end space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditingGroup(null);
                }}
                className="text-xs cursor-pointer"
              >
                {t('common.cancel')}
              </Button>

              <Button
                type="submit"
                disabled={isSavingEdit}
                className="bg-[#7367F0] hover:bg-[#685dd8] text-white text-xs font-bold px-4 py-2 rounded-xl shadow-md shadow-[#7367F0]/25 cursor-pointer"
              >
                {isSavingEdit ? t('common.loading') : t('campaignGroups.editGroupBtn')}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
};
