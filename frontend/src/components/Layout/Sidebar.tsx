import React from 'react';
import { createPortal } from 'react-dom';
import { 
  LayoutDashboard, 
  Search, 
  Users, 
  Send, 
  FolderKanban,
  Smartphone, 
  ShieldAlert, 
  Settings,
  Sparkles,
  Radio,
  ShieldCheck,
  X
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { useI18n } from '../../context/I18nContext';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isWsConnected: boolean;
  totalLeadsCount?: number;
  activeCampaignsCount?: number;
  isOpenMobile?: boolean;
  onCloseMobile?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ 
  activeTab, 
  setActiveTab, 
  isWsConnected,
  totalLeadsCount = 0,
  activeCampaignsCount = 0,
  isOpenMobile = false,
  onCloseMobile = () => {},
}) => {
  const { t } = useI18n();

  const sections = [
    {
      title: t('nav.sectionCrm'),
      items: [
        { id: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard, badge: null },
        { id: 'lead-finder', label: t('nav.leadFinder'), icon: Search, badge: 'Live', badgeVariant: 'success' as const },
        { id: 'leads', label: t('nav.leads'), icon: Users, badge: totalLeadsCount > 0 ? `${totalLeadsCount}` : null, badgeVariant: 'primary' as const },
      ]
    },
    {
      title: t('nav.sectionOutreach'),
      items: [
        { id: 'campaigns', label: t('nav.campaigns'), icon: Send, badge: activeCampaignsCount > 0 ? `${activeCampaignsCount}` : null, badgeVariant: 'warning' as const },
        { id: 'campaign-groups', label: t('nav.campaignGroups'), icon: FolderKanban, badge: null },
      ]
    },
    {
      title: t('nav.sectionConfig'),
      items: [
        { id: 'whatsapp', label: t('nav.whatsappHub'), icon: Smartphone, badge: null },
        { id: 'blacklist', label: t('nav.blacklist'), icon: ShieldAlert, badge: null },
        { id: 'settings', label: t('nav.settings'), icon: Settings, badge: null },
      ]
    }
  ];

  const handleTabClick = (tabId: string) => {
    setActiveTab(tabId);
    if (onCloseMobile) onCloseMobile();
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white dark:bg-[#2F3349] select-none">
      {/* Vuexy Brand Header */}
      <div className="p-5 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#7367F0] to-[#9E95F5] flex items-center justify-center shadow-md shadow-[#7367F0]/30 text-white font-bold shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-1.5">
              <span className="font-extrabold text-lg tracking-tight text-slate-800 dark:text-white">
                Tezlify
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25 dark:text-[#A59DF8]">
                PRO
              </span>
            </div>
            <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium">B2B Lead & WhatsApp</p>
          </div>
        </div>

        {/* Mobile Close Button */}
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05] cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Realtime Engine Status */}
      <div className="px-4 py-2.5 mx-3 my-3 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.05] flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-2">
          <span className={`w-2.5 h-2.5 rounded-full ${isWsConnected ? 'bg-[#28C76F] live-dot' : 'bg-[#EA5455]'}`} />
          <span className="text-xs font-bold text-slate-600 dark:text-slate-300 truncate">
            {isWsConnected ? t('nav.liveSync') : t('nav.connecting')}
          </span>
        </div>
        <Radio className={`w-3.5 h-3.5 shrink-0 ${isWsConnected ? 'text-[#28C76F]' : 'text-slate-400'}`} />
      </div>

      {/* Navigation Sections */}
      <nav className="flex-1 px-3 space-y-4 overflow-y-auto pt-1">
        {sections.map((sec, sIdx) => (
          <div key={sIdx} className="space-y-1">
            <div className="px-3 py-1 text-[10px] font-extrabold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider">
              {sec.title}
            </div>
            {sec.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  data-tab-id={item.id}
                  onClick={() => handleTabClick(item.id)}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-xs font-semibold transition-all duration-150 group cursor-pointer ${
                    isActive
                      ? 'bg-gradient-to-r from-[#7367F0] to-[#867BFF] text-white shadow-md shadow-[#7367F0]/40 font-bold'
                      : 'text-slate-600 dark:text-[#DBD7EC] hover:bg-slate-100 dark:hover:bg-white/[0.04] hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <div className="flex items-center space-x-3 truncate">
                    <Icon
                      className={`w-4.5 h-4.5 shrink-0 transition-colors ${
                        isActive ? 'text-white' : 'text-slate-400 dark:text-[#7E7F96] group-hover:text-slate-700 dark:group-hover:text-slate-200'
                      }`}
                    />
                    <span className="truncate">{item.label}</span>
                  </div>

                  {item.badge && (
                    <Badge
                      variant={isActive ? 'default' : item.badgeVariant || 'default'}
                      className={`text-[10px] px-2 py-0.5 shrink-0 ${isActive ? 'bg-white/20 text-white' : ''}`}
                    >
                      {item.badge}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Anti-Ban Safeguard Status Footer */}
      <div className="p-4 border-t border-slate-100 dark:border-white/[0.06] shrink-0">
        <div className="p-3 rounded-lg bg-emerald-50/70 dark:bg-[#28C76F]/10 border border-emerald-200 dark:border-[#28C76F]/25">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-bold text-[#28C76F] flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              {t('nav.antiBanShield')}
            </span>
            <Badge variant="success" className="text-[9px] px-1.5 py-0">
              {t('common.active')}
            </Badge>
          </div>
          <p className="text-[10px] text-slate-500 dark:text-[#7E7F96] leading-tight font-medium">
            {t('nav.antiBanDesc')}
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Fixed Sidebar */}
      <aside className="hidden lg:flex w-64 border-r border-slate-200/80 dark:border-white/[0.08] flex-col h-screen fixed left-0 top-0 z-40 transition-colors duration-200">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer Backdrop & Overlay (portaled to document.body like Modal) */}
      {isOpenMobile &&
        typeof document !== 'undefined' &&
        createPortal(
          <div 
            className="lg:hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-opacity duration-300 animate-fade-in"
            onClick={onCloseMobile}
          >
            <div 
              className="w-72 max-w-[85vw] h-full shadow-2xl animate-slide-right flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {sidebarContent}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
