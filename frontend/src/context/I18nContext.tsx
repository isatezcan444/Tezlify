import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react';
import { Language, translations } from '../locales';

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (path: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

const STORAGE_KEY = 'tezlify_lang';

export const I18nProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'en' || saved === 'tr') {
        return saved;
      }
    }
    return 'en'; // Default to English as requested
  });

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, lang);
    }
  }, []);

  // Nested translation resolver with parameter interpolation
  const t = useMemo(() => {
    return (path: string, params?: Record<string, string | number>): string => {
      const keys = path.split('.');
      
      // Resolve in active language
      let value: any = translations[language];
      for (const k of keys) {
        if (value && typeof value === 'object') {
          value = value[k];
        } else {
          value = undefined;
          break;
        }
      }

      // Fallback to English if missing in target language
      if (value === undefined && language !== 'en') {
        let fallbackValue: any = translations['en'];
        for (const k of keys) {
          if (fallbackValue && typeof fallbackValue === 'object') {
            fallbackValue = fallbackValue[k];
          } else {
            fallbackValue = undefined;
            break;
          }
        }
        value = fallbackValue;
      }

      if (typeof value !== 'string') {
        console.warn(`[i18n] Missing translation for key: "${path}" (language: "${language}")`);
        return path;
      }

      if (params) {
        let interpolated = value;
        for (const [paramKey, paramVal] of Object.entries(params)) {
          interpolated = interpolated.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramVal));
        }
        return interpolated;
      }

      return value;
    };
  }, [language]);

  const contextValue = useMemo(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t]
  );

  return (
    <I18nContext.Provider value={contextValue}>
      {children}
    </I18nContext.Provider>
  );
};

export const useI18n = (): I18nContextType => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
};
