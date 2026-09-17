import React, { useState, useMemo } from 'react';
import { Sparkles, RefreshCw, Copy, Check } from 'lucide-react';
import { Card } from '../../../components/ui/card';
import { IconButton } from '../../../components/ui/IconButton';
import { useI18n } from '../../../context/I18nContext';
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

export const SpintaxPreviewCard: React.FC<SpintaxPreviewCardProps> = ({
  template,
  targetCategory,
  sampleLead,
  className,
}) => {
  const { language, t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [iteration, setIteration] = useState(0);

  const activeSampleLead = useMemo(() => {
    if (sampleLead) {
      return {
        ...sampleLead,
        category: targetCategory || sampleLead.category,
      };
    }
    if (language === 'en') {
      return {
        name: 'Apex Health Partners',
        city: 'London',
        district: 'Westminster',
        category: targetCategory || 'Dental Clinics',
        rating: 4.9,
      };
    }
    return {
      name: 'Özel DentaLine Polikliniği',
      city: 'İstanbul',
      district: 'Kadıköy',
      category: targetCategory || 'Diş Klinikleri',
      rating: 4.9,
    };
  }, [sampleLead, targetCategory, language]);

  // Spintax Resolver: {opt1|opt2|opt3} and {name}/{isim}, {city}/{şehir}, {district}/{ilçe}, {category}/{kategori}, {rating}/{puan}
  const resolveSpintax = (text: string) => {
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
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)];
      }
      return match;
    });

    return resolved;
  };

  const previewText = useMemo(() => {
    if (!template || !template.trim()) {
      return t('campaigns.templateEmptyNotice') || (language === 'tr' 
        ? 'İletişim amacınızı seçip bilgileri doldurduğunuzda mesajınız burada otomatik olarak görünecek.' 
        : 'Once you select a communication goal and fill in details, your live preview will appear here.');
    }
    return resolveSpintax(template);
  }, [template, iteration, activeSampleLead, language, t]);

  const handleCopy = () => {
    if (!previewText) return;
    navigator.clipboard.writeText(previewText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isPlaceholder = !template || !template.trim();

  return (
    <Card className={cn('p-6 space-y-4', className)}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-white/[0.06]">
        <div className="flex items-center space-x-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-sm font-extrabold text-slate-800 dark:text-white leading-tight">
              {t('campaigns.livePreview') || 'Canlı Önizleme'}
            </h4>
            <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] mt-0.5">
              {t('campaigns.livePreviewSubtitle') || 'Oluşturulan mesajın anlık görünümü'}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-1 shrink-0 self-end sm:self-center">
          <IconButton
            icon={RefreshCw}
            size="sm"
            variant="ghost"
            tooltip={t('campaigns.regenerateTemplateBtn') || 'Farklı Varyasyon Üret'}
            onClick={() => setIteration((i) => i + 1)}
          />
          <IconButton
            icon={copied ? Check : Copy}
            size="sm"
            variant={copied ? 'success' : 'ghost'}
            tooltip={copied ? (t('common.copied') || 'Kopyalandı') : (t('common.copy') || 'Metni Kopyala')}
            onClick={handleCopy}
            disabled={isPlaceholder}
          />
        </div>
      </div>

      {/* WhatsApp Message Balloon Preview */}
      <div 
        data-testid="spintax-preview-balloon"
        className={cn(
          'p-3.5 rounded-xl border shadow-sm relative text-xs whitespace-pre-wrap font-sans leading-relaxed transition-colors',
          isPlaceholder 
            ? 'bg-slate-100/70 dark:bg-[#25293C]/70 border-dashed border-slate-300 dark:border-white/10 text-slate-400 dark:text-slate-500 italic'
            : 'bg-white dark:bg-[#2F3349] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200'
        )}
      >
        {previewText}
      </div>

      <div className="flex items-center justify-between text-[10px] text-slate-400 font-medium">
        <span>
          {t('campaigns.sampleLeadLabel')}: {activeSampleLead.name}
        </span>
        <span>
          {t('campaigns.variationLabel')}: #{iteration + 1}
        </span>
      </div>
    </Card>
  );
};
