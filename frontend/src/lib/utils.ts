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
