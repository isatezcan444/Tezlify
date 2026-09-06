# UI Component Architecture & Self-Updating Design System Rules

This living document defines the strict engineering standards, decision trees, and self-updating contracts for the Tezlify frontend design system.

---

## RULE 1 — REUSE FIRST & CONSULT THE REGISTRY
Before writing any new UI elements, the developer or AI agent **MUST** review [`docs/component-registry.md`](file:///Users/isatezcan/Documents/Github/Tezlify/docs/component-registry.md) and [`frontend/src/components/`](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/components).
Never build ad-hoc HTML/Tailwind elements when an existing component in `ui/`, `forms/`, `data-display/`, `navigation/`, or `domain/` fulfills the requirement.

---

## RULE 2 — NO PAGE-SPECIFIC DUPLICATION
If a UI behavior or visual pattern is used or could be used in more than one page (e.g. searching, date picking, progress bars, session cards, modal dialogs, status badges), it is strictly forbidden to implement it inline in a page file.
It **MUST** be created as a centralized generic primitive or domain composite.

---

## RULE 3 — COMPONENT CREATION DECISION TREE

When developing a new feature or page, automatically follow this decision workflow:

```
[New UI Requirement]
       │
       ▼
1. Does an existing component in `components/` meet this need?
       ├── YES ──► Use the existing component.
       └── NO
           │
           ▼
2. Can the existing component be extended with a minor prop/variant?
       ├── YES ──► Extend the component cleanly with backward compatibility.
       └── NO
           │
           ▼
3. Can this behavior be used across multiple pages/domains?
       ├── YES ──► Create a Generic Component in `components/ui/`, `forms/`, `data-display/`, or `navigation/`.
       └── NO
           │
           ▼
4. Is it a specialized domain composite (e.g. Lead, Campaign, WhatsApp Session)?
       ├── YES ──► Create a Domain Component in `components/domain/`.
       └── NO  ──► Create a clean local composite without violating DRY.
```

---

## RULE 4 — AUTOMATIC REGISTRY & RULES SYNCHRONIZATION (MANDATORY INVARIANT)

Whenever you (the developer or AI Agent) create or modify a reusable component:
1. Create the component file under `frontend/src/components/<category>/<ComponentName>.tsx`.
2. Add the export to `frontend/src/components/<category>/index.ts`.
3. Add the component specification to [`docs/component-registry.md`](file:///Users/isatezcan/Documents/Github/Tezlify/docs/component-registry.md).
4. Update this file ([`docs/UI_COMPONENT_RULES.md`](file:///Users/isatezcan/Documents/Github/Tezlify/docs/UI_COMPONENT_RULES.md)) if any new pattern or invariant emerges.
5. **Never wait for the user to request rule updates.** Rule updates are part of the atomic definition of done.

---

## RULE 5 — DESIGN SYSTEM TOKENS & VUEXY AESTHETICS

All components must adhere to the Vuexy color palette and glassmorphism design tokens:
- **Primary / Brand**: `#7367F0` (Hover: `#685DD8`, Light: `#7367F0]/15`, Dark text: `#A59DF8`)
- **Success**: `#28C76F` (Hover: `#20A159`, Light: `#28C76F]/15`)
- **Warning**: `#FF9F43` (Light: `#FF9F43]/15`)
- **Danger / Destructive**: `#EA5455` (Light: `#EA5455]/15`)
- **Info**: `#00CFE8` (Light: `#00CFE8]/15`)
- **Surfaces**:
  - Light mode: `bg-white`, `border-slate-200/80`, text `text-slate-800`.
  - Dark mode: `dark:bg-[#2F3349]`, `dark:border-white/[0.08]`, `dark:text-white`.
  - Nested container backgrounds: `bg-slate-50`, `dark:bg-[#25293C]`.

---

## RULE 6 — OVERLAYS & MODALS PORTAL RULE
- All full-screen fixed modals, dialogs, and drawers **MUST** be portaled to `document.body` via `createPortal(..., document.body)` with `z-[99999]`.
- Native `window.alert()` and `window.confirm()` are strictly forbidden. Always use `useToast()` (`toast.confirm(...)`).

---

## RULE 7 — CENTRALIZED LOCALIZATION (i18n) INVARIANT
- All labels, tooltips, placeholders, and error messages **MUST** be resolved via `useI18n()` (`t('domain.key')`).
- Natural language strings hardcoded in TSX/JSX components are strictly forbidden.
- Synchronize both `frontend/src/locales/en.ts` and `frontend/src/locales/tr.ts`.

---

## RULE 8 — CENTRALIZED TYPOGRAPHY & FORM CONTROL SIZING CONTRACT
All typography and input styling across pages and components must follow standard Vuexy design scale without ad-hoc variations:

- **Page Titles**: `text-xl sm:text-2xl font-extrabold tracking-tight text-slate-800 dark:text-white`
- **Card & Modal Titles**: `text-base font-extrabold text-slate-800 dark:text-white`
- **Sub-headers & Card Descriptions**: `text-xs text-slate-400 dark:text-[#7E7F96] font-medium`
- **Form Labels**: `text-xs font-bold text-slate-700 dark:text-slate-200`
- **Form Controls (Inputs, Autocomplete, Selects, Dropdowns)**:
  - Font Size: Strictly `text-xs` (12px)
  - Font Weight: `font-semibold` (active values), `font-normal text-slate-400` (placeholders)
  - Heights: `h-11` (primary action / search bar), `h-10` (standard form / filter row), `h-8` (compact)
- **Table Headers**: `text-[10px] sm:text-[11px] font-extrabold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider`
- **Table Cell Text**: `text-xs font-semibold text-slate-800 dark:text-white`
- **Badges & Tags**: `text-[10px] sm:text-[11px] font-bold`

---

## RULE 9 — UNIVERSAL ACTION ICON BUTTON SIZING CONTRACT (LEAD CRM STANDARD)
All table row actions, card footer actions, and isolated icon buttons across every page **MUST** strictly follow the standardized `IconButton` sizing contract established in Lead CRM:

- **Component**: Always use `<IconButton icon={Icon} size="sm" variant="ghost" ... />` from `components/ui/IconButton`.
- **Button Container Dimensions**: Exactly `w-8 h-8` (32px × 32px), `rounded-lg` with `p-1.5`.
- **Inner Icon Scale**: Standard `w-4 h-4` with `stroke-[2]` (or `stroke-[2.2]`).
- **Color Transitions**:
  - Default: `text-slate-400 dark:text-slate-400`
  - Edit / Overview / Primary: `hover:text-[#7367F0] hover:bg-[#7367F0]/10`
  - Delete / Destructive: `hover:text-[#EA5455] hover:bg-[#EA5455]/10`
  - Warning / Blacklist: `hover:text-[#FF9F43] hover:bg-[#FF9F43]/10`
  - WhatsApp / Success: `hover:text-[#28C76F] hover:bg-[#28C76F]/10`
- **Strict Prohibition**: Ad-hoc icon button sizes (e.g. `w-9 h-9`, `w-7 h-7`, unpadded SVGs, oversized inline icons) in table or card action zones are strictly prohibited.

