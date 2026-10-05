import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Download,
  RotateCw,
  ZoomIn,
  ZoomOut,
  ArrowLeft,
  FileQuestion,
  Loader2,
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

export interface MediaLightboxProps {
  isOpen: boolean;
  onClose: () => void;
  src?: string | null;
  mediaType?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  caption?: string | null;
  filename?: string | null;
  senderName?: string;
  timestamp?: string;
}

export const MediaLightbox: React.FC<MediaLightboxProps> = ({
  isOpen,
  onClose,
  src,
  mediaType = 'IMAGE',
  caption,
  filename,
  senderName,
  timestamp,
}) => {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [downloading, setDownloading] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [mediaLoaded, setMediaLoaded] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const [isClosing, setIsClosing] = useState(false);
  const [shouldRender, setShouldRender] = useState(isOpen);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
    } else if (shouldRender) {
      setIsClosing(true);
      const timer = setTimeout(() => {
        setShouldRender(false);
        setIsClosing(false);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen, shouldRender]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
    }, 200);
  };

  // Reset state on open or src change
  useEffect(() => {
    if (isOpen) {
      setZoom(1);
      setRotation(0);
      setPan({ x: 0, y: 0 });
      setMediaError(false);
      setMediaLoaded(false);
    }
  }, [isOpen, src]);

  // Keyboard navigation: Escape to close, + / - to zoom, R to rotate, 0 to reset
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setZoom((prev) => Math.min(prev + 0.25, 4));
      } else if (e.key === '-') {
        e.preventDefault();
        setZoom((prev) => {
          const next = Math.max(prev - 0.25, 0.5);
          if (next <= 1) setPan({ x: 0, y: 0 });
          return next;
        });
      } else if (e.key === '0') {
        e.preventDefault();
        setZoom(1);
        setPan({ x: 0, y: 0 });
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        setRotation((prev) => (prev + 90) % 360);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    setZoom((prev) => Math.min(prev + 0.25, 4));
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    setZoom((prev) => {
      const next = Math.max(prev - 0.25, 0.5);
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const handleResetZoom = (e: React.MouseEvent) => {
    e.stopPropagation();
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotation(0);
  };

  const handleRotate = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRotation((prev) => (prev + 90) % 360);
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!src || downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename || (mediaType === 'VIDEO' ? 'video.mp4' : 'image.jpeg');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(blobUrl);
    } catch {
      // Fallback: direct window anchor trigger
      const a = document.createElement('a');
      a.href = src;
      a.download = filename || (mediaType === 'VIDEO' ? 'video.mp4' : 'image.jpeg');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      setDownloading(false);
    }
  };

  // Mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.2 : -0.2;
    setZoom((prev) => {
      const next = Math.min(Math.max(prev + delta, 0.5), 4);
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  // Double click to toggle zoom
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (zoom > 1.2) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } else {
      setZoom(2);
    }
  };

  // Drag pan handling when zoomed
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || zoom <= 1) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  if (!shouldRender || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('whatsapp.mediaOpenLightbox')}
      tabIndex={-1}
      className={`fixed inset-0 z-[99999] flex flex-col bg-[#0b141a]/95 backdrop-blur-md select-none outline-hidden transition-all duration-200 ease-out ${
        isClosing ? 'opacity-0 scale-[0.98]' : 'opacity-100 scale-100 animate-in fade-in zoom-in-95 duration-200'
      }`}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
    >
      {/* Top Header Bar */}
      <header className="h-16 px-4 flex items-center justify-between bg-black/40 border-b border-white/10 shrink-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={handleClose}
            aria-label={t('whatsapp.mediaClose')}
            className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 active:scale-90 transition-all cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            {senderName && (
              <h2 className="text-sm font-semibold text-white truncate max-w-[200px] sm:max-w-xs md:max-w-md">
                {senderName}
              </h2>
            )}
            {timestamp && (
              <p className="text-xs text-slate-400 truncate">
                {timestamp}
              </p>
            )}
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1 sm:gap-2">
          {mediaType === 'IMAGE' && (
            <>
              <button
                type="button"
                onClick={handleZoomOut}
                disabled={zoom <= 0.5}
                title={t('whatsapp.mediaZoomOut')}
                aria-label={t('whatsapp.mediaZoomOut')}
                className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <ZoomOut className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>

              <button
                type="button"
                onClick={handleResetZoom}
                title={t('whatsapp.mediaResetZoom')}
                className="px-2 py-1 text-xs font-mono font-medium rounded-md text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
              >
                {Math.round(zoom * 100)}%
              </button>

              <button
                type="button"
                onClick={handleZoomIn}
                disabled={zoom >= 4}
                title={t('whatsapp.mediaZoomIn')}
                aria-label={t('whatsapp.mediaZoomIn')}
                className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <ZoomIn className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>

              <button
                type="button"
                onClick={handleRotate}
                title={t('whatsapp.mediaRotate')}
                aria-label={t('whatsapp.mediaRotate')}
                className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <RotateCw className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            </>
          )}

          {src && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              title={t('whatsapp.mediaDownload')}
              aria-label={t('whatsapp.mediaDownload')}
              className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              {downloading ? (
                <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin text-[#25D366]" />
              ) : (
                <Download className="w-4 h-4 sm:w-5 sm:h-5" />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={handleClose}
            title={t('whatsapp.mediaClose')}
            aria-label={t('whatsapp.mediaClose')}
            className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 active:scale-90 transition-all cursor-pointer ml-1"
          >
            <X className="w-5 h-5 sm:w-6 sm:h-6" />
          </button>
        </div>
      </header>

      {/* Main Canvas Area */}
      <main
        className="flex-1 relative overflow-hidden flex items-center justify-center p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget && zoom <= 1) {
            onClose();
          }
        }}
      >
        {!src || mediaError ? (
          <div className="flex flex-col items-center justify-center p-8 text-center text-slate-400 bg-white/5 rounded-2xl border border-white/10 max-w-sm">
            <FileQuestion className="w-16 h-16 mb-4 text-slate-500 opacity-60" />
            <p className="text-base font-semibold text-slate-200 mb-1">
              {t('whatsapp.mediaLoadFailed')}
            </p>
            <p className="text-xs text-slate-400 mb-4">
              {filename || t('whatsapp.documentTypeUnknown')}
            </p>
            {src && (
              <button
                type="button"
                onClick={() => {
                  setMediaError(false);
                  setMediaLoaded(false);
                }}
                className="px-4 py-2 rounded-lg bg-[#00a884] hover:bg-[#009272] text-white text-xs font-semibold shadow-md transition-colors"
              >
                {t('whatsapp.mediaRetry')}
              </button>
            )}
          </div>
        ) : mediaType === 'VIDEO' ? (
          <div className="max-w-4xl max-h-[80vh] w-full flex items-center justify-center">
            <video
              src={src}
              controls
              autoPlay
              playsInline
              className="max-h-[80vh] max-w-full rounded-lg shadow-2xl object-contain"
            />
          </div>
        ) : (
          <div
            className={`relative flex items-center justify-center transition-transform ${
              isDragging ? 'cursor-grabbing duration-0' : zoom > 1 ? 'cursor-grab duration-150 ease-out' : 'cursor-zoom-in duration-200'
            }`}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
            }}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
          >
            {!mediaLoaded && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="w-10 h-10 animate-spin text-[#00a884]" />
              </div>
            )}
            <img
              src={src}
              alt={caption || filename || 'Media preview'}
              onLoad={() => setMediaLoaded(true)}
              onError={() => {
                setMediaError(true);
                setMediaLoaded(true);
              }}
              draggable={false}
              className={`max-h-[82vh] max-w-[90vw] object-contain rounded-lg shadow-2xl select-none transition-opacity duration-200 ${
                mediaLoaded ? 'opacity-100' : 'opacity-0'
              }`}
            />
          </div>
        )}

        {/* Bottom Floating Caption Pill */}
        {caption && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 max-w-xl w-[90%] px-5 py-2.5 rounded-2xl bg-black/70 backdrop-blur-md border border-white/10 text-white text-xs sm:text-sm text-center shadow-2xl z-20 pointer-events-auto">
            <p className="whitespace-pre-wrap break-words">{caption}</p>
          </div>
        )}
      </main>
    </div>,
    document.body
  );
};
