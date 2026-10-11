import { useState, useRef, useEffect, useCallback } from 'react';
import { calculateContextMenuPosition, ContextMenuPositionResult } from '../lib/whatsappContextMenu';

export interface UseMessageContextMenuOptions {
  isSelectMode?: boolean;
}

/**
 * Hook for managing the WhatsApp message context menu state, positioning, and lifecycle.
 *
 * Guarantees:
 * 1. Closes immediately when select mode is activated.
 * 2. Positions the menu within viewport boundaries (clamped top/left and adaptive up/down placement).
 * 3. Safely cleans up scroll, resize, escape key, and click-outside listeners.
 */
export function useMessageContextMenu({ isSelectMode = false }: UseMessageContextMenuOptions = {}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuCoords, setMenuCoords] = useState<ContextMenuPositionResult | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Close menu immediately if multi-select mode is activated
  useEffect(() => {
    if (isSelectMode) {
      setIsMenuOpen(false);
    }
  }, [isSelectMode]);

  const closeMenu = useCallback(() => {
    setIsMenuOpen(false);
  }, []);

  const handleToggleMenu = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isMenuOpen && menuButtonRef.current) {
        const rect = menuButtonRef.current.getBoundingClientRect();
        const coords = calculateContextMenuPosition({
          buttonRect: rect,
          windowWidth: typeof window !== 'undefined' ? window.innerWidth : 1024,
          windowHeight: typeof window !== 'undefined' ? window.innerHeight : 768,
        });
        setMenuCoords(coords);
        setIsMenuOpen(true);
      } else {
        setIsMenuOpen(false);
      }
    },
    [isMenuOpen]
  );

  // Auto-close on scroll, resize, escape or outside click
  useEffect(() => {
    if (!isMenuOpen) return;

    const handleScrollOrResize = () => {
      setIsMenuOpen(false);
    };

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        menuButtonRef.current &&
        !menuButtonRef.current.contains(target)
      ) {
        setIsMenuOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

  return {
    isMenuOpen,
    setIsMenuOpen,
    menuCoords,
    setMenuCoords,
    menuRef,
    menuButtonRef,
    handleToggleMenu,
    closeMenu,
  };
}
