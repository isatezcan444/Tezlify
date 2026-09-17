import React from 'react';
import {
  Check,
  Phone,
  Star,
  Globe,
  MapPin,
  CheckSquare,
  Square,
  Database,
} from 'lucide-react';
import { Card, Avatar, WhatsAppIcon, GoogleMapsIcon } from '../../../components/ui';
import { toTitleCaseTr } from '../../../lib/utils';
import { useI18n } from '../../../context/I18nContext';

export const ENTITY_TYPE_LABEL_KEYS: Record<string, string> = {
  BUSINESS: 'leadFinder.entityBusiness',
  CLINIC: 'leadFinder.entityClinic',
  COMPANY: 'leadFinder.entityCompany',
  PROFESSIONAL: 'leadFinder.entityProfessional',
  PERSON: 'leadFinder.entityPerson',
  DIRECTORY_PROFILE: 'leadFinder.entityDirectory',
  UNKNOWN: 'leadFinder.entityUnknown',
};

export interface LeadFinderResultCardProps {
  lead: any;
  keyword: string;
  isSelected: boolean;
  onToggleSelect: (key: string) => void;
  leadKey: string;
  googleMapsUrl: string;
}

export const LeadFinderResultCard: React.FC<LeadFinderResultCardProps> = ({
  lead,
  keyword,
  isSelected,
  onToggleSelect,
  leadKey,
  googleMapsUrl,
}) => {
  const { t } = useI18n();
  const isSaved = Boolean(lead.id);

  return (
    <Card className={`p-5 hover:shadow-md transition-shadow flex flex-col justify-between h-full space-y-4 ${isSelected ? 'border-[#7367F0]/60 bg-[#7367F0]/[0.04] dark:bg-[#7367F0]/[0.07]' : ''}`}>
      <div>
        {/* Selection Checkbox, Business Name & Entity Badges */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center space-x-2 min-w-0">
            <button
              type="button"
              onClick={() => onToggleSelect(leadKey)}
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
          href={googleMapsUrl}
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
};
