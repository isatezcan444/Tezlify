import * as React from "react";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Parses a backend timestamp honoring its true instant.
 * The API stores naive UTC ("2026-09-07 11:30:00"); `new Date()` would read
 * that as browser-local time (3h off in TRT). Appending 'Z' recovers UTC.
 * Strings already carrying a zone/offset pass through untouched.
 */
export function parseServerTime(dateStr?: string | null): Date | null {
  if (!dateStr) return null;
  const s = String(dateStr).trim().replace(' ', 'T');
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  return new Date(`${s}Z`);
}

/**
 * Formats a message time (e.g. "17:40" or "05:40 PM") strictly honoring the application locale
 * and 24-hour presentation standard matching WhatsApp Web.
 */
export function formatMessageTime(dateStr?: string | null, language: string = 'tr'): string {
  if (!dateStr) return '';
  try {
    const d = parseServerTime(dateStr);
    if (!d || isNaN(d.getTime())) return '';
    const locale = language === 'tr' ? 'tr-TR' : 'en-US';
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
}

/**
 * Formats a date label for the chat thread dividers ("Bugün", "Dün", "24 Ağustos 2026")
 * honoring application locale.
 */
export function formatMessageDate(
  dateStr?: string | null,
  language: string = 'tr',
  todayLabel: string = 'Bugün',
  yesterdayLabel: string = 'Dün'
): string {
  if (!dateStr) return '';
  try {
    const d = parseServerTime(dateStr);
    if (!d || isNaN(d.getTime())) return '';
    const now = new Date();
    const todayStr = now.toDateString();
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);
    const yesterdayStr = yesterday.toDateString();

    if (d.toDateString() === todayStr) {
      return todayLabel;
    }
    if (d.toDateString() === yesterdayStr) {
      return yesterdayLabel;
    }
    const locale = language === 'tr' ? 'tr-TR' : 'en-US';
    return d.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * Formats conversation list preview timestamp ("17:40" if today, else "6 Eyl" or "24 Ağu").
 */
export function formatConversationTime(dateStr?: string | null, language: string = 'tr'): string {
  if (!dateStr) return '';
  try {
    const d = parseServerTime(dateStr);
    if (!d || isNaN(d.getTime())) return '';
    const now = new Date();
    const locale = language === 'tr' ? 'tr-TR' : 'en-US';
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * Safely renders an icon prop that could be either a rendered ReactNode (like `<Send />`)
 * or a component definition (function / forwardRef object from Lucide React).
 */
export function renderIcon(
  icon: any,
  defaultClassName: string = "w-4 h-4"
): React.ReactNode {
  if (!icon) return null;
  if (React.isValidElement(icon)) {
    return icon;
  }
  if (typeof icon === "function" || (typeof icon === "object" && icon !== null && "$$typeof" in icon)) {
    return React.createElement(icon, { className: defaultClassName });
  }
  return icon;
}

/**
 * Turkish-aware Title Case for display only (data stays untouched).
 * Every whitespace-separated token gets its first alphabetic char uppercased:
 * "ALGAN (7Dent) AĞIZ VE DİŞ SAĞLIĞI" -> "Algan (7Dent) Ağız Ve Diş Sağlığı".
 * Handles dotted/dotless I explicitly (JS toUpperCase is locale-blind).
 */
export function toTitleCaseTr(input: string | undefined | null): string {
  if (!input) return '';
  const lowered = input
    .replace(/I/g, 'ı')
    .replace(/İ/g, 'i')
    .toLowerCase();
  return lowered.replace(
    /(^|[\s([{["'“‘\-–—/]+)([a-zçğıöşü])/g,
    (_m, pre: string, ch: string) => pre + (ch === 'i' ? 'İ' : ch.toUpperCase())
  );
}

/**
 * Normalizes text for case-insensitive and Turkish diacritic-insensitive search.
 * Handles 'i' <-> 'İ', 'ı' <-> 'I', 'ş' <-> 's', 'ç' <-> 'c', 'ğ' <-> 'g', 'ü' <-> 'u', 'ö' <-> 'o'.
 */
export function normalizeTurkishText(text: string): string {
  if (!text) return '';
  return text
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .replace(/Ğ/g, 'ğ')
    .replace(/Ü/g, 'ü')
    .replace(/Ö/g, 'ö')
    .replace(/Ş/g, 'ş')
    .replace(/Ç/g, 'ç')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');
}

/**
 * Returns true if target text matches search query regardless of casing or Turkish characters.
 */
export function matchTurkishSearch(target: string | undefined | null, search: string): boolean {
  if (!target || !search) return false;
  return normalizeTurkishText(target).includes(normalizeTurkishText(search));
}
