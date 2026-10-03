import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Download,
  Printer,
  Copy,
  Check,
  ExternalLink,
  ArrowLeft,
  FileText,
  FileSpreadsheet,
  FileArchive,
  Presentation,
  File as FileIcon,
  Loader2,
  WrapText,
  AlertCircle,
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

export interface DocumentViewerProps {
  isOpen: boolean;
  onClose: () => void;
  src?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  fileSize?: string | number | null;
  senderName?: string;
  timestamp?: string;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0 || !Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function resolveDocVisual(filename?: string | null, mimeType?: string | null) {
  const ext = (filename || '').toLowerCase().split('.').pop() || '';
  const mime = (mimeType || '').toLowerCase();

  if (ext === 'pdf' || mime.includes('pdf')) {
    return { Icon: FileText, tone: 'bg-rose-500/15 text-rose-500 border-rose-500/30', label: 'PDF' };
  }
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext) || mime.includes('spreadsheet') || mime.includes('excel')) {
    return { Icon: FileSpreadsheet, tone: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30', label: ext.toUpperCase() || 'XLS' };
  }
  if (['ppt', 'pptx', 'odp'].includes(ext) || mime.includes('presentation') || mime.includes('powerpoint')) {
    return { Icon: Presentation, tone: 'bg-amber-500/15 text-amber-500 border-amber-500/30', label: ext.toUpperCase() || 'PPT' };
  }
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext) || mime.includes('zip') || mime.includes('compressed')) {
    return { Icon: FileArchive, tone: 'bg-violet-500/15 text-violet-500 border-violet-500/30', label: ext.toUpperCase() || 'ZIP' };
  }
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext) || mime.includes('word')) {
    return { Icon: FileText, tone: 'bg-sky-500/15 text-sky-500 border-sky-500/30', label: ext.toUpperCase() || 'DOC' };
  }
  if (['txt', 'json', 'log', 'md', 'xml', 'yaml', 'yml', 'js', 'ts', 'py', 'sql', 'sh', 'html', 'css'].includes(ext) || mime.includes('text') || mime.includes('json')) {
    return { Icon: FileText, tone: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30', label: ext.toUpperCase() || 'TXT' };
  }
  return { Icon: FileIcon, tone: 'bg-slate-500/15 text-slate-400 border-slate-500/30', label: ext.toUpperCase() || 'FILE' };
}

export const DocumentViewer: React.FC<DocumentViewerProps> = ({
  isOpen,
  onClose,
  src,
  filename,
  mimeType,
  fileSize,
  senderName,
  timestamp,
}) => {
  const { t } = useI18n();
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [resolvedSize, setResolvedSize] = useState<string | null>(() => {
    if (typeof fileSize === 'number') return formatBytes(fileSize);
    if (typeof fileSize === 'string') return fileSize;
    return null;
  });

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const ext = (filename || '').toLowerCase().split('.').pop() || '';
  const mime = (mimeType || '').toLowerCase();

  const isPdf = ext === 'pdf' || mime.includes('pdf');
  const isText =
    ['txt', 'csv', 'json', 'log', 'md', 'xml', 'yaml', 'yml', 'js', 'ts', 'py', 'sql', 'sh', 'html', 'css'].includes(ext) ||
    mime.includes('text') ||
    mime.includes('json');

  const { Icon, tone, label } = resolveDocVisual(filename, mimeType);
  const displayName = filename || t('leads.documentFallbackName');

  // Keyboard navigation: Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    if (isOpen) {
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
  }, [isOpen]);

  // Fetch size via HEAD request if not provided
  useEffect(() => {
    if (!isOpen || !src || resolvedSize) return;
    const controller = new AbortController();
    fetch(src, { method: 'HEAD', signal: controller.signal })
      .then((res) => {
        const len = res.headers.get('content-length');
        if (len) {
          const parsed = parseInt(len, 10);
          if (parsed > 0) setResolvedSize(formatBytes(parsed));
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [isOpen, src, resolvedSize]);

  // Load text content for text-based documents
  useEffect(() => {
    if (!isOpen || !src || !isText) {
      setTextContent(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(src, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        setTextContent(text);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setError(err.message || t('whatsapp.documentPreviewError'));
        }
      })
      .finally(() => {
        setLoading(false);
      });

    return () => controller.abort();
  }, [isOpen, src, isText, t]);

  const handleCopy = useCallback(() => {
    if (!textContent) return;
    navigator.clipboard.writeText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [textContent]);

  const handlePrint = useCallback(() => {
    if (isPdf && iframeRef.current?.contentWindow) {
      try {
        iframeRef.current.contentWindow.focus();
        iframeRef.current.contentWindow.print();
        return;
      } catch {
        // Fallback to window.print if iframe cross-origin blocks
      }
    }
    window.print();
  }, [isPdf]);

  const handleDownload = useCallback(async () => {
    if (!src || downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = displayName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(src, '_blank');
    } finally {
      setDownloading(false);
    }
  }, [src, displayName, downloading]);

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={displayName}
      tabIndex={-1}
      className="fixed inset-0 z-[99999] flex flex-col bg-[#0b141a]/95 backdrop-blur-md select-none outline-hidden"
    >
      {/* Top Header Bar */}
      <header className="h-16 px-4 flex items-center justify-between bg-black/40 border-b border-white/10 shrink-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('whatsapp.mediaClose')}
            title={t('whatsapp.mediaClose')}
            className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border ${tone}`}>
            <Icon className="w-4 h-4" />
          </div>

          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white truncate max-w-[220px] sm:max-w-md md:max-w-lg" title={displayName}>
              {displayName}
            </h2>
            <p className="text-xs text-slate-400 truncate flex items-center gap-1.5">
              <span className="font-bold text-slate-300">{label}</span>
              {resolvedSize && (
                <>
                  <span>·</span>
                  <span>{resolvedSize}</span>
                </>
              )}
              {senderName && (
                <>
                  <span>·</span>
                  <span>{senderName}</span>
                </>
              )}
              {timestamp && (
                <>
                  <span>·</span>
                  <span>{timestamp}</span>
                </>
              )}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1 sm:gap-2">
          {/* Copy Text for code/txt */}
          {isText && textContent && (
            <>
              <button
                type="button"
                onClick={() => setWrapLines((w) => !w)}
                title={t('whatsapp.documentWrapLines')}
                aria-label={t('whatsapp.documentWrapLines')}
                className={`p-2 rounded-full transition-colors cursor-pointer ${
                  wrapLines ? 'text-[#00a884] bg-white/10' : 'text-slate-300 hover:text-white hover:bg-white/10'
                }`}
              >
                <WrapText className="w-5 h-5" />
              </button>

              <button
                type="button"
                onClick={handleCopy}
                title={copied ? t('whatsapp.documentCopiedText') : t('whatsapp.documentCopyText')}
                aria-label={copied ? t('whatsapp.documentCopiedText') : t('whatsapp.documentCopyText')}
                className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                {copied ? <Check className="w-5 h-5 text-[#00a884]" /> : <Copy className="w-5 h-5" />}
              </button>
            </>
          )}

          {/* Print for PDF */}
          {isPdf && (
            <button
              type="button"
              onClick={handlePrint}
              title={t('whatsapp.documentPrint')}
              aria-label={t('whatsapp.documentPrint')}
              className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <Printer className="w-5 h-5" />
            </button>
          )}

          {/* Open in New Tab */}
          {src && (
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              title={t('whatsapp.documentOpenNewTab')}
              aria-label={t('whatsapp.documentOpenNewTab')}
              className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <ExternalLink className="w-5 h-5" />
            </a>
          )}

          {/* Direct Download */}
          {src && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              title={t('whatsapp.documentDownload')}
              aria-label={t('whatsapp.documentDownload')}
              className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-40 transition-colors cursor-pointer"
            >
              {downloading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
            </button>
          )}

          <div className="w-px h-6 bg-white/10 mx-1" />

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            title={t('whatsapp.mediaClose')}
            aria-label={t('whatsapp.mediaClose')}
            className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Document Content Canvas */}
      <main className="flex-1 min-h-0 relative flex flex-col items-center justify-center p-3 sm:p-6 overflow-hidden">
        {/* PDF Viewer */}
        {isPdf && src && (
          <div className="w-full h-full max-w-5xl bg-[#111b21] rounded-xl shadow-2xl border border-white/10 overflow-hidden flex flex-col">
            <iframe
              ref={iframeRef}
              src={`${src}#toolbar=1&navpanes=0`}
              title={displayName}
              className="w-full h-full border-none bg-[#202c33]"
            />
          </div>
        )}

        {/* Text / Code Viewer */}
        {isText && (
          <div className="w-full h-full max-w-5xl bg-[#111b21] rounded-xl shadow-2xl border border-white/10 overflow-hidden flex flex-col">
            {loading ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
                <Loader2 className="w-8 h-8 animate-spin mb-3 text-[#00a884]" />
                <p className="text-xs font-medium">{t('whatsapp.documentPreviewLoading')}</p>
              </div>
            ) : error ? (
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-slate-300">
                <AlertCircle className="w-10 h-10 text-rose-500 mb-2" />
                <p className="text-sm font-semibold text-rose-400 mb-1">{error}</p>
                <p className="text-xs text-slate-400 mb-4">{t('whatsapp.documentDirectDownloadPrompt')}</p>
                {src && (
                  <button
                    type="button"
                    onClick={handleDownload}
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#00a884] hover:bg-[#009272] text-white transition-colors cursor-pointer flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    <span>{t('whatsapp.documentDownload')}</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="flex-1 overflow-auto p-4 sm:p-6 font-mono text-xs text-slate-200 select-text leading-relaxed">
                <pre className={`m-0 font-mono ${wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto'}`}>
                  {textContent}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Binary / Office Documents (Non-Inline Previews) */}
        {!isPdf && !isText && (
          <div className="max-w-md w-full p-8 bg-[#111b21] rounded-2xl shadow-2xl border border-white/10 text-center flex flex-col items-center">
            <div className={`w-20 h-20 rounded-2xl flex items-center justify-center border-2 mb-4 ${tone}`}>
              <Icon className="w-10 h-10" />
            </div>

            <h3 className="text-base font-bold text-white mb-1.5 break-all">
              {displayName}
            </h3>

            <p className="text-xs text-slate-400 mb-4">
              <span className="font-semibold text-slate-300">{label}</span>
              {resolvedSize && <span> · {resolvedSize}</span>}
              <span> · {mimeType || t('whatsapp.documentTypeUnknown')}</span>
            </p>

            <p className="text-xs text-slate-400 mb-6 leading-relaxed">
              {t('whatsapp.documentNoPreviewAvailable')}
              <br />
              {t('whatsapp.documentDirectDownloadPrompt')}
            </p>

            <div className="flex items-center gap-3 w-full">
              {src && (
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={downloading}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-[#00a884] hover:bg-[#009272] text-white text-xs font-bold transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  <span>{t('whatsapp.documentDownload')}</span>
                </button>
              )}

              {src && (
                <a
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="py-2.5 px-4 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>{t('whatsapp.documentOpenNewTab')}</span>
                </a>
              )}
            </div>
          </div>
        )}
      </main>
    </div>,
    document.body
  );
};
