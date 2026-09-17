import React, { useState, useEffect, useRef } from 'react';
import { 
  Users, 
  Search, 
  Download, 
  Plus, 
  Trash2, 
  Phone, 
  Star, 
  MapPin, 
  ShieldAlert, 
  Globe, 
  Loader2, 
  X, 
  RotateCcw,
  CheckSquare,
  Square,
  MinusSquare,
  Eye,
  Building2,
  FolderPlus,
  FolderKanban,
  MoreVertical
} from 'lucide-react';
import { 
  Button, 
  IconButton,
  Badge, 
  Avatar,
  Card, 
  PageHeader, 
  BulkActionToolbar, 
  Modal, 
  EmptyState, 
  Pagination,
  Chip,
  WhatsAppIcon,
  Dropdown
} from '../components/ui';
import { SearchInput, Select } from '../components/forms';
import { BusinessCell } from '../components/data-display';
import { LeadDetailDrawer, LocationMultiSelect, CategoryMultiSelect } from '../features/leads/components';
import { ApiClient } from '../api/client';
import { Lead, LeadStatus, CampaignGroup } from '../types';
import { useToast } from '../context/ToastContext';
import { useI18n } from '../context/I18nContext';

interface LeadCRMPageProps {
  onRefreshStats: () => void;
}

export const LeadCRMPage: React.FC<LeadCRMPageProps> = ({ onRefreshStats }) => {
  const toast = useToast();
  const { t } = useI18n();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  
  // Search & Filter State
  const [search, setSearch] = useState('');
  const [selectedCity, setSelectedCity] = useState('');
  const [selectedDistricts, setSelectedDistricts] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [waOnly, setWaOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  // Detail Drawer State
  const [selectedLeadForDrawer, setSelectedLeadForDrawer] = useState<Lead | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [drawerInitialTab, setDrawerInitialTab] = useState<'overview' | 'chat'>('overview');

  // Selection state (Gmail style)
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  // Add to Campaign Group Modal State
  const [isAddToGroupModalOpen, setIsAddToGroupModalOpen] = useState(false);
  const [campaignGroups, setCampaignGroups] = useState<CampaignGroup[]>([]);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [selectedTargetGroupId, setSelectedTargetGroupId] = useState<number | 'NEW'>('NEW');
  const [newGroupName, setNewGroupName] = useState('');
  const [isAddingToGroup, setIsAddingToGroup] = useState(false);
  const [singleLeadForGroup, setSingleLeadForGroup] = useState<Lead | null>(null);

  // Delete Modal State
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [leadToDelete, setLeadToDelete] = useState<Lead | null>(null);
  const [isBulkDelete, setIsBulkDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Blacklist Modal State
  const [isBlacklistModalOpen, setIsBlacklistModalOpen] = useState(false);
  const [leadToBlacklist, setLeadToBlacklist] = useState<Lead | null>(null);
  const [isBulkBlacklist, setIsBulkBlacklist] = useState(false);
  const [blacklistReason, setBlacklistReason] = useState('USER_REQUEST');
  const [isBlacklisting, setIsBlacklisting] = useState(false);

  // Add Lead Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // New Lead Form State
  const [newLeadName, setNewLeadName] = useState('');
  const [newLeadPhone, setNewLeadPhone] = useState('');
  const [newLeadCategory, setNewLeadCategory] = useState('');
  const [newLeadCity, setNewLeadCity] = useState('');
  const [newLeadDistrict, setNewLeadDistrict] = useState('');
  const [formError, setFormError] = useState('');

  const fetchLeadsRequestIdRef = useRef(0);

  const fetchLeads = async () => {
    const requestId = ++fetchLeadsRequestIdRef.current;
    setLoading(true);
    try {
      const data = await ApiClient.getLeads({
        page,
        size: pageSize,
        search: search.trim() || undefined,
        city: selectedCity || undefined,
        districts: selectedDistricts.length > 0 ? selectedDistricts : undefined,
        categories: selectedCategories.length > 0 ? selectedCategories : undefined,
        status: statusFilter || undefined,
        whatsapp_eligible_only: waOnly,
      });
      if (requestId !== fetchLeadsRequestIdRef.current) return;
      setLeads(data.items);
      setTotal(data.total);
    } catch (err) {
      console.error('Error fetching leads:', err);
    } finally {
      if (requestId === fetchLeadsRequestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeads();
  }, [page, pageSize, search, selectedCity, selectedDistricts, selectedCategories, statusFilter, waOnly]);

  // Clear selection on page/filter change unless all-matching is active
  useEffect(() => {
    if (!selectAllMatching) {
      setSelectedIds([]);
    }
  }, [page, pageSize, search, selectedCity, selectedDistricts, selectedCategories, statusFilter, waOnly]);

  // --- Gmail-style Checkbox logic ---
  const currentPageIds = leads.map((l) => l.id);
  const isAllCurrentPageSelected =
    leads.length > 0 && currentPageIds.every((id) => selectedIds.includes(id));
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

  // --- Drawer Opener ---
  const handleOpenLeadDrawer = (lead: Lead, tab: 'overview' | 'chat' = 'overview') => {
    setSelectedLeadForDrawer(lead);
    setDrawerInitialTab(tab);
    setIsDrawerOpen(true);
  };

  // --- Delete Modal Handlers ---
  const handleOpenSingleDelete = (lead: Lead) => {
    setLeadToDelete(lead);
    setIsBulkDelete(false);
    setIsDeleteModalOpen(true);
  };

  const handleOpenBulkDelete = () => {
    setLeadToDelete(null);
    setIsBulkDelete(true);
    setIsDeleteModalOpen(true);
  };

  const handleConfirmDelete = async () => {
    setIsDeleting(true);
    try {
      if (isBulkDelete) {
        if (selectAllMatching) {
          await ApiClient.bulkDeleteLeads({
            delete_all_matching: true,
            search: search || undefined,
            city: selectedCity || undefined,
            districts: selectedDistricts.length > 0 ? selectedDistricts : undefined,
            categories: selectedCategories.length > 0 ? selectedCategories : undefined,
            status: statusFilter || undefined,
            whatsapp_eligible_only: waOnly,
          });
          toast.success(t('leads.bulkDeleteAllSuccess', { total }), t('common.success'));
        } else {
          await ApiClient.bulkDeleteLeads({ lead_ids: selectedIds });
          toast.success(t('leads.bulkDeleteSuccess', { count: selectedIds.length }), t('common.success'));
        }
        setSelectedIds([]);
        setSelectAllMatching(false);
      } else if (leadToDelete) {
        await ApiClient.deleteLead(leadToDelete.id);
        toast.success(t('leads.deleteSuccess', { name: leadToDelete.name }), t('common.success'));
        setLeadToDelete(null);
      }
      setIsDeleteModalOpen(false);
      fetchLeads();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    } finally {
      setIsDeleting(false);
    }
  };

  // --- Add to Campaign Group Handlers ---
  const handleOpenAddToGroup = async (lead?: Lead) => {
    if (lead) {
      setSingleLeadForGroup(lead);
    } else {
      setSingleLeadForGroup(null);
    }
    setNewGroupName('');
    setIsAddToGroupModalOpen(true);
    try {
      setIsLoadingGroups(true);
      const groups = await ApiClient.getCampaignGroups();
      setCampaignGroups(groups);
      if (groups.length > 0) {
        setSelectedTargetGroupId(groups[0].id);
      } else {
        setSelectedTargetGroupId('NEW');
      }
    } catch (err) {
      console.error('Error loading campaign groups:', err);
      setSelectedTargetGroupId('NEW');
    } finally {
      setIsLoadingGroups(false);
    }
  };

  const handleConfirmAddToGroup = async () => {
    setIsAddingToGroup(true);
    try {
      let targetLeadIds: number[] = [];
      if (singleLeadForGroup) {
        targetLeadIds = [singleLeadForGroup.id];
      } else if (selectAllMatching) {
        const allData = await ApiClient.getLeads({
          size: 10000,
          search: search.trim() || undefined,
          city: selectedCity || undefined,
          districts: selectedDistricts.length > 0 ? selectedDistricts : undefined,
          categories: selectedCategories.length > 0 ? selectedCategories : undefined,
          status: statusFilter || undefined,
          whatsapp_eligible_only: waOnly,
        });
        targetLeadIds = allData.items.map((l) => l.id);
      } else {
        targetLeadIds = selectedIds;
      }

      if (targetLeadIds.length === 0) {
        toast.warning(t('leads.noLeadsToAdd'));
        return;
      }

      if (selectedTargetGroupId === 'NEW') {
        const created = await ApiClient.createCampaignGroup({
          name: newGroupName.trim() || undefined,
          lead_ids: targetLeadIds,
        });
        toast.success(t('leads.addedToGroupSuccess', { count: targetLeadIds.length, name: created.name }));
      } else {
        const res = await ApiClient.addLeadsToCampaignGroup(selectedTargetGroupId, targetLeadIds);
        const grp = campaignGroups.find((g) => g.id === selectedTargetGroupId);
        toast.success(t('leads.addedToGroupSuccess', { count: targetLeadIds.length, name: grp?.name || 'Grup' }));
      }

      setIsAddToGroupModalOpen(false);
      setSingleLeadForGroup(null);
      setSelectedIds([]);
      setSelectAllMatching(false);
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || 'İşletmeler gruba eklenemedi.');
    } finally {
      setIsAddingToGroup(false);
    }
  };

  // --- Blacklist Modal Handlers ---
  const handleOpenSingleBlacklist = (lead: Lead) => {
    setLeadToBlacklist(lead);
    setIsBulkBlacklist(false);
    setBlacklistReason('USER_REQUEST');
    setIsBlacklistModalOpen(true);
  };

  const handleOpenBulkBlacklist = () => {
    setLeadToBlacklist(null);
    setIsBulkBlacklist(true);
    setBlacklistReason('USER_REQUEST');
    setIsBlacklistModalOpen(true);
  };

  const handleConfirmBlacklist = async () => {
    setIsBlacklisting(true);
    try {
      if (isBulkBlacklist) {
        const payload = selectAllMatching
          ? {
              blacklist_all_matching: true,
              search: search || undefined,
              city: selectedCity || undefined,
              districts: selectedDistricts.length > 0 ? selectedDistricts : undefined,
              categories: selectedCategories.length > 0 ? selectedCategories : undefined,
              status: statusFilter || undefined,
              whatsapp_eligible_only: waOnly,
              reason: blacklistReason,
            }
          : {
              lead_ids: selectedIds,
              reason: blacklistReason,
            };

        const res = await ApiClient.bulkBlacklistLeads(payload);
        toast.success(t('blacklist.bulkBlacklistSuccess', { count: res.blacklisted_count }), t('common.success'));
        setSelectedIds([]);
        setSelectAllMatching(false);
      } else if (leadToBlacklist) {
        const phone = leadToBlacklist.phone_e164 || leadToBlacklist.phone;
        if (!phone) {
          toast.error(t('blacklist.noPhoneInLead'), t('common.error'));
          setIsBlacklisting(false);
          return;
        }
        await ApiClient.addToBlacklist(phone, blacklistReason);
        toast.success(t('blacklist.addedSuccess', { name: leadToBlacklist.name, phone }), t('common.success'));
        setLeadToBlacklist(null);
      }
      setIsBlacklistModalOpen(false);
      fetchLeads();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message, t('toast.errorTitle'));
    } finally {
      setIsBlacklisting(false);
    }
  };

  const getStatusLabel = (status: LeadStatus) => {
    switch (status) {
      case 'NEW': return t('leads.statusNew');
      case 'CONTACTED': return t('leads.statusContacted');
      case 'REPLIED': return t('leads.statusReplied');
      case 'INTERESTED': return t('leads.statusInterested');
      case 'UNSUBSCRIBED': return t('leads.statusUnsubscribed');
      case 'INVALID_NUMBER': return t('leads.statusInvalid');
      default: return status;
    }
  };

  // --- Status & Add Lead Handlers ---
  const handleStatusChange = async (leadId: number, newStatus: LeadStatus) => {
    try {
      await ApiClient.updateLead(leadId, { status: newStatus });
      setLeads(leads.map((l) => (l.id === leadId ? { ...l, status: newStatus } : l)));
      if (selectedLeadForDrawer && selectedLeadForDrawer.id === leadId) {
        setSelectedLeadForDrawer({ ...selectedLeadForDrawer, status: newStatus });
      }
      toast.success(`${t('common.status')}: "${getStatusLabel(newStatus)}"`, t('common.status'));
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('common.error'));
    }
  };

  const handleAddLead = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!newLeadName || !newLeadPhone) {
      setFormError(t('leads.leadNameRequired') + ' & ' + t('leads.leadPhoneRequired'));
      return;
    }

    try {
      await ApiClient.createLead({
        name: newLeadName,
        phone: newLeadPhone,
        category: newLeadCategory || 'Genel',
        city: newLeadCity,
        district: newLeadDistrict,
      });

      toast.success(`${newLeadName} ${t('common.success').toLowerCase()}`, t('leads.addNewLeadTitle'));
      setIsAddModalOpen(false);
      setNewLeadName('');
      setNewLeadPhone('');
      setNewLeadCategory('');
      setNewLeadCity('');
      setNewLeadDistrict('');
      fetchLeads();
      onRefreshStats();
    } catch (err: any) {
      setFormError(err.message || t('common.error'));
    }
  };

  const getGoogleMapsUrl = (lead: Lead) => {
    if ((lead as any).maps_url) return (lead as any).maps_url;
    if ((lead as any).google_maps_url) return (lead as any).google_maps_url;
    if (lead.custom_data?.google_maps_url) return lead.custom_data.google_maps_url;
    if (lead.custom_data?.maps_url) return lead.custom_data.maps_url;
    const query = [lead.name, lead.address || [lead.district, lead.city].filter(Boolean).join(', ')].filter(Boolean).join(' ');
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  };

  const hasActiveFilters = Boolean(
    search || selectedCity || selectedDistricts.length > 0 || selectedCategories.length > 0 || statusFilter || waOnly
  );

  const resetAllFilters = () => {
    setSearch('');
    setSelectedCity('');
    setSelectedDistricts([]);
    setSelectedCategories([]);
    setStatusFilter('');
    setWaOnly(false);
    setPage(1);
  };

  const selectedCount = selectAllMatching ? total : selectedIds.length;

  return (
    <div className="space-y-4 sm:space-y-6 pb-16 select-none animate-fade-in">
      {/* Top Action Bar & Filter Header */}
      <Card className="p-4 sm:p-6">
        <PageHeader
          title={`${t('leads.title')} (${total})`}
          subtitle={t('titles.leadsSub')}
          icon={Users}
          actions={
            <>
              <Button
                onClick={() => setIsAddModalOpen(true)}
                size="sm"
                className="space-x-1.5 font-bold shadow-md shadow-[#7367F0]/30 w-full sm:w-auto justify-center cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>{t('leads.addLead')}</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => ApiClient.exportCsv({ 
                  search, 
                  city: selectedCity, 
                  districts: selectedDistricts,
                  categories: selectedCategories,
                  status: statusFilter 
                })}
                className="space-x-1.5 flex-1 sm:flex-initial justify-center cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{t('leads.exportCsv')}</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => ApiClient.exportExcel({ 
                  search, 
                  city: selectedCity, 
                  districts: selectedDistricts,
                  categories: selectedCategories,
                  status: statusFilter 
                })}
                className="space-x-1.5 flex-1 sm:flex-initial justify-center cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-[#28C76F]" />
                <span>Excel (.xlsx)</span>
              </Button>
            </>
          }
        />

        {/* Filter Controls Row */}
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 pt-4 border-t border-slate-100 dark:border-white/[0.06] items-center">
          {/* Search Box: 4 cols */}
          <div className="lg:col-span-4">
            <SearchInput
              value={search}
              onChange={(val) => {
                setSearch(val);
                setPage(1);
              }}
              placeholder={t('leads.searchPlaceholder')}
            />
          </div>

          {/* Location Multi-Select (City + Districts): 3 cols */}
          <div className="lg:col-span-3 relative">
            <LocationMultiSelect
              selectedCity={selectedCity}
              selectedDistricts={selectedDistricts}
              onChange={(city, districts) => {
                setSelectedCity(city);
                setSelectedDistricts(districts);
                setPage(1);
              }}
            />
          </div>

          {/* Category Multi-Select: 3 cols */}
          <div className="lg:col-span-3 relative">
            <CategoryMultiSelect
              selectedCategories={selectedCategories}
              onChange={(cats) => {
                setSelectedCategories(cats);
                setPage(1);
              }}
            />
          </div>

          {/* Status Filter: 2 cols */}
          <div className="lg:col-span-2">
            <Select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              options={[
                { value: '', label: t('leads.filterByStatus') },
                { value: 'NEW', label: t('leads.statusNew') },
                { value: 'CONTACTED', label: t('leads.statusContacted') },
                { value: 'REPLIED', label: t('leads.statusReplied') },
                { value: 'INTERESTED', label: t('leads.statusInterested') },
                { value: 'UNSUBSCRIBED', label: t('leads.statusUnsubscribed') },
                { value: 'INVALID_NUMBER', label: t('leads.statusInvalid') },
              ]}
            />
          </div>
        </div>

        {/* Second Row: WhatsApp Only Toggle & Active Filter Tags & Reset */}
        <div className="mt-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-3 border-t border-slate-100 dark:border-white/[0.04] text-xs">
          <div className="flex items-center space-x-2 flex-wrap gap-y-1.5">
            <label className="flex items-center space-x-2 text-xs text-slate-700 dark:text-slate-200 font-semibold cursor-pointer select-none bg-slate-50 dark:bg-white/[0.03] px-3 py-1.5 rounded-lg border border-slate-200/60 dark:border-white/[0.06]">
              <input
                type="checkbox"
                checked={waOnly}
                onChange={(e) => {
                  setWaOnly(e.target.checked);
                  setPage(1);
                }}
                className="rounded border-slate-300 dark:border-slate-700 text-[#7367F0] focus:ring-0"
              />
              <span>{t('leads.whatsappOnly')}</span>
            </label>

            {/* Active Filters Summary Chips */}
            {selectedCity && (
              <Chip
                label={selectedCity}
                variant="primary"
                size="sm"
                onRemove={() => {
                  setSelectedCity('');
                  setSelectedDistricts([]);
                  setPage(1);
                }}
              />
            )}

            {selectedDistricts.length > 0 && (
              <Chip
                label={`${selectedDistricts.length} ${t('common.location')}: ${selectedDistricts.slice(0, 2).join(', ')}${selectedDistricts.length > 2 ? '...' : ''}`}
                variant="default"
                size="sm"
                onRemove={() => {
                  setSelectedDistricts([]);
                  setPage(1);
                }}
              />
            )}

            {selectedCategories.length > 0 && (
              <Chip
                label={`${selectedCategories.length} ${t('common.category')}: ${selectedCategories.slice(0, 2).join(', ')}${selectedCategories.length > 2 ? '...' : ''}`}
                variant="info"
                size="sm"
                onRemove={() => {
                  setSelectedCategories([]);
                  setPage(1);
                }}
              />
            )}
          </div>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={resetAllFilters}
              className="text-xs font-bold text-slate-400 hover:text-[#EA5455] flex items-center gap-1.5 self-start sm:self-auto transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('leads.resetFilters')}</span>
            </button>
          )}
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
          <>
            <button
              type="button"
              onClick={() => handleOpenAddToGroup()}
              className="px-3 py-1.5 rounded-lg bg-[#7367F0] hover:bg-[#685dd8] text-white font-bold text-xs flex items-center gap-1.5 shadow-md transition-all active:scale-95 cursor-pointer"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>{t('leads.bulkAddToGroup')}</span>
            </button>

            <button
              type="button"
              onClick={handleOpenBulkBlacklist}
              className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white font-bold text-xs flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer"
            >
              <ShieldAlert className="w-3.5 h-3.5 text-[#FF9F43]" />
              <span>{t('leads.bulkBlacklist')}</span>
            </button>

            <button
              type="button"
              onClick={handleOpenBulkDelete}
              className="px-3 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-600 text-white font-bold text-xs flex items-center gap-1.5 shadow-md transition-all active:scale-95 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{selectAllMatching ? t('leads.bulkDeleteAll', { total }) : t('leads.bulkDelete', { count: selectedCount })}</span>
            </button>
          </>
        }
      />

      {/* Leads Table Card */}
      <Card className="overflow-hidden shadow-sm">
        <div className="overflow-x-auto min-w-full">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200/80 dark:border-white/[0.08] bg-slate-50/75 dark:bg-white/[0.02] text-slate-500 dark:text-[#7E7F96] font-bold uppercase tracking-wider text-[11px]">
                {/* Select All Checkbox Header */}
                <th className="py-3.5 px-4 w-10 text-center">
                  <button
                    type="button"
                    onClick={handleToggleSelectAllPage}
                    className="p-1 rounded hover:bg-slate-200 dark:hover:bg-white/[0.08] text-slate-500 dark:text-slate-300 transition-colors cursor-pointer"
                    title={isAllCurrentPageSelected ? t('common.clearSelection') : t('common.selectAll')}
                  >
                    {selectAllMatching || isAllCurrentPageSelected ? (
                      <CheckSquare className="w-4 h-4 text-[#7367F0]" />
                    ) : isSomeCurrentPageSelected ? (
                      <MinusSquare className="w-4 h-4 text-[#7367F0]" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-400" />
                    )}
                  </button>
                </th>
                <th className="py-3.5 px-4">{t('leads.colProfile')}</th>
                <th className="py-3.5 px-4">{t('leads.colContact')}</th>
                <th className="py-3.5 px-4">{t('leads.colLocation')}</th>
                <th className="py-3.5 px-4">{t('leads.colRatingWeb')}</th>
                <th className="py-3.5 px-4">{t('leads.colStatus')}</th>
                <th className="py-3.5 px-4 text-right">{t('leads.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.04]">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-[#7367F0] mb-2" />
                    <span>{t('common.loading')}</span>
                  </td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-0">
                    <EmptyState
                      icon={Users}
                      title={t('leadFinder.noJobsFound')}
                      description={t('titles.leadsSub')}
                    />
                  </td>
                </tr>
              ) : (
                leads.map((lead) => {
                  const isSelected = selectedIds.includes(lead.id) || selectAllMatching;
                  return (
                    <tr 
                      key={lead.id} 
                      className={`transition-colors group ${
                        isSelected
                          ? 'bg-[#7367F0]/10 dark:bg-[#7367F0]/15'
                          : 'hover:bg-slate-50/70 dark:hover:bg-white/[0.02]'
                      }`}
                    >
                      {/* Row Checkbox */}
                      <td className="py-3.5 px-4 text-center">
                        <button
                          type="button"
                          onClick={() => handleToggleSingleSelect(lead.id)}
                          className="p-1 rounded hover:bg-slate-200 dark:hover:bg-white/[0.08] text-slate-500 dark:text-slate-300 transition-colors cursor-pointer"
                        >
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-[#7367F0]" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-300 dark:text-slate-600 group-hover:text-slate-400" />
                          )}
                        </button>
                      </td>

                      {/* Name & Avatar & Category */}
                      <td className="py-3.5 px-4 max-w-[260px]">
                        <BusinessCell
                          name={lead.name}
                          category={lead.category || t('common.general')}
                          entityType={lead.entity_type}
                          onClick={() => handleOpenLeadDrawer(lead)}
                        />
                      </td>

                      {/* Phone & WhatsApp */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="flex items-center space-x-2 font-mono font-bold text-xs text-slate-700 dark:text-slate-200">
                          <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span>{lead.phone_e164 || lead.phone || t('leads.noPhone')}</span>
                        </div>
                        <div className="mt-1">
                          {lead.is_whatsapp_eligible ? (
                            <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-full bg-[#25D366]/15 text-[#25D366] font-bold text-[10px]">
                              <WhatsAppIcon className="w-3 h-3" />
                              <span>{t('leads.whatsappActive')}</span>
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400 font-sans">
                              {t('leads.whatsappUnverified')}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Location - Clickable to open Google Maps */}
                      <td className="py-3.5 px-4 max-w-[240px]">
                        <a
                          href={getGoogleMapsUrl(lead)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={t('leads.openInGoogleMaps')}
                          className="group/loc inline-flex items-start space-x-1.5 text-xs text-slate-600 dark:text-slate-300 hover:text-[#7367F0] dark:hover:text-[#7367F0] transition-colors cursor-pointer"
                        >
                          <MapPin className="w-3.5 h-3.5 text-slate-400 group-hover/loc:text-[#7367F0] shrink-0 mt-0.5 transition-colors" />
                          <span className="line-clamp-2 leading-tight group-hover/loc:underline underline-offset-2">
                            {lead.address || `${lead.district ? `${lead.district}, ` : ''}${lead.city || ''}`}
                          </span>
                        </a>
                      </td>

                      {/* Rating & Website */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {lead.rating ? (
                          <div className="flex items-center space-x-1 text-xs">
                            <Star className="w-3.5 h-3.5 text-[#FF9F43] fill-[#FF9F43]" />
                            <span className="font-bold text-slate-800 dark:text-white">{lead.rating}</span>
                            {lead.reviews_count ? (
                              <span className="text-slate-400 text-[10px]">({lead.reviews_count})</span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-slate-400 text-[10px]">{t('leads.noRating')}</span>
                        )}

                        {lead.website ? (
                          <a
                            href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-flex items-center space-x-1 text-[11px] text-[#7367F0] hover:underline truncate max-w-[140px]"
                          >
                            <Globe className="w-3 h-3 shrink-0" />
                            <span className="truncate">{lead.website.replace(/^https?:\/\/(www\.)?/, '')}</span>
                          </a>
                        ) : null}
                      </td>

                      {/* Status Dropdown */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <select
                          value={lead.status}
                          onChange={(e) => handleStatusChange(lead.id, e.target.value as LeadStatus)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${
                            lead.status === 'NEW'
                              ? 'bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/20'
                              : lead.status === 'CONTACTED'
                              ? 'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20'
                              : lead.status === 'REPLIED'
                              ? 'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
                              : lead.status === 'INTERESTED'
                              ? 'bg-purple-50 text-purple-600 border-purple-200 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-500/20'
                              : lead.status === 'INVALID_NUMBER'
                              ? 'bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
                              : 'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-500/20'
                          }`}
                        >
                          <option value="NEW">{t('leads.statusNew')}</option>
                          <option value="CONTACTED">{t('leads.statusContacted')}</option>
                          <option value="REPLIED">{t('leads.statusReplied')}</option>
                          <option value="INTERESTED">{t('leads.statusInterested')}</option>
                          <option value="UNSUBSCRIBED">{t('leads.statusUnsubscribed')}</option>
                          <option value="INVALID_NUMBER">{t('leads.statusInvalid')}</option>
                        </select>
                      </td>

                      {/* Actions: View Details, WhatsApp Chat, Delete, 3-Dots Dropdown */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end space-x-1">
                          <IconButton
                            icon={Eye}
                            variant="ghost"
                            size="sm"
                            tooltip={t('leads.tabOverview')}
                            onClick={() => handleOpenLeadDrawer(lead, 'overview')}
                            className="text-slate-400 hover:text-[#7367F0] hover:bg-[#7367F0]/10"
                          />
                          <div className="relative inline-flex">
                            <IconButton
                              icon={WhatsAppIcon}
                              variant="ghost"
                              size="sm"
                              tooltip={t('leads.tabConversation')}
                              onClick={() => handleOpenLeadDrawer(lead, 'chat')}
                              className="text-[#25D366] hover:bg-[#25D366]/10"
                            />
                            {lead.status === 'REPLIED' && (
                              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-900 animate-pulse" />
                            )}
                          </div>
                          <IconButton
                            icon={Trash2}
                            variant="ghost"
                            size="sm"
                            tooltip={t('common.delete')}
                            onClick={() => handleOpenSingleDelete(lead)}
                            className="text-slate-400 hover:text-[#EA5455] hover:bg-[#EA5455]/10"
                          />
                          <Dropdown
                            trigger={
                              <div
                                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors"
                                title={t('leads.colActions')}
                              >
                                <MoreVertical className="w-4 h-4" />
                              </div>
                            }
                            items={[
                              {
                                id: 'add-to-group',
                                label: t('leads.bulkAddToGroup'),
                                icon: <FolderPlus className="w-3.5 h-3.5 text-[#7367F0]" />,
                                onClick: () => handleOpenAddToGroup(lead),
                              },
                              {
                                id: 'blacklist',
                                label: t('blacklist.addToBlacklist'),
                                icon: <ShieldAlert className="w-3.5 h-3.5 text-[#FF9F43]" />,
                                onClick: () => handleOpenSingleBlacklist(lead),
                                variant: 'warning',
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Centralized Pagination */}
        {total > 0 && (
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
        )}
      </Card>

      {/* Offcanvas Slide-over Lead Details Drawer */}
      <LeadDetailDrawer
        lead={selectedLeadForDrawer}
        isOpen={isDrawerOpen}
        initialTab={drawerInitialTab}
        onClose={() => setIsDrawerOpen(false)}
        onSendMessage={(lead) => handleOpenLeadDrawer(lead, 'chat')}
        onBlacklist={handleOpenSingleBlacklist}
        onDelete={handleOpenSingleDelete}
        onStatusChange={handleStatusChange}
      />

      {/* Centralized Delete Confirmation Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => !isDeleting && setIsDeleteModalOpen(false)}
        title={
          isBulkDelete 
            ? (selectAllMatching ? t('leads.bulkDeleteAll', { total }) : t('leads.bulkDelete', { count: selectedCount })) 
            : t('leads.deleteConfirmTitle')
        }
        subtitle={t('leads.deleteConfirmMsg')}
        icon={Trash2}
        variant="danger"
        maxWidth="md"
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isDeleting}
              onClick={() => setIsDeleteModalOpen(false)}
              className="cursor-pointer"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isDeleting}
              onClick={handleConfirmDelete}
              className="bg-[#EA5455] hover:bg-[#D43B3C] text-white font-bold space-x-1.5 shadow-md shadow-[#EA5455]/30 cursor-pointer"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('common.loading')}</span>
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  <span>{t('common.delete')}</span>
                </>
              )}
            </Button>
          </>
        }
      >
        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-xs text-slate-600 dark:text-slate-300 space-y-3">
          {!isBulkDelete && leadToDelete ? (
            <p>
              <strong className="text-slate-800 dark:text-white font-bold">{leadToDelete.name}</strong> - {t('leads.deleteConfirmMsg')}
            </p>
          ) : (
            <div className="space-y-2">
              <label className="flex items-start space-x-2.5 p-2 rounded-lg border border-slate-200 dark:border-white/[0.08] cursor-pointer hover:bg-slate-100 dark:hover:bg-white/[0.03] transition-colors">
                <input
                  type="radio"
                  name="deleteScope"
                  checked={!selectAllMatching}
                  onChange={() => setSelectAllMatching(false)}
                  className="mt-0.5 text-[#EA5455] focus:ring-0"
                />
                <div>
                  <span className="font-bold text-slate-800 dark:text-white">
                    {t('leads.bulkDelete', { count: selectedIds.length })}
                  </span>
                </div>
              </label>

              {total > leads.length && (
                <label className="flex items-start space-x-2.5 p-2 rounded-lg border border-rose-200 dark:border-rose-500/30 bg-rose-50/50 dark:bg-rose-500/10 cursor-pointer hover:bg-rose-50 dark:hover:bg-rose-500/20 transition-colors">
                  <input
                    type="radio"
                    name="deleteScope"
                    checked={selectAllMatching}
                    onChange={() => setSelectAllMatching(true)}
                    className="mt-0.5 text-[#EA5455] focus:ring-0"
                  />
                  <div>
                    <span className="font-bold text-[#EA5455]">
                      {t('leads.bulkDeleteAll', { total })}
                    </span>
                  </div>
                </label>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* Centralized Blacklist Modal */}
      <Modal
        isOpen={isBlacklistModalOpen}
        onClose={() => !isBlacklisting && setIsBlacklistModalOpen(false)}
        title={isBulkBlacklist ? t('blacklist.confirmBulkRemoveTitle') : t('blacklist.modalTitle')}
        subtitle={t('blacklist.subtitle')}
        icon={ShieldAlert}
        variant="warning"
        maxWidth="md"
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBlacklisting}
              onClick={() => setIsBlacklistModalOpen(false)}
              className="cursor-pointer"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isBlacklisting}
              onClick={handleConfirmBlacklist}
              className="bg-[#FF9F43] hover:bg-[#E58A32] text-white font-bold space-x-1.5 shadow-md shadow-[#FF9F43]/30 cursor-pointer"
            >
              {isBlacklisting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('common.loading')}</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-4 h-4" />
                  <span>{t('blacklist.addNumber')}</span>
                </>
              )}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-xs text-slate-600 dark:text-slate-300 space-y-2">
            {!isBulkBlacklist && leadToBlacklist ? (
              <p>
                <strong className="text-slate-800 dark:text-white font-bold">{leadToBlacklist.name}</strong> ({leadToBlacklist.phone_e164 || leadToBlacklist.phone})
              </p>
            ) : (
              <p>
                {t('blacklist.selectedToolbarCount', { count: selectedCount })}
              </p>
            )}
          </div>

          <div className="space-y-2 text-xs">
            <label className="text-slate-700 dark:text-slate-300 font-bold block">{t('blacklist.blockReasonLabel')}</label>
            <div className="flex flex-wrap gap-1.5">
              {[
                'USER_REQUEST',
                'BOUNCED',
                'SPAM_COMPLAINT',
                'MANUAL_BLACKLIST'
              ].map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setBlacklistReason(r)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                    blacklistReason === r
                      ? 'bg-[#FF9F43]/15 text-[#FF9F43] border-[#FF9F43]'
                      : 'bg-white dark:bg-white/[0.03] border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {r === 'USER_REQUEST' ? t('blacklist.reasonUserRequest') : r === 'BOUNCED' ? t('blacklist.reasonBounced') : r === 'SPAM_COMPLAINT' ? t('blacklist.reasonSpamComplaint') : t('blacklist.reasonManual')}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* Centralized Add New Lead Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title={t('leads.addNewLeadTitle')}
        subtitle={t('leads.addNewLeadSubtitle')}
        icon={Plus}
        variant="primary"
        maxWidth="md"
      >
        {formError && (
          <div className="mb-4 p-3 rounded-lg bg-rose-50 text-[#EA5455] text-xs font-bold border border-rose-200">
            {formError}
          </div>
        )}

        <form onSubmit={handleAddLead} className="space-y-3.5 text-xs">
          <div>
            <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">{t('leads.leadNameRequired')}</label>
            <input
              type="text"
              value={newLeadName}
              onChange={(e) => setNewLeadName(e.target.value)}
              placeholder="e.g. Dentgroup Ataşehir"
              className="w-full px-3 py-2 rounded-lg vuexy-input"
              required
            />
          </div>

          <div>
            <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">{t('leads.leadPhoneRequired')}</label>
            <input
              type="text"
              value={newLeadPhone}
              onChange={(e) => setNewLeadPhone(e.target.value)}
              placeholder="e.g. +905321234567"
              className="w-full px-3 py-2 rounded-lg vuexy-input font-mono"
              required
            />
          </div>

          <div>
            <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">{t('leads.categoryLabel')}</label>
            <input
              type="text"
              value={newLeadCategory}
              onChange={(e) => setNewLeadCategory(e.target.value)}
              placeholder="e.g. Dental Clinic"
              className="w-full px-3 py-2 rounded-lg vuexy-input"
            />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">{t('leads.cityLabel')}</label>
              <input
                type="text"
                value={newLeadCity}
                onChange={(e) => setNewLeadCity(e.target.value)}
                placeholder="İstanbul"
                className="w-full px-3 py-2 rounded-lg vuexy-input"
              />
            </div>
            <div>
              <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">{t('leads.districtLabel')}</label>
              <input
                type="text"
                value={newLeadDistrict}
                onChange={(e) => setNewLeadDistrict(e.target.value)}
                placeholder="Ataşehir"
                className="w-full px-3 py-2 rounded-lg vuexy-input"
              />
            </div>
          </div>

          <div className="pt-3 flex items-center justify-end space-x-2">
            <Button 
              type="button" 
              variant="outline" 
              size="sm" 
              onClick={() => setIsAddModalOpen(false)}
              className="cursor-pointer"
            >
              {t('common.cancel')}
            </Button>
            <Button 
              type="submit" 
              size="sm" 
              className="font-bold shadow-md shadow-[#7367F0]/30 cursor-pointer"
            >
              {t('common.save')}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Centralized Add to Campaign Group Modal */}
      <Modal
        isOpen={isAddToGroupModalOpen}
        onClose={() => setIsAddToGroupModalOpen(false)}
        title={t('leads.addToGroupModalTitle')}
        subtitle={t('leads.addToGroupModalSubtitle')}
        icon={FolderPlus}
        variant="primary"
        maxWidth="md"
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isAddingToGroup}
              onClick={() => setIsAddToGroupModalOpen(false)}
              className="cursor-pointer"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isAddingToGroup || (selectedTargetGroupId === 'NEW' && !newGroupName.trim())}
              onClick={handleConfirmAddToGroup}
              className="bg-[#7367F0] hover:bg-[#685dd8] text-white font-bold space-x-1.5 shadow-md shadow-[#7367F0]/30 cursor-pointer"
            >
              {isAddingToGroup ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('common.loading')}</span>
                </>
              ) : (
                <>
                  <FolderPlus className="w-4 h-4" />
                  <span>{t('leads.addToGroupBtn')}</span>
                </>
              )}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-xs">
          {/* Target Leads Summary Box */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] flex items-center justify-between">
            <div className="flex items-center space-x-2 min-w-0 pr-2">
              <Building2 className="w-4 h-4 text-[#7367F0] shrink-0" />
              <span className="font-bold text-slate-800 dark:text-white truncate">
                {singleLeadForGroup
                  ? singleLeadForGroup.name
                  : selectAllMatching
                  ? t('leads.allMatchingSelected', { total })
                  : t('leads.bulkToolbarCount', { count: selectedCount })}
              </span>
            </div>
            <Badge variant="primary" className="text-[10px] shrink-0">
              {singleLeadForGroup ? 1 : selectedCount} {t('campaignGroups.businesses')}
            </Badge>
          </div>

          {/* Group Choice Selection */}
          <div className="space-y-3">
            <label className="text-slate-700 dark:text-slate-300 font-bold block">
              {t('leads.selectExistingGroup')}
            </label>

            {isLoadingGroups ? (
              <div className="p-4 text-center text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                <span>{t('common.loading')}</span>
              </div>
            ) : (
              <div className="space-y-2">
                {/* Radio choice for New Group */}
                <label
                  className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-colors ${
                    selectedTargetGroupId === 'NEW'
                      ? 'bg-[#7367F0]/10 border-[#7367F0] text-[#7367F0]'
                      : 'bg-white dark:bg-[#25293C] border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <input
                      type="radio"
                      name="targetGroupChoice"
                      value="NEW"
                      checked={selectedTargetGroupId === 'NEW'}
                      onChange={() => setSelectedTargetGroupId('NEW')}
                      className="text-[#7367F0] focus:ring-[#7367F0]"
                    />
                    <span className="font-bold">{t('leads.createNewGroupOption')}</span>
                  </div>
                  <Plus className="w-4 h-4" />
                </label>

                {selectedTargetGroupId === 'NEW' && (
                  <div className="pl-6 pr-1 pt-1 pb-2">
                    <input
                      type="text"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder={t('leads.newGroupNamePlaceholder')}
                      className="w-full px-3 py-2 rounded-lg vuexy-input text-xs"
                      autoFocus
                    />
                  </div>
                )}

                {/* List of Existing Campaign Groups */}
                {campaignGroups.length > 0 && (
                  <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
                    {campaignGroups.map((grp) => {
                      const isSelected = selectedTargetGroupId === grp.id;
                      return (
                        <label
                          key={grp.id}
                          className={`p-2.5 px-3 rounded-xl border flex items-center justify-between cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-[#7367F0]/10 border-[#7367F0] text-[#7367F0]'
                              : 'bg-white dark:bg-[#25293C] border-slate-200/80 dark:border-white/10 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                          }`}
                        >
                          <div className="flex items-center space-x-2.5 min-w-0 pr-2">
                            <input
                              type="radio"
                              name="targetGroupChoice"
                              value={grp.id}
                              checked={isSelected}
                              onChange={() => setSelectedTargetGroupId(grp.id)}
                              className="text-[#7367F0] focus:ring-[#7367F0]"
                            />
                            <div className="min-w-0 truncate">
                              <div className="font-bold truncate">{grp.name}</div>
                              <div className="text-[10px] text-slate-400 truncate">
                                {grp.target_category || ''} {grp.target_location ? `• ${grp.target_location}` : ''}
                              </div>
                            </div>
                          </div>

                          <div className="text-right shrink-0">
                            <Badge variant="primary" className="text-[9px]">
                              {grp.total_leads_count} {t('campaignGroups.businesses')}
                            </Badge>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
};
