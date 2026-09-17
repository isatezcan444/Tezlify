import React, { useState, useEffect, useRef } from 'react';
import {
  Play,
  Check,
  Terminal,
  ExternalLink,
  Phone,
  Star,
  Globe,
  Loader2,
  Sparkles,
  MapPin,
  Search,
  FolderKanban,
  Plus,
  CheckCircle2,
  CheckSquare,
  Square,
  Save,
  Database
} from 'lucide-react';
import { ApiClient, createWebSocket } from '../api/client';
import { toTitleCaseTr } from '../lib/utils';
import {
  Button,
  Badge,
  Card,
  PageHeader,
  Progress,
  Avatar,
  WhatsAppIcon,
  GoogleMapsIcon,
  BulkActionToolbar,
  ToolbarActionButton,
  Pagination
} from '../components/ui';
import { Modal } from '../components/ui/Modal';
import { TextInput } from '../components/forms/TextInput';
import { Select } from '../components/forms';
import { SectorAutocomplete, LocationMultiSelect } from '../features/leads/components';
import { useI18n } from '../context/I18nContext';
import { useToast } from '../context/ToastContext';
import { CampaignGroup } from '../types';

interface LeadFinderPageProps {
  onNavigate: (tab: string, prefillData?: any) => void;
  onRefreshStats: () => void;
}

// Entity badge labels resolve through i18n with raw-value fallback.
const ENTITY_TYPE_LABEL_KEYS: Record<string, string> = {
  BUSINESS: 'leadFinder.entityBusiness',
  CLINIC: 'leadFinder.entityClinic',
  COMPANY: 'leadFinder.entityCompany',
  PROFESSIONAL: 'leadFinder.entityProfessional',
  PERSON: 'leadFinder.entityPerson',
  DIRECTORY_PROFILE: 'leadFinder.entityDirectory',
  UNKNOWN: 'leadFinder.entityUnknown',
};

export const LeadFinderPage: React.FC<LeadFinderPageProps> = ({ onNavigate, onRefreshStats }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [keyword, setKeyword] = useState('');
  const [selectedCity, setSelectedCity] = useState('');
  const [selectedDistricts, setSelectedDistricts] = useState<string[]>([]);
  const [maxResults, setMaxResults] = useState<number>(0); // 0 means Unlimited
  const [isScraping, setIsScraping] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [discoveredLeads, setDiscoveredLeads] = useState<any[]>([]);
  const [progress, setProgress] = useState(0);
  // Explicit-save selection (Gmail style, keyed by place_id — results carry
  // no CRM id until the user saves them).
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  // Client-side pagination over the in-memory discovery set (same shared
  // Pagination component as the CRM table).
  const [resultsPage, setResultsPage] = useState(1);
  const [resultsPageSize, setResultsPageSize] = useState(12);

  const leadKey = (l: any): string => String(l?.place_id || l?.name || '');
  const allKeys = discoveredLeads.map(leadKey).filter(Boolean);
  const unsavedLeads = discoveredLeads.filter((l) => !l.id);
  const savedLeads = discoveredLeads.filter((l) => l.id);
  const isAllSelected = allKeys.length > 0 && allKeys.every((k) => selectedKeys.includes(k));
  // Clamp (never yank the user back): streaming appends keep the current page.
  const totalResultPages = Math.max(1, Math.ceil(discoveredLeads.length / resultsPageSize));
  const safeResultsPage = Math.min(resultsPage, totalResultPages);
  const pagedLeads = discoveredLeads.slice(
    (safeResultsPage - 1) * resultsPageSize,
    safeResultsPage * resultsPageSize
  );

  const handleToggleSingleSelect = (key: string) => {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const handleToggleSelectAll = () => {
    setSelectedKeys((prev) =>
      allKeys.length > 0 && allKeys.every((k) => prev.includes(k)) ? [] : [...allKeys]
    );
  };

  // Save to Group State
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [saveMode, setSaveMode] = useState<'NEW' | 'EXISTING'>('NEW');
  const [saveGroupName, setSaveGroupName] = useState('');
  const [saveGroupId, setSaveGroupId] = useState<number | null>(null);
  const [existingGroups, setExistingGroups] = useState<CampaignGroup[]>([]);
  const [isSavingGroup, setIsSavingGroup] = useState(false);

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const resultsSectionRef = useRef<HTMLDivElement>(null);
  const activeJobIdRef = useRef<number | null>(null);
  // Idempotency: the WS 'scraper_completed' event and the 3s polling fallback
  // can both observe the terminal state — only the first one may render it.
  const jobDoneRef = useRef(false);

  // Renders a backend stream line: structured key (localized) wins,
  // legacy free-text message stays as fallback.
  const formatStreamLine = (d: any): string => {
    if (d?.key) {
      const localized = t(d.key, d.params);
      if (localized && localized !== d.key) return localized;
    }
    return d?.message ?? '';
  };

  const handleOpenSaveModal = async (initialMode: 'NEW' | 'EXISTING') => {    setSaveMode(initialMode);
    const locationPrefix = [selectedDistricts[0] || selectedCity].filter(Boolean).join(' ');
    const autoName = [locationPrefix, keyword].filter(Boolean).join(' ');
    setSaveGroupName(autoName || 'Yeni Kampanya Grubu');

    try {
      const groups = await ApiClient.getCampaignGroups();
      setExistingGroups(groups);
      if (groups.length > 0) {
        setSaveGroupId(groups[0].id);
      } else {
        setSaveMode('NEW');
      }
    } catch {
      setExistingGroups([]);
    }

    setIsSaveModalOpen(true);
  };

  const handleConfirmSaveToGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const leadIds = discoveredLeads.map((l) => l.id).filter(Boolean) as number[];
    if (leadIds.length === 0) {
      toast.warning(t('leadFinder.saveGroupNoLeads'));
      return;
    }

    try {
      setIsSavingGroup(true);
      if (saveMode === 'NEW') {
        const locationStr = [selectedCity, selectedDistricts.join(', ')].filter(Boolean).join(' - ');
        const created = await ApiClient.createCampaignGroup({
          name: saveGroupName.trim() || undefined,
          target_category: keyword.trim() || undefined,
          target_location: locationStr || undefined,
          lead_ids: leadIds,
        });
        toast.success(t('campaignGroups.groupCreated', { name: created.name }));
      } else if (saveMode === 'EXISTING' && saveGroupId) {
        const res = await ApiClient.addLeadsToCampaignGroup(saveGroupId, leadIds);
        toast.success(res.message);
      }
      setIsSaveModalOpen(false);
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || 'Gruba kaydedilemedi.');
    } finally {
      setIsSavingGroup(false);
    }
  };

  // Auto-scroll inside terminal without scrolling the entire window
  useEffect(() => {
    if (terminalContainerRef.current) {
      terminalContainerRef.current.scrollTop = terminalContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleStartScrape = async () => {
    if (!keyword.trim() || !selectedCity) return;

    const locationDisplay = selectedDistricts.length > 0
      ? `${selectedCity} > ${selectedDistricts.join(', ')}`
      : `${selectedCity} (${t('leadFinder.allDistricts')})`;

    setIsScraping(true);
    setProgress(5);
    jobDoneRef.current = false;
    setSelectedKeys([]);
    setResultsPage(1);
    const targetLabel = maxResults === 0
      ? t('leadFinder.scopeAll')
      : `${maxResults} ${t('common.entries')}`;
    setLogs([
      `[${new Date().toLocaleTimeString()}] ${t('leadFinder.stream.searchSummary', {
        keyword: keyword.trim(),
        display: locationDisplay,
        target: targetLabel,
      })}`,
    ]);
    setDiscoveredLeads([]);

    try {
      const job = await ApiClient.startScraper({
        keyword: keyword.trim(),
        city: selectedCity,
        districts: selectedDistricts,
        max_results: maxResults,
      });

      activeJobIdRef.current = job.id;

      setLogs((prev) => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] ${t('leadFinder.stream.jobActive', { id: job.id })}`,
      ]);

      let pollInterval: any = null;
      const stopPolling = () => {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      };

      const handleJobCompletion = (totalFound: number, _totalNew: number, leads?: any[]) => {
        if (jobDoneRef.current) return;
        jobDoneRef.current = true;
        stopPolling();
        setIsScraping(false);
        setProgress(100);
        setLogs((prev) => [
          ...prev,
          `[${new Date().toLocaleTimeString()}] ${t('leadFinder.stream.completed', { found: totalFound })}`,
        ]);
        onRefreshStats();
        // Prefer the job's own exact result set (with CRM ids); the paged
        // CRM fetch below is only a degraded fallback for the polling path.
        if (leads && leads.length > 0) {
          setDiscoveredLeads(leads);
        } else {
          ApiClient.getLeads({ page: 1, size: 100 }).then((res) => {
            if (res?.items?.length) {
              setDiscoveredLeads(res.items);
            }
          }).catch(() => {});
        }

        setTimeout(() => {
          if (resultsSectionRef.current) {
            resultsSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }, 300);
      };

      const handleJobFailure = (errorMsg: string) => {
        if (jobDoneRef.current) return;
        jobDoneRef.current = true;
        stopPolling();
        setIsScraping(false);
        setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${t('leadFinder.stream.failed', { error: errorMsg })}`]);
      };

      // Fallback Polling (3s interval) to guarantee state progression
      pollInterval = setInterval(async () => {
        try {
          const status = await ApiClient.getScraperJob(job.id);
          if (status.status === 'COMPLETED') {
            handleJobCompletion(status.total_found || 0, status.total_new_leads || 0);
            ws.close();
          } else if (status.status === 'FAILED') {
            handleJobFailure(status.error_message || 'Tarama başarısız oldu');
            ws.close();
          }
        } catch (e) {
          // ignore transient poll error
        }
      }, 3000);

      const ws = createWebSocket((eventData) => {
        if (eventData.job_id !== undefined && eventData.job_id !== activeJobIdRef.current) {
          return;
        }

        if (eventData.event === 'scraper_progress') {
          const d = eventData.data;
          if (d.type === 'log') {
            setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${formatStreamLine(d)}`]);
            if (d.progress) setProgress(d.progress);
          } else if (d.type === 'lead_found' && d.lead) {
            setDiscoveredLeads((prev) => {
              const exists = prev.some(
                (l) =>
                  (l.place_id && d.lead.place_id && l.place_id === d.lead.place_id) ||
                  (l.name === d.lead.name && (l.phone_e164 === d.lead.phone_e164 || l.phone === d.lead.phone))
              );
              if (exists) return prev;
              return [d.lead, ...prev];
            });
          }
        } else if (eventData.event === 'scraper_completed') {
          handleJobCompletion(eventData.total_found, eventData.total_new_leads, eventData.leads);
          ws.close();
        } else if (eventData.event === 'scraper_failed') {
          handleJobFailure(eventData.error);
          ws.close();
        }
      });

    } catch (err: any) {
      setIsScraping(false);
      setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${t('leadFinder.stream.failed', { error: err.message })}`]);
    }
  };

  // Explicit CRM save: persists the reviewed selection (or everything) via
  // POST /scraper/jobs/{id}/save and merges the returned CRM rows (with ids)
  // back into the discovery list by place_id. Idempotent — re-saving merges.
  const handleSaveLeads = async (keys: string[]) => {
    const jobId = activeJobIdRef.current;
    if (!jobId || keys.length === 0 || isSaving) return;
    const payload = discoveredLeads.filter((l) => keys.includes(leadKey(l)));
    if (payload.length === 0) return;

    setIsSaving(true);
    try {
      const res = await ApiClient.saveScraperLeads(jobId, payload);
      const byKey = new Map((res.saved || []).map((s: any) => [String(s.place_id || s.name), s]));
      setDiscoveredLeads((prev) => prev.map((l) => byKey.get(leadKey(l)) ?? l));
      setSelectedKeys([]);
      setLogs((prev) => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] ${t('leadFinder.stream.savedToCrm', { saved: res.new_count, updated: res.updated_count })}`,
      ]);
      toast.success(t('leadFinder.stream.savedToCrm', { saved: res.new_count, updated: res.updated_count }));
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('leadFinder.stream.failed', { error: '' }));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveSelected = () => handleSaveLeads(selectedKeys);
  const handleSaveAll = () => handleSaveLeads(unsavedLeads.map(leadKey));
  const getGoogleMapsUrl = (lead: any) => {
    if (lead.maps_url) return lead.maps_url;
    if (lead.google_maps_url) return lead.google_maps_url;
    // No stored pin: name the business explicitly. A bare coordinate query
    // shows whatever is nearest (often a neighbour), so text comes first.
    const query = `${lead.name} ${lead.address || ''} ${lead.city || ''}`.trim();
    if (query) {
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    }
    if (lead.latitude && lead.longitude && lead.latitude !== 0) {
      return `https://www.google.com/maps/search/?api=1&query=${lead.latitude},${lead.longitude}`;
    }
    return 'https://www.google.com/maps';
  };

  return (
    <div className="space-y-4 sm:space-y-6 pb-16 select-none animate-fade-in">
      {/* Search Filter Card */}
      <Card className="p-4 sm:p-6 lg:p-7 relative overflow-visible z-20 space-y-4">
        <PageHeader
          title={t('leadFinder.googleMapsSource')}
          subtitle={t('titles.leadFinderSub')}
          icon={Sparkles}
        />

        {/* Form Controls Grid - Responsive across Mobile, Tablet, and Desktop */}
        <div className="grid grid-cols-1 sm:grid-cols-12 lg:grid-cols-12 gap-3 pt-1 items-center">
          {/* Sector Autocomplete Input: 4 cols on desktop, 6 cols on tablet, 12 cols on mobile */}
          <div className="sm:col-span-6 lg:col-span-4">
            <SectorAutocomplete
              value={keyword}
              onChange={setKeyword}
              disabled={isScraping}
            />
          </div>

          {/* Location Multi-Select (City + Districts): 4 cols on desktop, 6 cols on tablet, 12 cols on mobile */}
          <div className="sm:col-span-6 lg:col-span-4">
            <LocationMultiSelect
              selectedCity={selectedCity}
              selectedDistricts={selectedDistricts}
              onChange={(city, districts) => {
                setSelectedCity(city);
                setSelectedDistricts(districts);
              }}
              onCityChange={(city) => setSelectedCity(city)}
              onDistrictsChange={(districts) => setSelectedDistricts(districts)}
              disabled={isScraping}
            />
          </div>

          {/* Target Limit Selector: 2 cols on desktop, 6 cols on tablet, 12 cols on mobile */}
          <div className="sm:col-span-6 lg:col-span-2">
            <Select
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value))}
              disabled={isScraping}
              sizeVariant="lg"
              leftIcon={<Sparkles className="w-3.5 h-3.5 text-[#FF9F43]" />}
              options={[
                { value: 0, label: t('leadFinder.scopeAll') },
                { value: 10, label: `10 ${t('common.entries')}` },
                { value: 25, label: `25 ${t('common.entries')}` },
                { value: 50, label: `50 ${t('common.entries')}` },
                { value: 100, label: `100 ${t('common.entries')}` },
              ]}
            />
          </div>

          {/* Search Button: 2 cols on desktop, 6 cols on tablet, 12 cols on mobile */}
          <div className="sm:col-span-6 lg:col-span-2">
            <Button
              onClick={handleStartScrape}
              disabled={isScraping || !keyword || !selectedCity}
              className="w-full h-11 font-bold shadow-md shadow-[#7367F0]/30 space-x-2 flex items-center justify-center text-xs cursor-pointer"
            >
              {isScraping ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('leadFinder.searching')}</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>{t('leadFinder.startSearch')}</span>
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Selected Summary Bar */}
        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-white/[0.06] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs">
          <div className="flex items-center space-x-1.5 flex-wrap gap-y-1">
            <span className="text-slate-400 dark:text-[#7E7F96] font-medium">{t('common.location')}:</span>
            {selectedCity ? (
              <>
                <Badge variant="primary" className="font-bold text-[11px]">
                  {selectedCity}
                </Badge>
                {selectedDistricts.length > 0 ? (
                  selectedDistricts.map((dist) => (
                    <span
                      key={dist}
                      className="text-[11px] font-bold px-2 py-0.5 rounded bg-slate-100 dark:bg-white/[0.05] text-slate-700 dark:text-slate-200"
                    >
                      {dist}
                    </span>
                  ))
                ) : (
                  <span className="text-[11px] text-slate-400 italic">({t('leadFinder.allDistricts')})</span>
                )}
              </>
            ) : (
              <span className="text-[11px] text-slate-400 italic">{t('leadFinder.cityPlaceholder')}</span>
            )}
          </div>

          <div className="text-[11px] text-slate-500 dark:text-[#7E7F96] shrink-0">
            {t('leadFinder.searchScope')}: <strong className="text-slate-800 dark:text-white font-bold">{maxResults === 0 ? t('common.all') : `${maxResults} ${t('common.entries')}`}</strong>
          </div>
        </div>
      </Card>

      {/* Progress & Live Console Output */}
      {(isScraping || logs.length > 0) && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Terminal className="w-4 h-4 text-[#7367F0]" />
              <span className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">
                {t('leadFinder.liveStream')}
              </span>
            </div>
            <Badge variant="primary" className="font-mono">%{progress}</Badge>
          </div>

          <Progress value={progress} variant="gradient" size="md" />

          <div 
            ref={terminalContainerRef}
            className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-[#00CFE8] font-mono text-xs max-h-48 overflow-y-auto space-y-1.5 shadow-inner"
          >
            {logs.map((log, i) => (
              <div key={i} className="leading-relaxed">
                {log}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Discovered Real Leads Grid */}
      {discoveredLeads.length > 0 && (
        <div ref={resultsSectionRef} className="space-y-4 pt-2 animate-fade-in">
          {/* Header */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-lg font-extrabold text-slate-800 dark:text-white">
                {t('leadFinder.businessesFound')} ({discoveredLeads.length})
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {t('leadFinder.googleMapsSource')}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleToggleSelectAll}
                title={isAllSelected ? t('common.clearSelection') : t('common.selectAll')}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
              >
                {isAllSelected ? (
                  <CheckSquare className="w-4 h-4 text-[#7367F0]" />
                ) : (
                  <Square className="w-4 h-4 text-slate-300 dark:text-slate-600" />
                )}
                <span>{t('common.selectAll')}</span>
              </button>
              <Button
                onClick={handleSaveAll}
                disabled={isSaving || isScraping || unsavedLeads.length === 0}
                className="bg-[#7367F0] hover:bg-[#685dd8] text-white text-xs font-bold px-4 py-2 rounded-xl shadow-md shadow-[#7367F0]/25 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isSaving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                <span>{t('leadFinder.saveAll')}</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => onNavigate('leads')}
                className="text-xs font-bold space-x-1.5 cursor-pointer"
              >
                {t('dashboard.viewAllLeads')}
              </Button>
            </div>
          </div>

          {/* Save to Group Inline Banner (only saved CRM rows can be grouped) */}
          {savedLeads.length > 0 && (
          <div className="bg-gradient-to-r from-[#7367F0]/10 via-[#7367F0]/5 to-transparent border border-[#7367F0]/20 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-sm">
            <div className="flex items-center space-x-3.5">
              <div className="w-10 h-10 rounded-xl bg-[#7367F0] text-white flex items-center justify-center shadow-md shadow-[#7367F0]/25 shrink-0">
                <FolderKanban className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-sm font-extrabold text-slate-800 dark:text-white">
                  {t('leadFinder.saveToGroupBannerTitle')}
                </h4>
                <p className="text-xs text-slate-500 dark:text-[#7E7F96] mt-0.5">
                  {t('leadFinder.saveToGroupBannerDesc')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <Button
                onClick={() => handleOpenSaveModal('NEW')}
                className="bg-[#7367F0] hover:bg-[#685dd8] text-white text-xs font-bold px-4 py-2 rounded-xl shadow-md shadow-[#7367F0]/25 flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('leadFinder.saveAsNewGroup')}
              </Button>
              <Button
                variant="outline"
                onClick={() => handleOpenSaveModal('EXISTING')}
                className="text-xs font-bold px-4 py-2 rounded-xl border-slate-200 dark:border-white/10 flex items-center gap-1.5 cursor-pointer"
              >
                <FolderKanban className="w-3.5 h-3.5 text-[#7367F0]" />
                {t('leadFinder.addToExistingGroup')}
              </Button>
            </div>
          </div>
          )}

          {/* Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pagedLeads.map((lead, idx) => {
              const key = leadKey(lead) || `lead-${idx}`;
              const isSelected = selectedKeys.includes(key);
              const isSaved = Boolean(lead.id);
              return (
              <Card key={key} className={`p-5 hover:shadow-md transition-shadow flex flex-col justify-between h-full space-y-4 ${isSelected ? 'border-[#7367F0]/60 bg-[#7367F0]/[0.04] dark:bg-[#7367F0]/[0.07]' : ''}`}>
                <div>
                  {/* Selection Checkbox, Business Name & Entity Badges */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center space-x-2 min-w-0">
                      <button
                        type="button"
                        onClick={() => handleToggleSingleSelect(key)}
                        title={isSelected ? t('common.clearSelection') : t('common.selectAll')}
                        className="p-1 rounded hover:bg-slate-200 dark:hover:bg-white/[0.08] transition-colors shrink-0 cursor-pointer"
                      >
                        {isSelected ? (
                          <CheckSquare className="w-4 h-4 text-[#7367F0]" />
                        ) : (
                          <Square className="w-4 h-4 text-slate-300 dark:text-slate-600" />
                        )}
                      </button>
                      <Avatar name={lead.name} size="sm" shape="rounded" />
                      <h4 className="text-sm font-extrabold text-slate-800 dark:text-white leading-snug break-words truncate">
                        {toTitleCaseTr(lead.name)}
                      </h4>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {lead.is_verified ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#28C76F]/15 text-[#28C76F] border border-[#28C76F]/20">
                          <Check className="w-2.5 h-2.5" />
                          <span>{t('leadFinder.verifiedBadge')}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#FF9F43]/15 text-[#FF9F43] border border-[#FF9F43]/20">
                          <span>{t('leadFinder.leadBadge')}</span>
                        </span>
                      )}
                      {isSaved && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#7367F0]/10 text-[#7367F0] border border-[#7367F0]/20">
                          <Database className="w-2.5 h-2.5" />
                          <span>{t('leadFinder.savedBadge')}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Category & Entity Type placed below the title */}
                  <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                    <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded bg-[#7367F0]/10 text-[#7367F0] dark:bg-[#7367F0]/20 dark:text-[#A59DF8]">
                      {lead.category || keyword}
                    </span>
                    {lead.entity_type && (
                      <span className="inline-block text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/[0.08] text-slate-600 dark:text-slate-300">
                        {ENTITY_TYPE_LABEL_KEYS[lead.entity_type]
                          ? t(ENTITY_TYPE_LABEL_KEYS[lead.entity_type])
                          : lead.entity_type}
                      </span>
                    )}
                  </div>

                  <div className="mt-3.5 space-y-2 text-xs text-slate-500 dark:text-[#7E7F96]">
                    {/* Phone Box with WhatsApp Brand Icon */}
                    <div className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05]">
                      <div className="flex items-center space-x-2 text-[#7367F0] font-mono font-bold text-xs">
                        <Phone className="w-3.5 h-3.5 text-slate-400" />
                        <span>{lead.phone_e164 || lead.phone || t('leads.noPhone')}</span>
                      </div>
                      {lead.is_whatsapp_eligible && (
                        <WhatsAppIcon className="w-4 h-4 text-[#25D366]" />
                      )}
                    </div>

                    {/* Address Line */}
                    <div className="flex items-start space-x-2 text-[11px] leading-tight">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                      <span className="line-clamp-2">
                        {lead.address || `${lead.district ? `${lead.district}, ` : ''}${lead.city || ''}`}
                      </span>
                    </div>

                    {/* Rating & Review Counter */}
                    {lead.rating ? (
                      <div className="flex items-center space-x-1.5 text-xs text-slate-700 dark:text-slate-300 pt-1">
                        <Star className="w-3.5 h-3.5 text-[#FF9F43] fill-[#FF9F43]" />
                        <span className="font-bold">{lead.rating}</span>
                        {lead.reviews_count ? (
                          <span className="text-slate-400 text-[10px]">({lead.reviews_count} {t('leads.colRatingWeb')})</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Footer Action Links */}
                <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between text-xs">
                  {lead.website ? (
                    <a
                      href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#7367F0] hover:underline flex items-center space-x-1 font-bold truncate max-w-[150px]"
                    >
                      <Globe className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{lead.website.replace(/^https?:\/\/(www\.)?/, '')}</span>
                    </a>
                  ) : (
                    <span className="text-slate-400 text-[11px] italic">{t('leads.noWebsite')}</span>
                  )}

                  <a
                    href={getGoogleMapsUrl(lead)}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1 rounded-md text-slate-400 hover:text-[#7367F0] hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
                    title="Google Maps"
                  >
                    <GoogleMapsIcon className="w-4 h-4" />
                  </a>
                </div>
              </Card>
              );
            })}
          </div>

          {/* Shared pagination (same component as Müşteri Adayları) */}
          {discoveredLeads.length > resultsPageSize && (
            <Pagination
              currentPage={safeResultsPage}
              totalItems={discoveredLeads.length}
              pageSize={resultsPageSize}
              onPageChange={(newPage) => {
                setResultsPage(newPage);
                resultsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              onPageSizeChange={(newSize) => {
                setResultsPageSize(newSize);
                setResultsPage(1);
              }}
              pageSizeOptions={[9, 12, 24, 48]}
            />
          )}

          {/* Bulk Selection Toolbar (CRM pattern): save selection to CRM */}
          <BulkActionToolbar
            selectedCount={selectedKeys.length}
            totalCount={discoveredLeads.length}
            selectAllMatching={false}
            onClearSelection={() => setSelectedKeys([])}
            actions={
              <>
                <ToolbarActionButton
                  onClick={handleSaveSelected}
                  disabled={isSaving || selectedKeys.length === 0}
                >
                  {isSaving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  <span>{t('leadFinder.saveSelected')}</span>
                </ToolbarActionButton>
                <ToolbarActionButton
                  onClick={handleSaveAll}
                  disabled={isSaving || unsavedLeads.length === 0}
                >
                  <Database className="w-3.5 h-3.5" />
                  <span>{t('leadFinder.saveAll')}</span>
                </ToolbarActionButton>
              </>
            }
          />
        </div>
      )}

      {/* Save to Group Modal */}
      <Modal
        isOpen={isSaveModalOpen}
        onClose={() => setIsSaveModalOpen(false)}
        title={t('leadFinder.saveModalTitle')}
        subtitle={t('leadFinder.saveModalSubtitle')}
      >
        <form onSubmit={handleConfirmSaveToGroup} className="space-y-4">
          {/* Options Radios */}
          <div className="space-y-2">
            <label
              onClick={() => setSaveMode('NEW')}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                saveMode === 'NEW'
                  ? 'border-[#7367F0] bg-[#7367F0]/5 dark:bg-[#7367F0]/10'
                  : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/[0.02]'
              }`}
            >
              <input
                type="radio"
                name="saveMode"
                checked={saveMode === 'NEW'}
                onChange={() => setSaveMode('NEW')}
                className="mt-0.5 text-[#7367F0] focus:ring-[#7367F0]"
              />
              <div className="min-w-0">
                <span className="text-xs font-bold text-slate-800 dark:text-white block">
                  {t('leadFinder.saveOptionNew')}
                </span>
                <span className="text-[11px] text-slate-400">
                  {t('leadFinder.saveOptionNewDesc')}
                </span>
              </div>
            </label>

            <label
              onClick={() => setSaveMode('EXISTING')}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                saveMode === 'EXISTING'
                  ? 'border-[#7367F0] bg-[#7367F0]/5 dark:bg-[#7367F0]/10'
                  : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/[0.02]'
              }`}
            >
              <input
                type="radio"
                name="saveMode"
                checked={saveMode === 'EXISTING'}
                onChange={() => setSaveMode('EXISTING')}
                disabled={existingGroups.length === 0}
                className="mt-0.5 text-[#7367F0] focus:ring-[#7367F0]"
              />
              <div className="min-w-0">
                <span className="text-xs font-bold text-slate-800 dark:text-white block">
                  {t('leadFinder.saveOptionExisting')}
                </span>
                <span className="text-[11px] text-slate-400">
                  {existingGroups.length === 0
                    ? t('leadFinder.noExistingGroups')
                    : t('leadFinder.saveOptionExistingDesc')}
                </span>
              </div>
            </label>
          </div>

          {/* New Group Name Input */}
          {saveMode === 'NEW' && (
            <div className="pt-2">
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('campaignGroups.groupNameLabel')}
              </label>
              <TextInput
                value={saveGroupName}
                onChange={(e) => setSaveGroupName(e.target.value)}
                placeholder={t('campaignGroups.groupNamePlaceholder')}
                className="w-full"
                required
              />
            </div>
          )}

          {/* Existing Group Selection List */}
          {saveMode === 'EXISTING' && existingGroups.length > 0 && (
            <div className="pt-2 space-y-2 max-h-48 overflow-y-auto rounded-xl border border-slate-100 dark:border-white/10 p-2">
              {existingGroups.map((g) => (
                <label
                  key={g.id}
                  onClick={() => setSaveGroupId(g.id)}
                  className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-all ${
                    saveGroupId === g.id
                      ? 'border-[#7367F0] bg-[#7367F0]/10 font-bold text-[#7367F0]'
                      : 'border-transparent hover:bg-slate-50 dark:hover:bg-white/[0.04] text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs truncate">
                    <input
                      type="radio"
                      name="existingGroup"
                      checked={saveGroupId === g.id}
                      onChange={() => setSaveGroupId(g.id)}
                      className="text-[#7367F0] focus:ring-[#7367F0]"
                    />
                    <span className="truncate">{g.name}</span>
                  </div>
                  <span className="text-[11px] text-slate-400 font-normal shrink-0">
                    {g.total_leads_count} {t('campaignGroups.businesses')}
                  </span>
                </label>
              ))}
            </div>
          )}

          {/* Info Badge */}
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.05] space-y-1">
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              {t('leadFinder.savingLeadsCount', { count: savedLeads.length })}
            </p>
            <p className="text-[11px] text-slate-400">
              {t('leadFinder.duplicateNotice')}
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-white/[0.06]">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsSaveModalOpen(false)}
              className="text-xs font-semibold cursor-pointer"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={isSavingGroup || (saveMode === 'EXISTING' && !saveGroupId)}
              className="bg-[#7367F0] hover:bg-[#685dd8] text-white text-xs font-bold px-5 cursor-pointer"
            >
              {isSavingGroup ? t('common.loading') : t('common.save')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
