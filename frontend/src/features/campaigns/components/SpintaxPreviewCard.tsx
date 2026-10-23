import React, { useState, useMemo, useCallback } from 'react';
import { 
  Sparkles, 
  Copy, 
  Check, 
  CheckCheck, 
  Shuffle, 
  Building2,
  CheckCircle2,
  Users,
} from 'lucide-react';
import { Card } from '../../../components/ui/card';
import { IconButton } from '../../../components/ui/IconButton';
import { Badge } from '../../../components/ui/badge';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { cn } from '../../../lib/utils';

export interface SpintaxPreviewCardProps {
  template: string;
  targetCategory?: string;
  sampleLead?: {
    name?: string;
    city?: string;
    district?: string;
    category?: string;
    rating?: number;
  };
  className?: string;
}

/**
 * Calculates total possible unique spintax combinations in a template string.
 * Example: "{A|B|C} and {X|Y}" => 3 * 2 = 6 variations.
 * Returns 1 if no spintax blocks are present, or 0 if template is empty.
 */
export const countSpintaxVariations = (text: string): number => {
  if (!text || !text.trim()) return 0;
  const spintaxRegex = /\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  let total = 1;
  let foundSpintax = false;

  while ((match = spintaxRegex.exec(text)) !== null) {
    const inner = match[1];
    if (inner.includes('|')) {
      const parts = inner.split('|').map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) {
        foundSpintax = true;
        total *= parts.length;
        if (total > 1_000_000) return 1_000_000;
      }
    }
  }

  return foundSpintax ? total : 1;
};

const SAMPLE_LEAD_PROFILES_TR = [
  {
    name: 'Özel DentaLine Polikliniği',
    city: 'İstanbul',
    district: 'Kadıköy',
    category: 'Diş Klinikleri',
    rating: 4.9,
  },
  {
    name: 'ArtMim Mimarlık & Tasarım',
    city: 'Ankara',
    district: 'Çankaya',
    category: 'Mimarlık Ofisleri',
    rating: 4.8,
  },
  {
    name: 'Ege Vizyon Akademi',
    city: 'İzmir',
    district: 'Konak',
    category: 'Özel Eğitim Kurumları',
    rating: 5.0,
  },
];

const SAMPLE_LEAD_PROFILES_EN = [
  {
    name: 'Apex Dental Care',
    city: 'London',
    district: 'Westminster',
    category: 'Dental Clinics',
    rating: 4.9,
  },
  {
    name: 'Vanguard Design Studio',
    city: 'Manchester',
    district: 'City Centre',
    category: 'Architecture Studios',
    rating: 4.8,
  },
  {
    name: 'Horizon Tech Academy',
    city: 'Edinburgh',
    district: 'Old Town',
    category: 'Training Academies',
    rating: 5.0,
  },
];

export const SpintaxPreviewCard: React.FC<SpintaxPreviewCardProps> = ({
  template,
  targetCategory,
  sampleLead,
  className,
}) => {
  const { language, t } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [iteration, setIteration] = useState(0);
  const [sampleProfileIndex, setSampleProfileIndex] = useState(0);
  const [isShuffling, setIsShuffling] = useState(false);

  // Active sample lead resolution (props override or profile rotation)
  const activeSampleLead = useMemo(() => {
    if (sampleLead) {
      return {
        ...sampleLead,
        category: targetCategory || sampleLead.category || (language === 'en' ? 'General Business' : 'Genel İşletme'),
      };
    }
    const profiles = language === 'en' ? SAMPLE_LEAD_PROFILES_EN : SAMPLE_LEAD_PROFILES_TR;
    const selected = profiles[sampleProfileIndex % profiles.length];
    return {
      ...selected,
      category: targetCategory || selected.category,
    };
  }, [sampleLead, sampleProfileIndex, targetCategory, language]);

  // Spintax Resolver: {opt1|opt2|opt3} and {name}/{isim}, {city}/{şehir}, {district}/{ilçe}, {category}/{kategori}, {rating}/{puan}
  const resolveSpintax = useCallback((text: string) => {
    if (!text || !text.trim()) return '';

    // 1. Replace template variables (supporting both TR and EN tokens)
    let resolved = text
      .replace(/\{(name|isim|ad)\}/gi, activeSampleLead.name || t('campaigns.sampleContactName'))
      .replace(/\{(city|sehir|şehir)\}/gi, activeSampleLead.city || t('campaigns.sampleCityFallback'))
      .replace(/\{(district|ilce|ilçe)\}/gi, activeSampleLead.district || t('campaigns.sampleDistrictFallback'))
      .replace(/\{(category|kategori|sektor|sektör)\}/gi, activeSampleLead.category || targetCategory || t('campaigns.sampleCategoryFallback'))
      .replace(/\{(rating|puan)\}/gi, String(activeSampleLead.rating || 4.9))
      .replace(/\{(address|adres)\}/gi, t('campaigns.sampleAddressFallback'))
      .replace(/\{(phone|telefon)\}/gi, t('campaigns.samplePhoneFallback'))
      .replace(/\{(website|web)\}/gi, t('campaigns.sampleWebsiteFallback'));

    // 2. Resolve Spintax syntax {choice1|choice2|choice3}
    const spintaxRegex = /\{([^{}]+)\}/g;
    resolved = resolved.replace(spintaxRegex, (match, choices) => {
      if (choices.includes('|')) {
        const options = choices.split('|').map((o) => o.trim()).filter(Boolean);
        if (options.length > 0) {
          return options[Math.floor(Math.random() * options.length)];
        }
      }
      return match;
    });

    return resolved;
  }, [activeSampleLead, targetCategory, t]);

  const previewText = useMemo(() => {
    if (!template || !template.trim()) {
      return t('campaigns.templateEmptyNotice') || (language === 'tr' 
        ? 'İletişim amacınızı seçip bilgileri doldurduğunuzda mesajınız burada otomatik olarak görünecek.' 
        : 'Once you select a communication goal and fill in details, your live preview will appear here.');
    }
    return resolveSpintax(template);
    // `iteration` is a deliberate dependency so Math.random() picks different spintax branches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, iteration, language, t, resolveSpintax]);

  const totalVariations = useMemo(() => {
    return countSpintaxVariations(template);
  }, [template]);

  const isPlaceholder = !template || !template.trim();

  const handleShuffle = () => {
    if (isPlaceholder) return;
    setIsShuffling(true);
    setIteration((i) => i + 1);
    setTimeout(() => setIsShuffling(false), 300);
  };

  const handleCycleSampleLead = () => {
    setSampleProfileIndex((prev) => prev + 1);
  };

  const handleCopy = () => {
    if (!previewText || isPlaceholder) return;
    navigator.clipboard.writeText(previewText);
    setCopied(true);
    toast.success(t('campaigns.wizardCopiedSuccess') || 'Mesaj metni panoya kopyalandı!');
    setTimeout(() => setCopied(false), 2000);
  };

  // Consistent simulated clock for preview
  const sampleTime = useMemo(() => {
    const d = new Date();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }, []);

  return (
    <Card className={cn('overflow-hidden p-0 border border-slate-200/70 dark:border-white/[0.06] shadow-xs flex flex-col', className)}>
      {/* Soft Vuexy Top Subheader */}
      <div className="px-4 sm:px-5 py-3.5 bg-white dark:bg-[#2F3349] border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-2">
        <div className="flex items-center space-x-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h4 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white leading-tight truncate">
              {t('campaigns.livePreview') || 'Canlı Önizleme'}
            </h4>
            <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] mt-0.5 truncate">
              {t('campaigns.livePreviewSubtitle') || 'Oluşturulan mesajın anlık görünümü'}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          {/* Spintax Variation Counter Badge */}
          {!isPlaceholder && (
            <>
              {totalVariations > 1 ? (
                <Badge variant="success" className="text-[10px] font-bold px-2 py-0.5 hidden sm:inline-flex items-center space-x-1">
                  <Sparkles className="w-3 h-3 mr-1" />
                  <span>{t('campaigns.spintaxCountBadge', { count: totalVariations })}</span>
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] font-bold px-2 py-0.5 hidden sm:inline-flex">
                  {t('campaigns.spintaxSingleBadge')}
                </Badge>
              )}
            </>
          )}

          <IconButton
            icon={Shuffle}
            size="sm"
            variant="ghost"
            tooltip={t('campaigns.wizardNewVariation') || 'Farklı Varyasyon Üret'}
            onClick={handleShuffle}
            disabled={isPlaceholder}
            className={cn(
              'text-slate-600 dark:text-slate-300 hover:text-[#7367F0] hover:bg-[#7367F0]/10 transition-transform duration-300',
              isShuffling && 'rotate-180 text-[#7367F0]'
            )}
          />
          <IconButton
            icon={copied ? Check : Copy}
            size="sm"
            variant={copied ? 'success' : 'ghost'}
            tooltip={copied ? (t('common.copied') || 'Kopyalandı') : (t('campaigns.wizardCopyMessage') || 'Metni Kopyala')}
            onClick={handleCopy}
            disabled={isPlaceholder}
          />
        </div>
      </div>

      {/* WhatsApp Simulated Phone / Chat Window */}
      <div className="flex flex-col bg-[#EFEAE2]/60 dark:bg-[#0B141A]/70 transition-colors">
        {/* Simulated WhatsApp Contact Bar */}
        <div className="px-4 py-2.5 bg-[#075E54] dark:bg-[#1F2C34] text-white flex items-center justify-between shadow-xs select-none">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-bold text-xs shrink-0 text-white shadow-xs">
              {activeSampleLead.name ? activeSampleLead.name.charAt(0).toUpperCase() : <Building2 className="w-4 h-4" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center space-x-1.5">
                <span className="text-xs font-bold text-white truncate block">
                  {activeSampleLead.name}
                </span>
                <span className="w-3.5 h-3.5 rounded-full bg-[#25D366] text-white flex items-center justify-center shrink-0 shadow-xs" title={t('campaigns.wizardBusinessAccount') || 'WhatsApp İşletme Hesabı'}>
                  <CheckCircle2 className="w-2.5 h-2.5 fill-white text-[#075E54]" />
                </span>
              </div>
              <div className="flex items-center space-x-1.5 text-[10px] text-emerald-100/90 leading-tight">
                <span className="w-1.5 h-1.5 rounded-full bg-[#25D366] animate-pulse" />
                <span>{t('campaigns.wizardOnline') || 'çevrimiçi'}</span>
                <span>•</span>
                <span className="truncate">{activeSampleLead.category || targetCategory || t('campaigns.wizardAllCategories')}</span>
              </div>
            </div>
          </div>

          <Badge variant="success" className="text-[9px] px-2 py-0.5 font-bold uppercase tracking-wider bg-white/15 text-white border-0">
            {t('campaigns.wizardBusinessAccount') || 'Business'}
          </Badge>
        </div>

        {/* WhatsApp Chat Interior & Message Bubble */}
        <div className="p-4 sm:p-5 min-h-[220px] max-h-[360px] overflow-y-auto flex flex-col justify-end space-y-3">
          {/* Authentic WhatsApp Today Date Pill */}
          <div className="flex justify-center my-1 select-none">
            <span className="px-2.5 py-0.5 rounded-md bg-white/80 dark:bg-[#182229]/90 border border-slate-200/50 dark:border-white/[0.04] text-[10px] font-bold text-slate-500 dark:text-slate-400 shadow-2xs tracking-wider uppercase">
              {t('campaigns.todayDivider')}
            </span>
          </div>

          {isPlaceholder ? (
            <div 
              data-testid="spintax-preview-balloon"
              className="p-5 rounded-2xl bg-white/90 dark:bg-[#1F2C34]/90 border border-dashed border-slate-300 dark:border-white/10 text-center space-y-2 my-auto shadow-xs"
            >
              <div className="w-9 h-9 rounded-xl bg-[#7367F0]/10 text-[#7367F0] flex items-center justify-center mx-auto">
                <Sparkles className="w-4 h-4 animate-pulse" />
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium max-w-xs mx-auto leading-relaxed italic">
                {previewText}
              </p>
            </div>
          ) : (
            <div className="flex justify-end">
              <div
                data-testid="spintax-preview-balloon"
                className="relative max-w-[95%] sm:max-w-[88%] rounded-2xl rounded-tr-xs px-3.5 py-2.5 bg-[#D9FDD3] dark:bg-[#005C4B] text-slate-800 dark:text-[#E9EDEF] shadow-sm border border-[#28C76F]/20 dark:border-[#28C76F]/30 animate-fade-in transition-all"
              >
                {/* Message Content */}
                <div className="text-xs sm:text-[13px] font-sans whitespace-pre-wrap leading-relaxed select-text break-words">
                  {previewText}
                </div>

                {/* Simulated Outgoing Timestamp & Blue Double Checkmarks */}
                <div className="flex items-center justify-end space-x-1 mt-1.5 pt-0.5 text-[10px] text-slate-500 dark:text-slate-300 font-mono select-none">
                  <span>{sampleTime}</span>
                  <CheckCheck className="w-3.5 h-3.5 text-[#53BDEB]" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Simulated Chat Footer / Metadata Bar & Lead Profile Switcher */}
        <div className="px-4 py-2.5 bg-white/90 dark:bg-[#25293C]/90 border-t border-slate-200/60 dark:border-white/[0.06] flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 gap-2">
          <div className="flex items-center space-x-2 min-w-0">
            <div className="w-6 h-6 rounded-full bg-[#7367F0]/10 dark:bg-[#7367F0]/20 text-[#7367F0] flex items-center justify-center font-bold text-[10px] shrink-0">
              {activeSampleLead.name ? activeSampleLead.name.charAt(0).toUpperCase() : 'T'}
            </div>
            <div className="min-w-0">
              <span className="font-semibold text-slate-700 dark:text-slate-200 truncate block">
                {activeSampleLead.name}
              </span>
              <span className="text-[10px] text-slate-400 dark:text-[#7E7F96] truncate block">
                {activeSampleLead.city || t('campaigns.sampleCityFallback')} ({activeSampleLead.district || ''}) • {activeSampleLead.category}
              </span>
            </div>
          </div>

          <div className="flex items-center space-x-1.5 shrink-0 ml-2">
            {!sampleLead && (
              <button
                type="button"
                onClick={handleCycleSampleLead}
                className="px-2 py-1 rounded-md text-[10px] font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-white/[0.06] hover:bg-[#7367F0]/10 hover:text-[#7367F0] transition-colors flex items-center space-x-1 cursor-pointer"
                title={t('campaigns.switchSampleLead')}
              >
                <Users className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{t('campaigns.switchSampleLead')}</span>
              </button>
            )}

            <Badge variant="primary" className="text-[10px] font-mono px-2 py-0.5 font-bold">
              {t('campaigns.variationLabel')} #{iteration + 1}
            </Badge>
          </div>
        </div>
      </div>
    </Card>
  );
};
