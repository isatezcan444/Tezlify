import React, { useState } from 'react';
import { ExternalLink, Play } from 'lucide-react';
import { LinkPreview } from '../../../types';
import { useI18n } from '../../../context/I18nContext';
import { resolveMediaUrl } from '../../../lib/mediaUrl';

export interface LinkPreviewCardProps {
  preview: LinkPreview;
  /** Giden mesaj balonunda renkler farkli (balon mor). */
  isOutbound?: boolean;
}

/**
 * Bir mesaj govdesindeki link icin WhatsApp Web tarzi onizleme karti.
 *
 * Iki tasarim karari burada kilitlidir:
 *
 * 1. **Gorsel her zaman proxy uzerinden yuklenir.** `preview.image_url`
 *    sunucunun urettigi kimlik dogrulamali yoldur, uzak adres DEGILDIR.
 *    Uzak adresi dogrudan yuklemek kullanicinin IP'sini ve tarayici parmak
 *    izini saglayiciya sizdirir; `referrerPolicy` de bu yuzden konuldu.
 *
 * 2. **Gomme (iframe) TIKLAYINCA yuklenir ve yalnizca `embed_url` varsa.**
 *    `embed_url` sunucuda yalnizca izin listesindeki saglayicilar icin
 *    doldurulur; keyfi bir URL'i iframe'e koymak, kullanicinin oturum
 *    cerezleriyle ucuncu taraf icerik calistirmak demektir.
 */
export const LinkPreviewCard: React.FC<LinkPreviewCardProps> = ({
  preview,
  isOutbound = false,
}) => {
  const { t } = useI18n();
  const [embedOpen, setEmbedOpen] = useState(false);
  const [imageError, setImageError] = useState(false);

  const resolvedImageUrl = resolveMediaUrl(preview.image_url);
  const hasImage = Boolean(resolvedImageUrl) && !imageError;
  const canEmbed = Boolean(preview.embed_url);
  const headline = preview.title || preview.site_name || preview.url;
  const surface = isOutbound
    ? 'bg-black/15 border-white/20'
    : 'bg-slate-200/50 dark:bg-white/[0.06] border-black/5 dark:border-white/10';
  const titleColor = isOutbound ? 'text-white' : 'text-slate-800 dark:text-slate-100';
  const mutedColor = isOutbound ? 'text-white/70' : 'text-slate-500 dark:text-slate-400';

  return (
    <div
      data-testid="link-preview-card"
      className={`mt-1.5 mb-1 w-full max-w-[320px] min-w-0 rounded-xl overflow-hidden border ${surface}`}
    >
      {/* Gomme acikken gorsel yerine oynatici gosterilir. */}
      {embedOpen && preview.embed_url ? (
        <div className="relative w-full aspect-video bg-black">
          <iframe
            src={preview.embed_url}
            title={headline}
            data-testid="link-preview-embed"
            className="absolute inset-0 w-full h-full"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        hasImage && (
          <button
            type="button"
            data-testid="link-preview-media"
            onClick={(e) => {
              e.stopPropagation();
              // Yalnizca gomulebilir bir saglayici varsa gomme acilir; aksi
              // halde gorsel de linke goturur (WhatsApp Web davranisi).
              if (canEmbed) setEmbedOpen(true);
              else window.open(preview.url, '_blank', 'noopener,noreferrer');
            }}
            className="relative block w-full cursor-pointer group/preview"
          >
            <img
              src={resolvedImageUrl}
              alt={headline}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setImageError(true)}
              className="w-full h-auto max-h-44 object-cover"
            />
            {canEmbed && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/25 group-hover/preview:bg-black/35 transition-colors">
                <span className="w-11 h-11 rounded-full bg-white/90 flex items-center justify-center shadow-md">
                  <Play className="w-5 h-5 text-slate-900 translate-x-[1px]" fill="currentColor" />
                </span>
              </span>
            )}
          </button>
        )
      )}

      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="block px-3 py-2 space-y-0.5 min-w-0"
      >
        {preview.site_name && (
          <p className={`text-[10px] font-bold uppercase tracking-wide truncate ${mutedColor}`}>
            {preview.site_name}
          </p>
        )}
        <p className={`text-xs font-bold leading-snug line-clamp-2 [overflow-wrap:anywhere] ${titleColor}`}>
          {headline}
        </p>
        {preview.description && (
          <p className={`text-[11px] leading-snug line-clamp-2 [overflow-wrap:anywhere] ${mutedColor}`}>
            {preview.description}
          </p>
        )}
        <p className={`flex items-center gap-1 text-[10px] pt-0.5 ${mutedColor}`}>
          <ExternalLink className="w-3 h-3 shrink-0" />
          <span className="truncate">{t('whatsapp.linkPreviewOpen')}</span>
        </p>
      </a>
    </div>
  );
};
