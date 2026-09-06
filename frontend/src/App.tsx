import React, { useState, useEffect, useRef } from 'react';
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

  const refreshStats = async () => {
    try {
      const data = await ApiClient.getDashboardStats();
      setStats(data);
    } catch (err) {
      console.error('Error loading stats:', err);
    }
  };

  useEffect(() => {
    refreshStats();

    // Setup Realtime WebSocket connection with automatic reconnect
    let ws: { close: () => void } | null = null;
    try {
      ws = createWebSocket(
        (eventData) => {
          // Broadcast to hooks/subscribers
          window.dispatchEvent(new CustomEvent('tezlify:ws_event', { detail: eventData }));

          // Handle Inbound Reply Event
          if (eventData.event === 'inbound_reply') {
            toast.reply(
              `${eventData.lead_name} (${eventData.phone}): "${eventData.message}"`,
              t('toast.newReplyTitle')
            );
            refreshStats();
          } else if (eventData.event === 'message_sent') {
            toast.success(
              `${eventData.lead_name} (${eventData.phone})`,
              t('toast.messageSentTitle')
            );
            refreshStats();
          } else if (eventData.event === 'scraper_completed') {
            toast.info(
              t('toast.scraperCompletedMsg', { found: eventData.total_found, leads: eventData.total_new_leads }),
              t('toast.scraperCompletedTitle')
            );
            refreshStats();
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

    const interval = setInterval(refreshStats, 8000);

    return () => {
      clearInterval(interval);
      if (ws) ws.close();
    };
  }, [toast, t]);

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
