import React, { useState, useEffect } from 'react';
import {
  Download,
  ExternalLink,
  Eye,
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { resolveMediaUrl } from '../../../lib/mediaUrl';
import { DocumentViewer, resolveDocVisual } from './DocumentViewer';

export interface DocumentCardProps {
  filename?: string | null;
  mimeType?: string | null;
  /** Kimlik dogrulamali medya proxy yolu. Yoksa kart "hazir degil" der. */
  url?: string | null;
  fileSize?: string | number | null;
  senderName?: string;
  timestamp?: string;
  isOutbound?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0 || !Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Belge karti (WhatsApp Web paritesi).
 *
 * Tıklandığında doğrudan tam ekran / modal belge görüntüleyicisini (DocumentViewer) açar.
 * PDF, metin, kod ve ofis/arşiv dosyalarını tam görsel zenginlikle destekler.
 */
export const DocumentCard: React.FC<DocumentCardProps> = ({
  filename,
  mimeType,
  url,
  fileSize,
  senderName,
  timestamp,
  isOutbound = false,
}) => {
  const { t } = useI18n();
  const { Icon, tone, label } = resolveDocVisual(filename, mimeType);
  const displayName = filename || t('leads.documentFallbackName');
  const resolvedUrl = resolveMediaUrl(url);

  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [resolvedSize, setResolvedSize] = useState<string | null>(() => {
    if (typeof fileSize === 'number') return formatBytes(fileSize);
    if (typeof fileSize === 'string') return fileSize;
    return null;
  });

  // Automatically fetch size via HEAD request if not provided
  useEffect(() => {
    if (!resolvedUrl || resolvedSize) return;
    const controller = new AbortController();
    fetch(resolvedUrl, { method: 'HEAD', signal: controller.signal })
      .then((res) => {
        const len = res.headers.get('content-length');
        if (len) {
          const parsed = parseInt(len, 10);
          if (parsed > 0) setResolvedSize(formatBytes(parsed));
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [resolvedUrl, resolvedSize]);

  const surface = isOutbound
    ? 'bg-black/15 border-white/20'
    : 'bg-slate-200/50 dark:bg-white/[0.06] border-black/5 dark:border-white/10';
  const nameColor = isOutbound ? 'text-white' : 'text-slate-800 dark:text-slate-100';
  const mutedColor = isOutbound ? 'text-white/70' : 'text-slate-500 dark:text-slate-400';

  return (
    <>
      <div
        data-testid="document-card"
        className={`w-full max-w-[300px] min-w-0 rounded-xl border ${surface} overflow-hidden shadow-xs`}
      >
        {/* Clickable Header Area */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (resolvedUrl) setIsViewerOpen(true);
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && resolvedUrl) {
              e.preventDefault();
              setIsViewerOpen(true);
            }
          }}
          className={`flex items-center gap-3 p-2.5 min-w-0 ${
            resolvedUrl ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors' : ''
          }`}
          title={displayName}
        >
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border ${tone}`}>
            <Icon className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className={`text-xs font-bold truncate ${nameColor}`} title={displayName}>
              {displayName}
            </p>
            <p className={`text-[10px] font-bold ${mutedColor} flex items-center gap-1`}>
              <span>{label}</span>
              {resolvedSize && (
                <>
                  <span>·</span>
                  <span>{resolvedSize}</span>
                </>
              )}
              <span className="font-normal opacity-70 truncate"> · {mimeType || t('whatsapp.documentTypeUnknown')}</span>
            </p>
          </div>
        </div>

        {/* Action Toolbar */}
        {resolvedUrl ? (
          <div className={`flex items-stretch border-t ${isOutbound ? 'border-white/20' : 'border-black/5 dark:border-white/10'}`}>
            <button
              type="button"
              data-testid="document-preview-btn"
              onClick={(e) => {
                e.stopPropagation();
                setIsViewerOpen(true);
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-bold transition-colors cursor-pointer ${mutedColor} ${
                isOutbound ? 'hover:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/[0.06]'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>{t('whatsapp.documentPreview')}</span>
            </button>

            <span className={`w-px ${isOutbound ? 'bg-white/20' : 'bg-black/5 dark:bg-white/10'}`} />

            <a
              href={resolvedUrl}
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
              href={resolvedUrl}
              download={displayName}
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
          <p className={`px-3 py-2 text-[10px] border-t ${mutedColor} ${
            isOutbound ? 'border-white/20' : 'border-black/5 dark:border-white/10'
          }`}>
            {t('whatsapp.documentUnavailable')}
          </p>
        )}
      </div>

      {/* Authentic Full-Screen Document / PDF Lightbox */}
      <DocumentViewer
        isOpen={isViewerOpen}
        onClose={() => setIsViewerOpen(false)}
        src={resolvedUrl}
        filename={displayName}
        mimeType={mimeType}
        fileSize={resolvedSize || fileSize}
        senderName={senderName}
        timestamp={timestamp}
      />
    </>
  );
};
