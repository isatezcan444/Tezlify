import React from 'react';
import {
  Download,
  ExternalLink,
  File as FileIcon,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Presentation,
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

export interface DocumentCardProps {
  filename?: string | null;
  mimeType?: string | null;
  /** Kimlik dogrulamali medya proxy yolu. Yoksa kart "hazir degil" der. */
  url?: string | null;
  isOutbound?: boolean;
}

type DocVisual = {
  Icon: React.FC<{ className?: string }>;
  /** Ikon yuzeyinin renk sinifi. */
  tone: string;
  label: string;
};

/**
 * Uzantiya/MIME'a gore ikon ve etiket secimi.
 *
 * Neden `mimeType` tek basina yetmiyor: gateway bazi ekleri
 * `application/octet-stream` olarak bildiriyor ve o durumda tur kaybolurdu.
 * Dosya adi uzantisi bu boslugu kapatir; ikisi birlikte kullanilir.
 */
function resolveVisual(filename?: string | null, mimeType?: string | null): DocVisual {
  const ext = (filename || '').toLowerCase().split('.').pop() || '';
  const mime = (mimeType || '').toLowerCase();

  if (ext === 'pdf' || mime.includes('pdf')) {
    return { Icon: FileText, tone: 'bg-rose-500/15 text-rose-500', label: 'PDF' };
  }
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext) || mime.includes('spreadsheet') || mime.includes('excel')) {
    return { Icon: FileSpreadsheet, tone: 'bg-emerald-500/15 text-emerald-500', label: ext.toUpperCase() || 'XLS' };
  }
  if (['ppt', 'pptx', 'odp'].includes(ext) || mime.includes('presentation') || mime.includes('powerpoint')) {
    return { Icon: Presentation, tone: 'bg-amber-500/15 text-amber-500', label: ext.toUpperCase() || 'PPT' };
  }
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext) || mime.includes('zip') || mime.includes('compressed')) {
    return { Icon: FileArchive, tone: 'bg-violet-500/15 text-violet-500', label: ext.toUpperCase() || 'ZIP' };
  }
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext) || mime.includes('word')) {
    return { Icon: FileText, tone: 'bg-sky-500/15 text-sky-500', label: ext.toUpperCase() || 'DOC' };
  }
  return { Icon: FileIcon, tone: 'bg-slate-500/15 text-slate-500', label: ext.toUpperCase() || 'FILE' };
}

/**
 * Belge karti (WhatsApp Web paritesi).
 *
 * Onceki hali yalnizca bir dosya adi, MIME dizesi ve bir indirme simgesiydi —
 * kullanici belgenin TURUNU bir bakista goremiyordu. Bu kart turu ikon ve
 * rozetle soyler, hem acmayi hem indirmeyi ayri eylem olarak sunar.
 *
 * Boyut GOSTERILMEZ ve bu bilinclidir: `messages` tablosunda dosya boyutu
 * sutunu yoktur (bkz. `Message` modeli — media_id/mime/filename/caption var,
 * size yok). Uydurma bir boyut yazmak, olmayan bir veriyi varmis gibi
 * gostermek olurdu (AGENTS.md §1.1).
 */
export const DocumentCard: React.FC<DocumentCardProps> = ({
  filename,
  mimeType,
  url,
  isOutbound = false,
}) => {
  const { t } = useI18n();
  const { Icon, tone, label } = resolveVisual(filename, mimeType);
  const displayName = filename || t('leads.documentFallbackName');
  const surface = isOutbound
    ? 'bg-black/15 border-white/20'
    : 'bg-slate-200/50 dark:bg-white/[0.06] border-black/5 dark:border-white/10';
  const nameColor = isOutbound ? 'text-white' : 'text-slate-800 dark:text-slate-100';
  const mutedColor = isOutbound ? 'text-white/70' : 'text-slate-500 dark:text-slate-400';

  return (
    <div
      data-testid="document-card"
      className={`w-full max-w-[300px] min-w-0 rounded-xl border ${surface} overflow-hidden`}
    >
      <div className="flex items-center gap-3 p-2.5 min-w-0">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${tone}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-bold truncate ${nameColor}`} title={displayName}>
            {displayName}
          </p>
          <p className={`text-[10px] font-bold ${mutedColor}`}>
            {label}
            <span className="font-normal opacity-70"> · {mimeType || t('whatsapp.documentTypeUnknown')}</span>
          </p>
        </div>
      </div>

      {url ? (
        <div className={`flex items-stretch border-t ${isOutbound ? 'border-white/20' : 'border-black/5 dark:border-white/10'}`}>
          {/* "Ac" satir ici acar (tarayici PDF'i kendi goruntuleyicisinde
              gosterir); "Indir" kaydetmeye zorlar. Ikisi farkli niyettir. */}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-bold transition-colors cursor-pointer ${mutedColor} ${
              isOutbound ? 'hover:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/[0.06]'
            }`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>{t('whatsapp.documentOpen')}</span>
          </a>
          <span className={`w-px ${isOutbound ? 'bg-white/20' : 'bg-black/5 dark:bg-white/10'}`} />
          <a
            href={url}
            download={filename || true}
            onClick={(e) => e.stopPropagation()}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-bold transition-colors cursor-pointer ${mutedColor} ${
              isOutbound ? 'hover:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/[0.06]'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            <span>{t('whatsapp.documentDownload')}</span>
          </a>
        </div>
      ) : (
        // Medya gateway'de yoksa "hazir" demek yanlis olurdu; eylemler
        // cizilmez cunku tiklanacak bir sey yok.
        <p className={`px-3 py-2 text-[10px] border-t ${mutedColor} ${
          isOutbound ? 'border-white/20' : 'border-black/5 dark:border-white/10'
        }`}>
          {t('whatsapp.documentUnavailable')}
        </p>
      )}
    </div>
  );
};
