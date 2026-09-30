import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

export interface DropdownItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'danger' | 'warning' | 'primary';
  disabled?: boolean;
}

export interface DropdownProps {
  trigger: React.ReactNode;
  items: (DropdownItem | 'divider')[];
  align?: 'left' | 'right';
  className?: string;
  menuClassName?: string;
  /**
   * Menüyü `document.body`'ye taşır ve konumu tetikleyicinin EKRAN
   * koordinatlarından hesaplar.
   *
   * Neden gerekli: mutlak konumlanan bir menü, kaydırılan bir kapsayıcının
   * (`overflow-y-auto`) içinde kalırsa kırpılır — sohbet listesinde satır
   * menüsü tam olarak böyle kaybolurdu. Portal açıkken konum `position: fixed`
   * ile verilir ve kaydırma/yeniden boyutlandırmada YENİDEN hesaplanır, böylece
   * menü tetikleyiciye bağlı kalır (liste kayarken ekranda asılı kalmaz).
   */
  portal?: boolean;
  /**
   * Açılma/kapanma durumunu çağırana bildirir.
   *
   * Neden gerekli: satır menüsünün tetikleyicisi yalnızca hover'da görünür
   * (WhatsApp Web paritesi). Menü body'ye portallandığı için menünün üzerine
   * gelindiğinde satır artık hover SAYILMAZ ve tetikleyici gözden kaybolurdu —
   * menü açıkken ok kaybolmuş gibi görünür. Çağıran bu sinyalle tetikleyiciyi
   * açıkken sabit tutar.
   */
  onOpenChange?: (open: boolean) => void;
}

export const Dropdown: React.FC<DropdownProps> = ({
  trigger,
  items,
  align = 'right',
  className,
  menuClassName,
  portal = false,
  onOpenChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Menü ekran koordinatlarına yerleştirilir; tetikleyicinin görünür kutusu
  // değiştiğinde (liste kaydı, pencere boyutu) yeniden ölçülür.
  const measure = useCallback(() => {
    const rect = dropdownRef.current?.getBoundingClientRect();
    if (!rect) return;
    const MENU_GAP = 6;
    setCoords(
      align === 'right'
        ? { top: rect.bottom + MENU_GAP, right: window.innerWidth - rect.right }
        : { top: rect.bottom + MENU_GAP, left: rect.left },
    );
  }, [align]);

  // Tek kapi: durumu degistiren her yol (tetikleyici, disari tiklama, Escape,
  // oge secimi) cagirana da haber verir. Ikinci bir bildirim yolu birakmak
  // `onOpenChange`i yalan soyler hale getirirdi.
  const applyOpen = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      onOpenChange?.(open);
    },
    [onOpenChange],
  );

  useEffect(() => {
    // Portal modunda menü DOM'da `dropdownRef`in DIŞINDA yaşar; yalnızca
    // tetikleyiciye bakmak menüye yapılan her tıklamayı "dışarı tıklama"
    // sayardı ve `mousedown` menüyü `click`'ten ÖNCE kapatırdı — öğe hiç
    // çalışmazdı. Bu yüzden iki kapsayıcı birlikte kontrol edilir.
    const isInside = (target: Node) =>
      Boolean(
        dropdownRef.current?.contains(target) || menuRef.current?.contains(target),
      );

    const handleClickOutside = (e: MouseEvent) => {
      if (!isInside(e.target as Node)) applyOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) applyOpen(false);
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
      if (portal) {
        // `capture` şart: kaydırma olayı kabarcıklanmaz, bu yüzden iç
        // kapsayıcıların kaydırması yakalama aşamasında dinlenir.
        window.addEventListener('scroll', measure, true);
        window.addEventListener('resize', measure);
      }
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [isOpen, portal, measure]);

  const toggle = () => {
    if (!isOpen && portal) measure();
    applyOpen(!isOpen);
  };

  const menu = (
    <div
      ref={menuRef}
      data-testid="dropdown-menu"
      style={
        portal && coords
          ? { position: 'fixed', top: coords.top, left: coords.left, right: coords.right }
          : undefined
      }
      className={cn(
        'w-48 rounded-xl bg-white dark:bg-[#2F3349] border border-slate-200/80 dark:border-white/[0.08] shadow-2xl p-1.5 z-[99999] animate-scale-in',
        portal ? 'fixed' : 'absolute mt-1.5',
        !portal && (align === 'right' ? 'right-0' : 'left-0'),
        menuClassName,
      )}
    >
      {items.map((item, idx) => {
        if (item === 'divider') {
          return (
            <div
              key={`div-${idx}`}
              className="my-1 border-t border-slate-100 dark:border-white/[0.06]"
            />
          );
        }

        const variantClasses = {
          default: 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/[0.04] hover:text-[#7367F0]',
          primary: 'text-[#7367F0] hover:bg-[#7367F0]/10',
          warning: 'text-[#FF9F43] hover:bg-[#FF9F43]/10',
          danger: 'text-[#EA5455] hover:bg-[#EA5455]/10',
        };

        return (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                applyOpen(false);
              }
            }}
            className={cn(
              'w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center space-x-2 transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none',
              variantClasses[item.variant || 'default']
            )}
          >
            {item.icon && <span className="w-4 h-4 shrink-0 flex items-center justify-center">{item.icon}</span>}
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={cn('relative inline-block text-left', className)} ref={dropdownRef}>
      <div
        onClick={toggle}
        onKeyDown={(e) => {
          // Tetikleyici bir `<span role="button" tabIndex={0}>` olabilir
          // (satir menusu boyle); o durumda Enter/Space hicbir sey yapmazdi ve
          // menu yalnizca fareyle acilirdi.
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            toggle();
          }
        }}
        className="cursor-pointer"
      >
        {trigger}
      </div>

      {isOpen && (portal ? createPortal(menu, document.body) : menu)}
    </div>
  );
};
