import React, { useState, useEffect } from 'react';
import { 
  Send, 
  Sparkles, 
  ListPlus,
  Trash2,
  MessageSquare,
  AlertTriangle,
  Smartphone,
} from 'lucide-react';
import { ApiClient, subscribeRealtime } from '../api/client';
import { Campaign, WhatsAppSession } from '../types';
import { WhatsAppRepository } from '../features/whatsapp/data/whatsappRepository';
import { 
  Button, 
  Badge, 
  Card, 
  PageHeader, 
  EmptyState,
  Pagination,
  BulkActionToolbar,
  ToolbarActionButton
} from '../components/ui';
import { 
  CampaignCard, 
  CampaignDeleteModal,
  CampaignCreateWizard,
} from '../features/campaigns/components';
import { useToast } from '../context/ToastContext';
import { useI18n } from '../context/I18nContext';

interface CampaignsPageProps {
  onRefreshStats: () => void;
  onNavigate?: (tab: string, prefillData?: any) => void;
  prefill?: {
    groupId?: number;
    groupName?: string;
    targetCategory?: string;
    category?: string;
    totalLeads?: number;
    whatsappEligible?: number;
  } | null;
  onClearPrefill?: () => void;
}

export const CampaignsPage: React.FC<CampaignsPageProps> = ({
  onRefreshStats,
  onNavigate,
  prefill,
  onClearPrefill,
}) => {
  const toast = useToast();
  const { t } = useI18n();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [sessions, setSessions] = useState<WhatsAppSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [activeTab, setActiveTab] = useState<'list' | 'builder'>('list');

  // Pagination State
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Campaign Selection & Bulk Actions State
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // Campaign Deletion Modal State
  const [campaignToDelete, setCampaignToDelete] = useState<Campaign | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (prefill) {
      setActiveTab('builder');
    }
  }, [prefill]);

  const fetchCampaigns = async () => {
    setLoading(true);
    try {
      const data = await ApiClient.getCampaigns();
      setCampaigns(data);
    } catch (err) {
      console.error('Error fetching campaigns:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchSessions = async () => {
    try {
      setLoadingSessions(true);
      const data = await WhatsAppRepository.getWhatsAppSessions();
      setSessions(data);
    } catch (err) {
      console.error('Error fetching WhatsApp sessions:', err);
    } finally {
      setLoadingSessions(false);
    }
  };

  useEffect(() => {
    fetchCampaigns();
    fetchSessions();
  }, []);

  const connectedSession = sessions.find((s) => s.status === 'CONNECTED');

  // Real-time WebSocket listener for campaign & session events
  useEffect(() => {
    const sub = subscribeRealtime((event: any) => {
      if (!event || !event.event) return;
      const { event: evType, campaign_id, success, message } = event;

      // Re-fetch sessions on session lifecycle events
      if (
        evType === 'session_connected' ||
        evType === 'session_disconnected' ||
        evType === 'session_status_changed'
      ) {
        fetchSessions();
      }

      if (!campaign_id) return;

      if (evType === 'campaign_started') {
        setCampaigns((prev) =>
          prev.map((c) => (c.id === campaign_id ? { ...c, status: 'ACTIVE' } : c))
        );
      } else if (evType === 'campaign_paused') {
        setCampaigns((prev) =>
          prev.map((c) => (c.id === campaign_id ? { ...c, status: 'PAUSED' } : c))
        );
        if (message) {
          toast.warning(message, t('campaigns.pauseCampaign'));
        }
      } else if (evType === 'campaign_completed') {
        setCampaigns((prev) =>
          prev.map((c) => (c.id === campaign_id ? { ...c, status: 'COMPLETED' } : c))
        );
        toast.success(message || t('campaigns.campaignLaunched'), t('common.success'));
        fetchCampaigns();
        onRefreshStats();
      } else if (evType === 'message_sent' || evType === 'message_failed') {
        setCampaigns((prev) =>
          prev.map((c) => {
            if (c.id !== campaign_id) return c;
            return {
              ...c,
              sent_count: success ? (c.sent_count || 0) + 1 : c.sent_count,
              failed_count: !success ? (c.failed_count || 0) + 1 : c.failed_count,
            };
          })
        );
      }
    });

    return () => {
      sub.close();
    };
  }, []);

  const handleLaunchCampaign = async (campaignId: number) => {
    if (!connectedSession) {
      toast.warning(
        t('campaigns.noConnectedSessionToast') || 'Kampanyayı başlatmak için lütfen önce WhatsApp sekmesinden bir hat bağlayın.',
        t('common.warning')
      );
      if (onNavigate) {
        onNavigate('whatsapp');
      }
      return;
    }

    try {
      await ApiClient.launchCampaign(campaignId, {
        limit: 50,
        session_id: connectedSession.id,
      });
      toast.success(t('campaigns.campaignLaunched'), t('common.success'));
      fetchCampaigns();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    }
  };

  const handlePauseCampaign = async (campaignId: number) => {
    try {
      await ApiClient.pauseCampaign(campaignId);
      toast.info(t('campaigns.pauseCampaign'), t('common.info'));
      fetchCampaigns();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    }
  };

  const handleCancelCampaign = async (campaignId: number) => {
    const confirmed = await toast.confirm({
      title: t('campaigns.pauseCampaign') + '?',
      message: t('campaigns.pauseCampaignConfirmMsg'),
      confirmText: t('campaigns.pauseCampaign'),
      variant: 'warning',
    });
    if (!confirmed) return;

    try {
      await ApiClient.pauseCampaign(campaignId);
      toast.warning(t('campaigns.pauseCampaign'), t('common.warning'));
      fetchCampaigns();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    }
  };

  const handleOpenDeleteModal = (campaignId: number) => {
    const camp = campaigns.find((c) => c.id === campaignId);
    if (camp) {
      setCampaignToDelete(camp);
      setIsDeleteModalOpen(true);
    }
  };

  const handleConfirmDelete = async () => {
    if (!campaignToDelete) return;
    setIsDeleting(true);
    try {
      await ApiClient.deleteCampaign(campaignToDelete.id);
      toast.success(t('campaigns.campaignDeletedSuccess') || 'Kampanya başarıyla silindi.', t('common.success'));
      setCampaigns((prev) => prev.filter((c) => c.id !== campaignToDelete.id));
      setIsDeleteModalOpen(false);
      setCampaignToDelete(null);
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('campaigns.campaignDeleteError') || t('common.error'), t('toast.errorTitle'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleSelect = (campaignId: number) => {
    setSelectedIds((prev) =>
      prev.includes(campaignId) ? prev.filter((id) => id !== campaignId) : [...prev, campaignId]
    );
  };

  const currentPageCampaigns = campaigns.slice((page - 1) * pageSize, page * pageSize);
  const currentPageIds = currentPageCampaigns.map((c) => c.id);
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
    setSelectedIds(campaigns.map((c) => c.id));
    setSelectAllMatching(true);
  };

  const handleClearSelection = () => {
    setSelectedIds([]);
    setSelectAllMatching(false);
  };

  const handleBulkDelete = async () => {
    const count = selectAllMatching ? campaigns.length : selectedIds.length;
    if (count === 0) return;

    const confirmed = await toast.confirm({
      title: `${t('campaigns.deleteCampaign')} (${count})`,
      message: t('campaigns.bulkDeleteConfirm', { count }),
      confirmText: t('common.delete') || 'Sil',
      variant: 'danger',
    });
    if (!confirmed) return;

    setIsBulkDeleting(true);
    try {
      const targetIds = selectAllMatching ? campaigns.map((c) => c.id) : selectedIds;
      const res = await ApiClient.bulkDeleteCampaigns(targetIds);
      toast.success(res.message || `${res.deleted_count} kampanya silindi.`, t('common.success'));
      setSelectedIds([]);
      setSelectAllMatching(false);
      fetchCampaigns();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || 'Toplu silme işlemi başarısız oldu.', t('toast.errorTitle'));
    } finally {
      setIsBulkDeleting(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6 pb-16 select-none animate-fade-in">
      {/* Top Header & Mode Tabs */}
      <Card className="p-4 sm:p-6">
        <PageHeader
          title={t('campaigns.title')}
          subtitle={t('titles.campaignsSub')}
          icon={Send}
          actions={
            <div className="flex items-center space-x-2">
              <Button
                variant={activeTab === 'list' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('list')}
                className={`cursor-pointer font-bold ${activeTab === 'list' ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30' : ''}`}
              >
                {t('campaigns.title')} ({campaigns.length})
              </Button>
              <Button
                variant={activeTab === 'builder' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('builder')}
                className={`space-x-1.5 font-bold cursor-pointer ${activeTab === 'builder' ? 'bg-[#7367F0] text-white shadow-md shadow-[#7367F0]/30' : ''}`}
              >
                <ListPlus className="w-3.5 h-3.5" />
                <span>{t('campaigns.createCampaign')}</span>
              </Button>
            </div>
          }
        />
      </Card>

      {/* WhatsApp Sender Line Status Banner */}
      {connectedSession ? (
        <div className="p-3.5 sm:p-4 rounded-xl bg-[#28C76F]/10 border border-[#28C76F]/20 flex items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-[#28C76F] text-white flex items-center justify-center font-bold shrink-0 shadow-sm shadow-[#28C76F]/20">
              <MessageSquare className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-[#28C76F] animate-pulse" />
                <span className="text-xs font-extrabold text-slate-800 dark:text-white truncate">
                  {t('campaigns.activeSenderLine')}: {connectedSession.phone_number || connectedSession.session_name}
                </span>
                {connectedSession.phone_number && connectedSession.session_name && (
                  <span className="text-[11px] text-slate-400 dark:text-[#7E7F96]">({connectedSession.session_name})</span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] mt-0.5 truncate">
                {t('campaigns.campaignLaunched')}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onNavigate?.('whatsapp')}
            className="text-xs font-bold border-[#28C76F]/40 text-[#28C76F] hover:bg-[#28C76F]/10 shrink-0 cursor-pointer h-8"
          >
            <span>{t('campaigns.goToWhatsApp')}</span>
          </Button>
        </div>
      ) : (
        <div className="p-3.5 sm:p-4 rounded-xl bg-[#FF9F43]/10 border border-[#FF9F43]/20 flex items-center justify-between gap-3 flex-wrap sm:flex-nowrap shadow-xs">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-[#FF9F43] text-white flex items-center justify-center font-bold shrink-0 shadow-sm shadow-[#FF9F43]/20">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-extrabold text-slate-800 dark:text-white block">
                {t('campaigns.noConnectedLine')}
              </span>
              <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] mt-0.5">
                {t('campaigns.noConnectedLineNotice')}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => onNavigate?.('whatsapp')}
            className="text-xs font-bold bg-[#FF9F43] hover:bg-[#e08a34] text-white shrink-0 shadow-sm cursor-pointer h-8"
          >
            <Smartphone className="w-3.5 h-3.5 mr-1" />
            <span>{t('campaigns.linkLineButton')}</span>
          </Button>
        </div>
      )}

      {activeTab === 'list' ? (
        /* Campaigns List View */
        <div className="space-y-4">
          {campaigns.length === 0 ? (
            <Card className="p-8 text-center">
              <EmptyState
                icon={Send}
                title={t('campaigns.emptyTitle')}
                description={t('campaigns.emptyDescription')}
                action={{
                  label: t('campaigns.createCampaign'),
                  onClick: () => setActiveTab('builder'),
                  icon: Sparkles,
                }}
              />
            </Card>
          ) : (
            <>
              {/* Centralized Bulk Action Toolbar (Identical to LeadCRMPage) */}
              <BulkActionToolbar
                selectedCount={selectedIds.length}
                totalCount={campaigns.length}
                selectAllMatching={selectAllMatching}
                onSelectAllMatching={campaigns.length > selectedIds.length ? handleSelectAllMatching : undefined}
                onClearSelection={handleClearSelection}
                actions={
                  <ToolbarActionButton tone="danger" onClick={handleBulkDelete} disabled={isBulkDeleting}>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isBulkDeleting ? t('common.loading') : `Seçilenleri Sil (${selectedIds.length})`}</span>
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
                    Bu Sayfadakileri Seç ({currentPageCampaigns.length})
                  </span>
                </label>

                {selectedIds.length > 0 ? (
                  <Badge variant="primary" className="text-[10px] font-mono px-2 py-0.5">
                    {selectedIds.length} / {campaigns.length} Seçildi
                  </Badge>
                ) : (
                  <span className="text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium hidden sm:inline">
                    Toplu işlem için kartları seçebilirsiniz
                  </span>
                )}
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {currentPageCampaigns.map((camp) => (
                  <CampaignCard
                    key={camp.id}
                    campaign={camp}
                    isSelected={selectedIds.includes(camp.id)}
                    onToggleSelect={handleToggleSelect}
                    onStart={handleLaunchCampaign}
                    onPause={handlePauseCampaign}
                    onCancel={handleCancelCampaign}
                    onDelete={handleOpenDeleteModal}
                  />
                ))}
              </div>

              {/* Centralized Pagination matching LeadCRMPage */}
              {campaigns.length > 0 && (
                <Card className="overflow-hidden border-slate-100 dark:border-white/[0.05]">
                  <Pagination
                    currentPage={page}
                    totalItems={campaigns.length}
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
        /* Spintax Studio & Campaign Builder View */
        <CampaignCreateWizard
          prefill={prefill}
          onClearPrefill={onClearPrefill}
          onSuccess={() => {
            setActiveTab('list');
            fetchCampaigns();
            onRefreshStats();
          }}
          onCancel={() => setActiveTab('list')}
        />
      )}

      {/* Delete Campaign Confirmation Modal */}
      <CampaignDeleteModal
        isOpen={isDeleteModalOpen}
        onClose={() => !isDeleting && setIsDeleteModalOpen(false)}
        onConfirm={handleConfirmDelete}
        isDeleting={isDeleting}
        campaignToDelete={campaignToDelete}
      />
    </div>
  );
};
