import React, { useState, useEffect } from 'react';
import { Search, Edit2, Play } from 'lucide-react';
import { Modal, Button, Badge } from '../../../components/ui';
import { ApiClient } from '../../../api/client';
import { CampaignGroup, CampaignGroupDetail } from '../../../types';
import { useToast } from '../../../context/ToastContext';
import { useI18n } from '../../../context/I18nContext';
import { matchTurkishSearch } from '../../../lib/utils';

export interface CampaignGroupDetailModalProps {
  isOpen: boolean;
  groupId: number | null;
  onClose: () => void;
  onEdit: (group: CampaignGroup) => void;
  onLaunchCampaign: (group: CampaignGroup) => void;
  allGroups: CampaignGroup[];
}

export const CampaignGroupDetailModal: React.FC<CampaignGroupDetailModalProps> = ({
  isOpen,
  groupId,
  onClose,
  onEdit,
  onLaunchCampaign,
  allGroups,
}) => {
  const { t } = useI18n();
  const toast = useToast();
  const [groupDetail, setGroupDetail] = useState<CampaignGroupDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [viewSearchTerm, setViewSearchTerm] = useState('');

  useEffect(() => {
    if (!isOpen || !groupId) {
      setGroupDetail(null);
      setViewSearchTerm('');
      return;
    }

    let isMounted = true;
    setIsDetailLoading(true);
    ApiClient.getCampaignGroup(groupId)
      .then((detail) => {
        if (isMounted) setGroupDetail(detail);
      })
      .catch((err: any) => {
        if (isMounted) {
          toast.error(err.message || 'Grup detayı alınamadı.');
          onClose();
        }
      })
      .finally(() => {
        if (isMounted) setIsDetailLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, groupId]);

  return (
    <Modal
      isOpen={isOpen && groupId !== null}
      onClose={onClose}
      title={groupDetail?.name || t('campaignGroups.viewGroupTitle')}
      subtitle={
        groupDetail
          ? t('campaignGroups.modalSubtitle', {
              count: groupDetail.total_leads_count,
              waCount: groupDetail.whatsapp_eligible_count,
            })
          : ''
      }
    >
      {isDetailLoading ? (
        <div className="p-8 text-center text-xs text-slate-400">
          {t('common.loading')}
        </div>
      ) : groupDetail ? (
        <div className="space-y-4">
          {/* Metadata Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.05]">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                {t('campaignGroups.sectorLabel')}
              </div>
              <div className="text-xs font-bold text-slate-800 dark:text-white truncate mt-0.5">
                {groupDetail.target_category || t('common.all')}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.05]">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                {t('campaignGroups.locationLabel')}
              </div>
              <div className="text-xs font-bold text-slate-800 dark:text-white truncate mt-0.5">
                {groupDetail.target_location || t('common.all')}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.05]">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                WhatsApp Uygun
              </div>
              <div className="text-xs font-bold text-[#28C76F] mt-0.5">
                {groupDetail.whatsapp_eligible_count} / {groupDetail.total_leads_count}
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
              onClick={onClose}
              className="text-xs cursor-pointer"
            >
              {t('common.close')}
            </Button>

            <div className="flex items-center space-x-2">
              <Button
                variant="outline"
                onClick={() => {
                  const targetGroup = allGroups.find((g) => g.id === groupDetail.id);
                  onClose();
                  if (targetGroup) onEdit(targetGroup);
                }}
                className="text-xs font-bold border-[#7367F0]/30 text-[#7367F0] hover:bg-[#7367F0]/10 cursor-pointer space-x-1.5"
              >
                <Edit2 className="w-3.5 h-3.5" />
                <span>{t('campaignGroups.editGroup')}</span>
              </Button>

              <Button
                onClick={() => {
                  const targetGroup = allGroups.find((g) => g.id === groupDetail.id) || {
                    id: groupDetail.id,
                    name: groupDetail.name,
                    target_category: groupDetail.target_category,
                    total_leads_count: groupDetail.total_leads_count,
                    whatsapp_eligible_count: groupDetail.whatsapp_eligible_count,
                    created_at: groupDetail.created_at,
                    updated_at: groupDetail.updated_at,
                  };
                  onClose();
                  onLaunchCampaign(targetGroup);
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
  );
};
