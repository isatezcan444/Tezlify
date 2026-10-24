import React from 'react';
import { 
  Users, 
  Send, 
  MessageSquareReply, 
  Smartphone, 
  TrendingUp, 
  ArrowUpRight,
  Search, 
  ShieldCheck, 
  Clock, 
  Loader2 
} from 'lucide-react';
import { DashboardStats } from '../types';
import { 
  Button, 
  Badge, 
  Card, 
  HeroBanner, 
  StatsCard, 
  Alert, 
  Progress 
} from '../components/ui';
import { 
  ProgressFunnel, 
  FunnelStage, 
  ActivityTimeline, 
  TimelineEvent 
} from '../components/data-display';
import { useI18n } from '../context/I18nContext';

interface DashboardPageProps {
  stats: DashboardStats | null;
  onNavigate: (tab: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ stats, onNavigate }) => {
  const { t, language } = useI18n();

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-10 h-10 animate-spin text-[#7367F0]" />
      </div>
    );
  }

  // Format recent activity into standard ActivityTimeline events
  const timelineEvents: TimelineEvent[] = stats.recent_activity.map((act) => {
    const isSuccess = act.status === 'REPLIED' || act.status === 'READ';
    const isFailed = act.status === 'FAILED' || act.status === 'CANCELLED';
    const isWarning = act.status === 'QUEUED' || act.status === 'PENDING';
    const variant: 'primary' | 'success' | 'warning' | 'danger' | 'info' = isSuccess
      ? 'success'
      : isFailed
      ? 'danger'
      : isWarning
      ? 'warning'
      : 'primary';

    const getStatusLabel = (status: string): string => {
      switch (status) {
        case 'REPLIED':
          return t('dashboard.statusReplied');
        case 'READ':
          return t('dashboard.statusRead');
        case 'SENT':
          return t('dashboard.statusSent');
        case 'DELIVERED':
          return t('dashboard.statusDelivered');
        case 'FAILED':
          return t('dashboard.statusFailed');
        case 'CANCELLED':
          return t('dashboard.statusCancelled');
        case 'QUEUED':
          return t('dashboard.statusQueued');
        case 'PENDING':
          return t('dashboard.statusPending');
        default:
          return status;
      }
    };

    return {
      id: act.id,
      title: <span className="font-mono font-bold text-slate-800 dark:text-white">{act.phone}</span>,
      subtitle: act.message_snippet ? `"${act.message_snippet}"` : undefined,
      timestamp: act.time,
      badge: (
        <Badge variant={variant} className="text-[9px] font-bold">
          {getStatusLabel(act.status)}
        </Badge>
      ),
      variant: variant,
    };
  });

  const funnelStages: FunnelStage[] = [
    {
      id: 1,
      label: t('dashboard.funnelTotal'),
      count: stats.total_leads,
      percentage: 100,
      variant: 'primary',
    },
    {
      id: 2,
      label: t('dashboard.funnelWaReady'),
      count: stats.whatsapp_eligible_leads,
      percentage: stats.total_leads > 0 ? (stats.whatsapp_eligible_leads / stats.total_leads) * 100 : 0,
      variant: 'info',
    },
    {
      id: 3,
      label: t('dashboard.funnelContacted'),
      count: stats.contacted_leads,
      percentage: stats.whatsapp_eligible_leads > 0 ? (stats.contacted_leads / stats.whatsapp_eligible_leads) * 100 : 0,
      variant: 'warning',
    },
    {
      id: 4,
      label: t('dashboard.funnelReplied'),
      count: stats.replied_leads,
      percentage: stats.response_rate_percentage,
      variant: 'success',
    },
  ];

  return (
    <div className="space-y-5 sm:space-y-6 pb-12 select-none animate-fade-in">
      {/* Vuexy Hero Welcome Card */}
      <HeroBanner
        badgeText={t('dashboard.heroBadge')}
        title={t('dashboard.heroTitle')}
        subtitle={t('dashboard.heroSubtitle')}
        actions={
          <>
            <Button
              onClick={() => onNavigate('lead-finder')}
              className="bg-white text-[#7367F0] hover:bg-white/95 font-bold shadow-md space-x-2 w-full sm:w-auto justify-center cursor-pointer"
            >
              <Search className="w-4 h-4" />
              <span>{t('dashboard.discoverNewLeads')}</span>
            </Button>
            <Button
              onClick={() => onNavigate('campaigns')}
              variant="outline"
              className="bg-white/10 hover:bg-white/20 border-white/30 text-white font-semibold space-x-2 w-full sm:w-auto justify-center cursor-pointer"
            >
              <Send className="w-4 h-4" />
              <span>{t('dashboard.quickStartCampaign')}</span>
            </Button>
          </>
        }
      />

      {/* Vuexy 4-Column Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatsCard
          title={t('dashboard.totalLeads')}
          value={stats.total_leads}
          icon={Users}
          iconVariant="primary"
          badge={{
            text: `${stats.whatsapp_eligible_leads} ${t('dashboard.whatsappEligible')}`,
            variant: 'success',
          }}
          subText={t('dashboard.crmRegistry')}
          onClick={() => onNavigate('leads')}
        />

        <StatsCard
          title={t('dashboard.contactedLeads')}
          value={stats.total_messages_sent}
          icon={Send}
          iconVariant="info"
          badge={{
            text: `+${stats.messages_sent_today} ${t('dashboard.today')}`,
            variant: 'info',
          }}
          subText={t('dashboard.queue')}
          onClick={() => onNavigate('campaigns')}
        />

        <StatsCard
          title={t('dashboard.responseRate')}
          value={language === 'tr' ? `%${stats.response_rate_percentage}` : `${stats.response_rate_percentage}%`}
          icon={MessageSquareReply}
          iconVariant="success"
          badge={{
            text: `${stats.replied_leads} ${t('dashboard.repliedLeads')}`,
            variant: 'success',
          }}
          subText={t('dashboard.inbound')}
        />

        <StatsCard
          title={t('dashboard.connectedSessions')}
          value={stats.connected_sessions}
          icon={Smartphone}
          iconVariant="warning"
          badge={{
            text: t('dashboard.online'),
            variant: 'success',
          }}
          subText={`(${stats.active_campaigns} ${t('dashboard.activeCampaigns')})`}
          onClick={() => onNavigate('whatsapp')}
        />
      </div>

      {/* 1. Full-Width Outreach & Conversion Funnel Card */}
      <Card className="p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-extrabold text-slate-800 dark:text-white flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-[#7367F0]" />
              {t('dashboard.outreachFunnel')}
            </h3>
            <p className="text-xs text-slate-400 dark:text-[#7E7F96] mt-0.5 font-medium">
              {t('titles.dashboardSub')}
            </p>
          </div>
          <Badge variant="primary">{t('dashboard.realtime')}</Badge>
        </div>

        <ProgressFunnel stages={funnelStages} />

        {/* Vuexy Safeguard Alert Banner */}
        <Alert
          variant="success"
          title={t('dashboard.cooldownPolicyTitle')}
          icon={<ShieldCheck className="w-5 h-5 text-[#28C76F] shrink-0" />}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mt-1">
            <span>{t('dashboard.cooldownPolicyDesc')}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onNavigate('whatsapp')}
              className="text-[#28C76F] hover:text-[#28C76F]/80 font-bold space-x-1 p-0 h-auto cursor-pointer shrink-0"
            >
              <span>{t('dashboard.manageSessions')}</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </Alert>
      </Card>

      {/* 2. Full-Width Recent Activity / Message Dispatch Logs Card */}
      <Card className="p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-white/[0.06]">
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-base font-extrabold text-slate-800 dark:text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-[#7367F0]" />
                {t('campaigns.logsTitle')}
              </h3>
              <Badge variant="primary" className="font-mono text-[9px]">{t('dashboard.live')}</Badge>
            </div>
            <p className="text-xs text-slate-400 dark:text-[#7E7F96] mt-0.5 font-medium">
              {t('dashboard.recentActivitySub')}
            </p>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate('leads')}
            className="font-bold text-xs cursor-pointer space-x-1.5 self-start sm:self-auto shrink-0"
          >
            <span>{t('dashboard.viewAllLeads')}</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </Button>
        </div>

        <div className="pt-1">
          <ActivityTimeline
            events={timelineEvents}
            emptyMessage={t('dashboard.noRecentLeads')}
          />
        </div>
      </Card>
    </div>
  );
};
