import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ThemeProvider } from './context/ThemeContext';
import { ToastProvider, useToast } from './context/ToastContext';
import { I18nProvider, useI18n } from './context/I18nContext';
import { Sidebar } from './components/Layout/Sidebar';
import { TopHeader } from './components/Layout/TopHeader';
import { DashboardPage } from './pages/DashboardPage';
import { LeadFinderPage } from './pages/LeadFinderPage';
import { LeadCRMPage } from './pages/LeadCRMPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { CampaignGroupsPage } from './pages/CampaignGroupsPage';
import { WhatsAppHubPage } from './pages/WhatsAppHubPage';
import { BlacklistPage } from './pages/BlacklistPage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminOverviewPage } from './pages/admin/AdminOverviewPage';
import { AdminWhatsAppPage } from './pages/admin/AdminWhatsAppPage';
import { AdminMonitoringPage } from './pages/admin/AdminMonitoringPage';
import { AdminBackupsPage } from './pages/admin/AdminBackupsPage';
import { ApiClient, createWebSocket } from './api/client';
import { DashboardStats } from './types';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginPage } from './pages/LoginPage';

const AppContent: React.FC = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isWsConnected, setIsWsConnected] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [campaignPrefill, setCampaignPrefill] = useState<any>(null);
  const wasDisconnectedRef = useRef(false);
  const toast = useToast();
  const { t } = useI18n();

  const handleNavigate = (tab: string, prefillData?: any) => {
    if (tab === 'campaigns' && prefillData) {
      setCampaignPrefill(prefillData);
    } else if (tab !== 'campaigns') {
      setCampaignPrefill(null);
    }
    setActiveTab(tab);
  };

  // Faz 12 (P0 — ağ fırtınası kök nedeni): İSTATİSTİK POLLING'İ KALDIRILDI.
  //
  // Eskiden burada `setInterval(refreshStats, 8000)` vardı ve `refreshStats`
  // her render'da YENİDEN üretilen bir fonksiyondu. Sonuç zinciri:
  //   8 sn'lik tick → setStats → App yeniden render → `refreshStats` kimliği
  //   değişir → `onRefreshStats` prop'u değişir → WhatsAppHubPage'in
  //   [fetchSessions, onRefreshStats, refreshSyncStatus] bağımlılıklı effect'i
  //   yeniden çalışır → GET /whatsapp/sessions + GET /whatsapp/sync/job +
  //   GET /settings/antiban tekrar gider.
  // Yani 8 sn'de bir dashboard isteği, yanında 3 istek daha doğuruyordu —
  // Network sekmesindeki "dashboard + sessions + job + antiban" sürekli
  // polling tablosunun tamamı bu tek hatadan geliyordu. `/analytics/dashboard`
  // ~11 ayrı aggregate sorgu çalıştırdığı için istekler saniyeleri buluyor ve
  // kuyruğu tıkıyordu.
  //
  // Artık: kimlik STABİL (useCallback) → alt sayfa effect'i bir daha
  // tetiklenmez. Veri yalnızca GERÇEK sinyallerle tazelenir:
  //   1) dashboard toplamlarını değiştiren WS olayları (debounce'lu),
  //   2) sekme yeniden görünür/pencere odaklandığında,
  //   3) Dashboard sekmesine dönüldüğünde.
  // Sürekli HTTP polling YOK.
  const refreshStats = useCallback(async () => {
    try {
      const data = await ApiClient.getDashboardStats();
      setStats(data);
    } catch (err) {
      console.error('Error loading stats:', err);
    }
  }, []);

  // Aynı anda çok sayıda WS olayı geldiğinde (ör. kampanya sırasında ardı ardına
  // `message_sent`) TEK bir tazeleme yapılır — istek fırtınası oluşmaz.
  const statsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStatsRefresh = useCallback(() => {
    if (statsRefreshTimerRef.current) return;
    statsRefreshTimerRef.current = setTimeout(() => {
      statsRefreshTimerRef.current = null;
      void refreshStats();
    }, 1200);
  }, [refreshStats]);

  useEffect(() => {
    // İlk yükleme: kullanıcı boş ekran görmesin diye ANINDA tek istek
    // (polling değil, tek seferlik bootstrap).
    void refreshStats();

    // Setup Realtime WebSocket connection with automatic reconnect
    let ws: { close: () => void } | null = null;
    try {
      ws = createWebSocket(
        (eventData) => {
          // Broadcast to hooks/subscribers
          window.dispatchEvent(new CustomEvent('tezlify:ws_event', { detail: eventData }));

          // Handle campaign message progress & scraper completion events
          if (eventData.event === 'message_sent') {
            toast.success(
              `${eventData.lead_name} (${eventData.phone})`,
              t('toast.messageSentTitle')
            );
            scheduleStatsRefresh();
          } else if (eventData.event === 'scraper_completed') {
            toast.info(
              t('toast.scraperCompletedMsg', { found: eventData.total_found, leads: eventData.total_new_leads }),
              t('toast.scraperCompletedTitle')
            );
            scheduleStatsRefresh();
          } else if (
            // Dashboard toplamlarını gerçekten değiştiren diğer olaylar.
            // (scraper_progress gibi yüksek frekanslı akışlar BİLEREK dışarıda
            // bırakıldı — onlar sayfa içi ilerleme UI'ını besler.)
            eventData.event === 'scraper_failed' ||
            eventData.event === 'scraper_cancelled' ||
            eventData.event === 'campaign_started' ||
            eventData.event === 'campaign_completed' ||
            eventData.event === 'campaign_failed'
          ) {
            scheduleStatsRefresh();
          }
        },
        (connected) => {
          if (connected) {
            window.dispatchEvent(new CustomEvent('tezlify:ws_connected'));
            // Only announce re-connections (cold starts, sleep/wake): the
            // initial mount connects silently to avoid a boot toast.
            if (wasDisconnectedRef.current) {
              toast.info(
                t('toast.reconnectedMsg'),
                t('toast.reconnectedTitle')
              );
              // Kopma sırasında kaçan veri olabilir — yeniden bağlanınca
              // tek seferlik mutabakat (polling değil).
              scheduleStatsRefresh();
            }
            wasDisconnectedRef.current = false;
          } else {
            wasDisconnectedRef.current = true;
          }
          setIsWsConnected(connected);
        }
      );
    } catch (e) {
      console.warn('WS Init failed:', e);
    }

    return () => {
      if (statsRefreshTimerRef.current) {
        clearTimeout(statsRefreshTimerRef.current);
        statsRefreshTimerRef.current = null;
      }
      if (ws) ws.close();
    };
  }, [toast, t, refreshStats, scheduleStatsRefresh]);

  // Polling yerine kullanıcı sinyali: sekme/pencere yeniden görünür olduğunda
  // bayat toplamlar bir kez tazelenir (uygulama uyanma senaryosu).
  useEffect(() => {
    const onBecameVisible = () => {
      if (document.visibilityState === 'visible') scheduleStatsRefresh();
    };
    document.addEventListener('visibilitychange', onBecameVisible);
    window.addEventListener('focus', onBecameVisible);
    return () => {
      document.removeEventListener('visibilitychange', onBecameVisible);
      window.removeEventListener('focus', onBecameVisible);
    };
  }, [scheduleStatsRefresh]);

  // Dashboard sekmesine dönüldüğünde tek tazeleme — kullanıcı bayat sayı görmez.
  // İlk çalıştırma atlanır (mount'ta zaten tek bootstrap isteği yapıldı).
  const isFirstStatsTabRunRef = useRef(true);
  useEffect(() => {
    if (isFirstStatsTabRunRef.current) {
      isFirstStatsTabRunRef.current = false;
      return;
    }
    if (activeTab === 'dashboard') scheduleStatsRefresh();
  }, [activeTab, scheduleStatsRefresh]);

  const getPageTitle = () => {
    switch (activeTab) {
      case 'dashboard':
        return t('titles.dashboard');
      case 'lead-finder':
        return t('titles.leadFinder');
      case 'leads':
        return t('titles.leads');
      case 'campaigns':
        return t('titles.campaigns');
      case 'campaign-groups':
        return t('titles.campaignGroups');
      case 'whatsapp':
        return t('titles.whatsapp');
      case 'blacklist':
        return t('titles.blacklist');
      case 'settings':
        return t('titles.settings');
      case 'admin-overview':
        return t('titles.adminOverview');
      case 'admin-whatsapp':
        return t('titles.adminWhatsApp');
      case 'admin-monitoring':
        return t('titles.adminMonitoring');
      case 'admin-backups':
        return t('titles.adminBackups');
      default:
        return 'Tezlify';
    }
  };

  const getPageSubtitle = () => {
    switch (activeTab) {
      case 'dashboard':
        return t('titles.dashboardSub');
      case 'lead-finder':
        return t('titles.leadFinderSub');
      case 'leads':
        return t('titles.leadsSub');
      case 'campaigns':
        return t('titles.campaignsSub');
      case 'campaign-groups':
        return t('titles.campaignGroupsSub');
      case 'whatsapp':
        return t('titles.whatsappSub');
      case 'blacklist':
        return t('titles.blacklistSub');
      case 'settings':
        return t('titles.settingsSub');
      case 'admin-overview':
        return t('titles.adminOverviewSub');
      case 'admin-whatsapp':
        return t('titles.adminWhatsAppSub');
      case 'admin-monitoring':
        return t('titles.adminMonitoringSub');
      case 'admin-backups':
        return t('titles.adminBackupsSub');
      default:
        return undefined;
    }
  };


  return (
    <div className="min-h-screen bg-[#F8F7FA] dark:bg-[#25293C] text-[#4B465C] dark:text-[#DBD7EC] flex font-sans transition-colors duration-200">
      {/* Sidebar with Desktop fixed & Mobile drawer support */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={handleNavigate}
        isWsConnected={isWsConnected}
        totalLeadsCount={stats?.total_leads}
        activeCampaignsCount={stats?.active_campaigns}
        isOpenMobile={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
      />

      {/* Main Content Area: Responsive left padding (pl-0 on mobile, pl-64 on desktop) */}
      <div className="flex-1 lg:pl-64 pl-0 flex flex-col min-h-screen w-full overflow-x-hidden">
        {/* Floating Top Header */}
        <TopHeader
          title={getPageTitle()}
          subtitle={getPageSubtitle()}
          onOpenQuickScrape={() => handleNavigate('lead-finder')}
          onOpenSettings={() => handleNavigate('settings')}
          onToggleMobileMenu={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        />

        {/* Dynamic Page Container with Responsive Padding */}
        <main className="flex-1 p-3.5 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {activeTab === 'dashboard' && (
            <DashboardPage stats={stats} onNavigate={handleNavigate} />
          )}
          {activeTab === 'lead-finder' && (
            <LeadFinderPage onNavigate={handleNavigate} onRefreshStats={refreshStats} />
          )}
          {activeTab === 'leads' && (
            <LeadCRMPage onRefreshStats={refreshStats} />
          )}
          {activeTab === 'campaigns' && (
            <CampaignsPage
              onRefreshStats={refreshStats}
              onNavigate={handleNavigate}
              prefill={campaignPrefill}
              onClearPrefill={() => setCampaignPrefill(null)}
            />
          )}
          {activeTab === 'campaign-groups' && (
            <CampaignGroupsPage onNavigate={handleNavigate} onRefreshStats={refreshStats} />
          )}
          {activeTab === 'whatsapp' && (
            <WhatsAppHubPage onRefreshStats={refreshStats} />
          )}
          {activeTab === 'blacklist' && (
            <BlacklistPage />
          )}
          {activeTab === 'settings' && (
            <SettingsPage />
          )}
          {activeTab === 'admin-overview' && (
            <AdminOverviewPage onNavigate={handleNavigate} />
          )}
          {activeTab === 'admin-whatsapp' && (
            <AdminWhatsAppPage onNavigate={handleNavigate} />
          )}
          {activeTab === 'admin-monitoring' && (
            <AdminMonitoringPage onNavigate={handleNavigate} />
          )}
          {activeTab === 'admin-backups' && (
            <AdminBackupsPage onNavigate={handleNavigate} />
          )}
        </main>

      </div>
    </div>
  );
};

const AuthGate: React.FC = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-primary-600 to-indigo-500 text-white flex items-center justify-center text-xl font-black shadow-lg shadow-primary-500/25 animate-pulse">
            T
          </div>
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
            <div className="w-2 h-2 rounded-full bg-primary-500 animate-ping" />
            <span>Tezlify yükleniyor...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <AppContent />;
};

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <AuthProvider>
            <AuthGate />
          </AuthProvider>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  );
};

export default App;
