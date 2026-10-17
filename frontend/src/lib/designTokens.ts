/**
 * Vuexy design tokens — single source of truth for semantic tones.
 *
 * Components MUST consume these helpers instead of hardcoding palette hexes,
 * so light/dark surfaces stay consistent across the design system (DIP).
 * Tone definitions derive from the `vuexy-*` palette declared in tailwind.config.js.
 */
import { cva, type VariantProps } from 'class-variance-authority';

export type SemanticTone = 'primary' | 'success' | 'danger' | 'warning' | 'info' | 'secondary';

/** Soft treatment: tinted background + tone text (icon tiles, badges, info boxes). */
const TONE_SOFT: Record<SemanticTone, string> = {
  primary: 'bg-vuexy-primary/15 dark:bg-vuexy-primary/25 text-vuexy-primary dark:text-[#A59DF8]',
  success: 'bg-vuexy-success/15 dark:bg-vuexy-success/25 text-vuexy-success dark:text-[#5BE49B]',
  danger: 'bg-vuexy-danger/15 dark:bg-vuexy-danger/25 text-vuexy-danger dark:text-[#FF7F80]',
  warning: 'bg-vuexy-warning/15 dark:bg-vuexy-warning/25 text-vuexy-warning dark:text-[#FFBD7A]',
  info: 'bg-vuexy-info/15 dark:bg-vuexy-info/25 text-vuexy-info dark:text-[#4DE2F5]',
  secondary: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
};

/** Matching hairline border per tone (modal headers, alert boxes). */
const TONE_BORDER: Record<SemanticTone, string> = {
  primary: 'border-vuexy-primary/20',
  success: 'border-vuexy-success/20',
  danger: 'border-vuexy-danger/20',
  warning: 'border-vuexy-warning/20',
  info: 'border-vuexy-info/20',
  secondary: 'border-slate-200 dark:border-white/[0.08]',
};

const composeOutline = (): Record<SemanticTone, string> =>
  Object.fromEntries(
    Object.entries(TONE_SOFT).map(([tone, soft]) => [tone, `${soft} ${TONE_BORDER[tone as SemanticTone]}`])
  ) as Record<SemanticTone, string>;

export const toneSoftVariants = cva('', {
  variants: { tone: TONE_SOFT },
  defaultVariants: { tone: 'primary' },
});

export const toneOutlineVariants = cva('', {
  variants: { tone: composeOutline() },
  defaultVariants: { tone: 'primary' },
});

export type ToneVariantProps = VariantProps<typeof toneSoftVariants>;

/**
 * Standardized typography scale matching Vuexy Design Rules (RULE 8 & RULE 10).
 */
export const TYPOGRAPHY = {
  pageTitle: 'text-lg sm:text-xl lg:text-2xl font-extrabold tracking-tight text-slate-800 dark:text-white',
  sectionTitle: 'text-sm sm:text-base font-extrabold text-slate-800 dark:text-white',
  cardTitle: 'text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white',
  bodyText: 'text-xs sm:text-sm text-slate-700 dark:text-slate-200 leading-relaxed',
  secondaryText: 'text-[11px] sm:text-xs text-slate-400 dark:text-[#7E7F96] font-medium leading-normal',
  formLabel: 'text-xs font-bold text-slate-700 dark:text-slate-200 block mb-1.5',
  helperText: 'text-[10px] sm:text-[11px] text-slate-400 dark:text-[#7E7F96]',
  tableHeader: 'text-[10px] sm:text-[11px] font-extrabold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider',
  tableCell: 'text-xs font-semibold text-slate-800 dark:text-white',
  badgeText: 'text-[9px] sm:text-[10px] font-bold whitespace-nowrap',
} as const;

/**
 * Standardized container and panel layout classes (RULE 10).
 */
export const LAYOUT_TOKENS = {
  pageWrapper: 'space-y-5 sm:space-y-6 pb-16 w-full select-none animate-fade-in',
  mainCard: 'p-4 sm:p-6 space-y-6 vuexy-card',
  innerBox: 'p-4 sm:p-5 rounded-xl bg-slate-50/70 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-4',
  subHeader: 'flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-white/[0.08] pb-4',
} as const;

/**
 * Canonical Z-Index layers preventing portal and stacking conflicts.
 */
export const Z_INDEX = {
  dropdown: 50,
  stickyHeader: 30,
  sidebarDrawer: 40,
  sidebarOverlay: 35,
  modalOverlay: 99990,
  modalContent: 99999,
  toast: 100000,
} as const;

