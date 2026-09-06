import React from 'react';
import { Search, Sun, Moon, Bell, Menu, Settings, LogOut } from 'lucide-react';
import { Button } from '../ui/button';
import { useTheme } from '../../context/ThemeContext';
import { useI18n } from '../../context/I18nContext';
import { useAuth } from '../../context/AuthContext';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';

interface TopHeaderProps {
  title: string;
  subtitle?: string;
  menuButtonTitle?: string;
  onOpenQuickScrape?: () => void;
  onToggleMobileMenu?: () => void;
  onOpenSettings?: () => void;
}

export const TopHeader: React.FC<TopHeaderProps> = ({
  title,
  subtitle,
  menuButtonTitle,
  onOpenQuickScrape,
  onToggleMobileMenu,
  onOpenSettings,
}) => {
  const { theme, toggleTheme } = useTheme();
  const { t } = useI18n();
  const { user, profile, signOut } = useAuth();

  const userDisplayName = profile?.full_name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || t('header.adminUser');
  const userEmail = profile?.email || user?.email || '';
  const avatarUrl = profile?.avatar_url || user?.user_metadata?.avatar_url || user?.user_metadata?.picture;
  const initials = (userDisplayName.slice(0, 2) || 'TZ').toUpperCase();

  return (
    <header className="sticky top-0 z-30 px-3.5 sm:px-6 lg:px-8 pt-3.5 sm:pt-6 pb-2 select-none">
      <div className="h-14 sm:h-16 px-3 sm:px-6 rounded-xl bg-white/95 dark:bg-[#2F3349]/95 backdrop-blur-xl border border-slate-200/80 dark:border-white/[0.08] shadow-sm flex items-center justify-between transition-colors duration-200 gap-2">
        {/* Left Side: Mobile Menu Button & Page Title */}
        <div className="flex items-center space-x-2.5 sm:space-x-3 truncate">
          {onToggleMobileMenu && (
            <button
              type="button"
              onClick={onToggleMobileMenu}
              className="lg:hidden p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
              title={menuButtonTitle ?? t('common.menuTitle')}
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          <div className="truncate">
            <h1 className="text-sm sm:text-base md:text-lg font-extrabold text-slate-800 dark:text-white tracking-tight truncate">
              {title}
            </h1>
            {subtitle && (
              <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium hidden md:block truncate">
                {subtitle}
              </p>
            )}
          </div>
        </div>

        {/* Right Side: Quick Actions & Profile */}
        <div className="flex items-center space-x-1.5 sm:space-x-2.5 shrink-0">
          {onOpenQuickScrape && (
            <Button
              onClick={onOpenQuickScrape}
              size="sm"
              className="space-x-1.5 font-bold shadow-sm text-xs hidden sm:inline-flex h-9 px-3 cursor-pointer"
            >
              <Search className="w-3.5 h-3.5" />
              <span>{t('header.quickSearch')}</span>
            </Button>
          )}

          {/* Language Switcher (EN / TR) */}
          <LanguageSwitcher />

          {/* Theme Switcher Toggle Button */}
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === 'light' ? t('header.darkMode') : t('header.lightMode')}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-all duration-150 active:scale-95 cursor-pointer"
          >
            {theme === 'light' ? (
              <Moon className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-[#7367F0]" />
            ) : (
              <Sun className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-[#FF9F43]" />
            )}
          </button>

          {/* Notification Bell */}
          <button
            type="button"
            className="relative p-2 rounded-lg text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
            title={t('header.notifications')}
          >
            <Bell className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#EA5455]" />
          </button>

          {/* Settings Button */}
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              title={t('header.settings')}
              className="p-2 rounded-lg text-slate-500 hover:text-[#7367F0] dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
            >
              <Settings className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
            </button>
          )}

          <div className="h-5 sm:h-6 w-[1px] bg-slate-200 dark:bg-white/[0.1] mx-0.5 sm:mx-1" />

          {/* User Profile Avatar & Sign Out */}
          <div className="flex items-center space-x-2 pl-0.5">
            <div className="relative">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={userDisplayName}
                  className="w-8 h-8 sm:w-9 sm:h-9 rounded-full object-cover border border-primary-500/30 shadow-sm"
                />
              ) : (
                <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-[#7367F0]/15 text-[#7367F0] border border-[#7367F0]/30 flex items-center justify-center text-xs font-extrabold shadow-sm">
                  {initials}
                </div>
              )}
              <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-[#28C76F] ring-2 ring-white dark:ring-[#2F3349]" />
            </div>

            <div className="hidden xl:block text-left">
              <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight truncate max-w-[120px]">
                {userDisplayName}
              </p>
              <p className="text-[10px] text-slate-400 dark:text-[#7E7F96] font-semibold truncate max-w-[120px]">
                {userEmail || t('header.administrator')}
              </p>
            </div>

            {user && (
              <button
                type="button"
                onClick={() => signOut()}
                className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
                title={t('auth.signOut')}
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
