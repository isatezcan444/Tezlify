# Tezlify UI Component System & Architecture Guide

> **Design System Standard**: Inspired by the **Vuexy Admin Template (v9+)** Design Language, adapted for the **Tezlify B2B Lead Generation & WhatsApp Outreach Platform**.

---

## 1. Architectural Principles (SOLID & Clean Code)

1. **Single Responsibility Principle (SRP)**: Each component does exactly one job (e.g. `Button` handles triggering actions and loading states, `FormField` handles label/error wrapping, `DataTable` handles tabular rendering and column alignment).
2. **Open/Closed Principle (OCP)**: Components are extensible via props, compound slots (`header`, `footer`, `actions`, `renderRow`), and variant tokens without modifying core component logic.
3. **Dependency Inversion (DIP)**: Low-level UI primitives do not depend on backend domain models. Domain components (`LeadDetailDrawer`, `SessionCard`) compose generic primitives (`Drawer`, `Card`, `StatusBadge`).
4. **Zero Duplication (DRY)**: Common patterns (Pagination, Portaled Modals, Search Bars, Table Headers, Empty States, Progress Indicators) exist only once in the design system.
5. **Fail-Safe Portaling**: All full-screen overlay components (`Modal`, `Drawer`, `Toast`) are explicitly portaled to `document.body` with `z-[99999]` and trap/restore background scroll.

---

## 2. Component Hierarchy & Composition Flow

```
+-------------------------------------------------------------------+
|                           PAGE LEVEL                              |
|   (DashboardPage, LeadCRMPage, CampaignsPage, WhatsAppHubPage)   |
+-------------------------------------------------------------------+
                                  │
                                  ▼
+-------------------------------------------------------------------+
|                        DOMAIN COMPOSITES                          |
|   (LeadDetailDrawer, SessionCard, CampaignProgressCard, etc.)    |
+-------------------------------------------------------------------+
                                  │
                                  ▼
+-------------------------------------------------------------------+
|                   DATA DISPLAY & LAYOUT LEVEL                     |
|   (PageHeader, Card, DataTable, TableToolbar, MetricCard, etc.)   |
+-------------------------------------------------------------------+
                                  │
                                  ▼
+-------------------------------------------------------------------+
|                     ATOMIC UI FOUNDATIONS                         |
|   (Button, IconButton, Badge, StatusBadge, Avatar, Modal, Drawer) |
+-------------------------------------------------------------------+
```

---

## 3. Component Inventory & Registry

### 3.1 Foundation Components (`components/ui/`)

| Component | Purpose | Variants | Props Summary | Usage Rules |
| :--- | :--- | :--- | :--- | :--- |
| **`Button`** | Primary click triggers & actions | `default`, `outline`, `ghost`, `destructive`, `secondary`, `soft` | `variant`, `size` (`xs`, `sm`, `md`, `lg`), `loading`, `icon`, `disabled` | Use for standard user interactions. Always show loading spinner for async operations. |
| **`IconButton`** | Compact square icon action | `default`, `outline`, `ghost`, `danger`, `warning` | `icon`, `tooltip`, `size` (`sm`, `md`), `onClick` | Use in table row action menus and header toolbars. |
| **`Badge`** | Inline status / count badge | `primary`, `success`, `danger`, `warning`, `info`, `secondary` | `variant`, `size`, `dot` | Use for short textual tags (e.g. `CLINIC`, `+5 Bugün`). |
| **`StatusBadge`** | Live operational status pill | `active`, `pending`, `completed`, `failed`, `warning`, `offline` | `status`, `label`, `pulse` | Use for WhatsApp connection state, Lead CRM status, and Campaign run state. |
| **`Avatar`** | Identity initials / image | `circle`, `rounded`, `square` | `name`, `image`, `size` (`xs`, `sm`, `md`, `lg`), `status` | Use in CRM tables, Lead drawers, and User account menus. |
| **`Drawer`** | Slide-over offcanvas panel | `right`, `left` (width: `sm`, `md`, `lg`, `xl`) | `isOpen`, `onClose`, `title`, `subtitle`, `footer`, `children` | Use for deep detail inspection (e.g. Lead details, Activity inspector) without leaving the page. |
| **`Modal`** | Universal portaled dialog | `default`, `danger`, `warning`, `success` (width: `sm`, `md`, `lg`) | `isOpen`, `onClose`, `title`, `subtitle`, `icon`, `footer` | Use for confirmations, new record creation forms, and QR scans. |
| **`Tabs`** | Navigation tabs / pills | `line`, `pill`, `segmented` | `items` (`id`, `label`, `icon`, `count`), `activeId`, `onChange` | Use to switch between sub-views (e.g. Campaign List vs Builder). |
| **`Alert`** | Inline notification banner | `info`, `success`, `warning`, `danger` | `title`, `description`, `icon`, `onClose` | Use for anti-ban warnings, cooldown policies, and webhook notices. |
| **`Progress`** | Determinate / indeterminate bar | `primary`, `success`, `warning`, `gradient` | `value` (0-100), `height`, `showLabel`, `animated` | Use for Campaign progress, Discovery progress, and Quota meters. |
| **`Spinner`** | Circular loading spinner | `sm`, `md`, `lg`, `xl` | `size`, `color` | Use for inline async loading states. |
| **`Skeleton`** | Shimmer placeholder | `text`, `avatar`, `card`, `table-row` | `type`, `count`, `className` | Use during initial table / dashboard data fetch. |
| **`Dropdown`** | Popover menu with auto-close | `left`, `right` | `trigger`, `items`, `align` | Use for Language switcher, Table row more-menus, Export formats. |

---

### 3.2 Layout & Data Display (`components/layout/` & `components/data-display/`)

| Component | Purpose | Variants / Features |
| :--- | :--- | :--- |
| **`PageHeader`** | Standard page top banner | Title, subtitle, icon rozet, breadcrumb trail, and top action buttons. |
| **`Card`** | Base Vuexy card surface | Compound API: `CardHeader`, `CardTitle`, `CardDescription`, `CardBody`, `CardFooter`, `CardActions`. |
| **`HeroBanner`** | Vibrant Vuexy gradient banner | Gradient backdrop (`from-[#7367F0] to-[#9E95F5]`), icon badge, title, subtitle, dual action buttons. |
| **`MetricCard`** | High-level KPI summary card | Colored icon tile (`primary`, `success`, `warning`, `info`), value, trend badge (+/-%), subtext, optional click action. |
| **`AnalyticsCard`** | Multi-tier conversion / funnel card | Multi-step progress bars, percentage calculations, realtime badge. |
| **`ActivityTimeline`** | Chronological event list | Timeline dots (`success`, `warning`, `info`, `primary`), formatted timestamp, message snippet, and status. |
| **`DataTable`** | Universal data table | Generic typing (`T[]`), sortable columns, checkbox selection, row actions, loading skeleton, empty state, footer pagination. |
| **`TableToolbar`** | Table search & filter bar | Debounced search input, filter chips, location/category triggers, reset button. |
| **`BulkActionToolbar`**| Floating action bar | Gradient pill bar, selected count badge, "Select all X records across pages", bulk action triggers, clear selection button. |
| **`Pagination`** | Vuexy page navigator | Total record range (`Showing 1 to 20 of 133`), page size dropdown (10, 20, 50, 100), next/prev buttons. |
| **`EmptyState`** | Empty result view | Custom illustration/icon, title, description, and optional primary CTA button. |

---

### 3.3 Forms & Feedback (`components/forms/` & `components/feedback/`)

| Component | Purpose | Features |
| :--- | :--- | :--- |
| **`FormField`** | Accessible form item container | Label, required indicator (`*`), helper text, error message, tooltip. |
| **`TextInput`** | Enhanced text input | Left/right icon adornments, clear button, error border state. |
| **`Select`** | Custom styled select | Native or popover select with custom chevrons. |
| **`Switch`** | Vuexy toggle switch | Smooth animated slider with optional on/off labels. |
| **`Checkbox`** | Custom checkbox | Square, checked, and indeterminate (`MinusSquare`) states. |
| **`ConfirmDialog`** | Confirmation modal wrapper | Danger / warning / info variants, confirm button, cancel button, async loader. |

---

### 3.4 Domain Composites (`components/domain/`)

| Component | Purpose | Components Composed |
| :--- | :--- | :--- |
| **`LeadDetailDrawer`** | Detailed business inspection drawer | `Drawer`, `Avatar`, `StatusBadge`, `Button`, `IconButton`, `GoogleMapsIcon`, `WhatsAppIcon` |
| **`SessionCard`** | WhatsApp gateway session card | `Card`, `StatusBadge`, `Button`, `Modal`, `Alert` |
| **`CampaignProgressCard`** | Live outreach campaign tracker | `Card`, `Progress`, `Badge`, `Button`, `SpintaxPreview` |

---

## 4. Gap Analysis & Roadmap

| Component | Existing Status | Refactor / New Action | Priority |
| :--- | :--- | :--- | :--- |
| **`Button`** | Partial | Enhance with `soft`, `icon`, `loading` states | **P0** |
| **`Badge` & `StatusBadge`** | Partial | Unify with Vuexy soft color tokens & live pulse | **P0** |
| **`Modal` & `ConfirmDialog`**| Exists | Standardize with portaled `createPortal` & backdrop blur | **P0** |
| **`PageHeader`** | Exists | Add breadcrumb support & responsive action wrapping | **P0** |
| **`Pagination`** | Exists | Enhance responsive layout & per-page selection | **P0** |
| **`DataTable`** | Scattered | Create reusable generic `<DataTable<T> />` component | **P0** |
| **`Drawer` (Offcanvas)** | Missing | Implement slide-over drawer for Lead Details & Campaign details | **P0** |
| **`ActivityTimeline`** | Ad-hoc | Standardize Vuexy timeline for Dashboard & WhatsApp Hub | **P1** |
| **`MetricCard` & `StatsCard`**| Exists | Elevate with trend indicators & hover transitions | **P1** |
| **`HeroBanner`** | Exists | Maintain signature gradient and action buttons | **P1** |
| **`FormField` & `TextInput`** | Ad-hoc | Standardize inputs with icon prefixes and validation | **P1** |
| **`Switch` & `Checkbox`** | Ad-hoc | Standardize toggle switches and accessible checkboxes | **P2** |
| **`Alert` & `Progress`** | Partial | Create standalone reusable components | **P2** |
| **`Skeleton`** | Missing | Create shimmer placeholder for loading states | **P2** |

---

## 5. Page-to-Component Mapping

### 5.1 Dashboard (`DashboardPage.tsx`)
- **Structure**: `HeroBanner` ➔ `MetricCard` (4-column grid) ➔ 2-column layout (`AnalyticsCard` Funnel + `ActivityTimeline` Message stream) ➔ `Alert` Safeguard policy.

### 5.2 Business Search (`LeadFinderPage.tsx`)
- **Structure**: `PageHeader` ➔ Search Filters `Card` (`SectorAutocomplete`, `LocationMultiSelect`, Limit `Select`, Start `Button`) ➔ `Progress` Bar ➔ Live `Terminal` Log Stream ➔ `DataTable` of Discovered Leads ➔ `EmptyState`.

### 5.3 Customer Leads CRM (`LeadCRMPage.tsx`)
- **Structure**: `PageHeader` (with CSV/Excel Export & Add Lead actions) ➔ `TableToolbar` (Search, City/District Filters, Category Filters, Status Filter) ➔ `BulkActionToolbar` ➔ `DataTable` (Business Profile, Contact, Location, Rating, Status `Select`, Row Action Menu) ➔ `Pagination` ➔ `LeadDetailDrawer` ➔ `Modal` (Add Lead, Send Message, Delete Confirmation, Blacklist Confirmation).

### 5.4 WhatsApp & Anti-Ban Hub (`WhatsAppHubPage.tsx`)
- **Structure**: `PageHeader` ➔ `SessionCard` Grid (Active Sessions, Battery, Connection State, QR Scan trigger) ➔ Anti-Ban Safeguards `Card` (`Switch` Working Hours, Delay Sliders, Presets) ➔ Test Sandbox `Card` ➔ `ActivityTimeline` Message Logs ➔ `Modal` (QR Pairing).

### 5.5 Campaigns (`CampaignsPage.tsx`)
- **Structure**: `PageHeader` (with Tabs: Campaign List / Spintax Builder) ➔ `CampaignProgressCard` Grid ➔ Spintax Editor `Card` (`FormField`, Tag insertion chips, Permutation Counter, Live Variation Previews) ➔ `EmptyState`.

### 5.6 Blacklist (`BlacklistPage.tsx`)
- **Structure**: `PageHeader` (Add Number action) ➔ `TableToolbar` (Search & Reason filter) ➔ `BulkActionToolbar` ➔ `DataTable` (Profile, Contact, Block Reason `Badge`, Date, Remove `IconButton`) ➔ `Pagination` ➔ `Modal` (Add Lead to Blacklist).

### 5.7 Settings (`SettingsPage.tsx`)
- **Structure**: `PageHeader` ➔ `Tabs` (General, Anti-Ban & Timing, Localization, Security) ➔ Config `Card` (`FormField`, `Switch`, `LanguageSwitcher`, Webhook Token Input).

---

## 6. Design Tokens & Styling Constants

- **Primary Brand**: `#7367F0` (Hover: `#685DD8`, Soft: `rgba(115, 103, 240, 0.12)`)
- **Success**: `#28C76F` (Soft: `rgba(40, 199, 111, 0.12)`)
- **Danger**: `#EA5455` (Soft: `rgba(234, 84, 85, 0.12)`)
- **Warning**: `#FF9F43` (Soft: `rgba(255, 159, 67, 0.12)`)
- **Info**: `#00CFE8` (Soft: `rgba(0, 207, 232, 0.12)`)
- **Surfaces**:
  - Light Background: `#F8F7FA`, Light Card: `#FFFFFF` (Border: `rgba(47, 43, 61, 0.08)`)
  - Dark Background: `#25293C`, Dark Card: `#2F3349` (Border: `rgba(255, 255, 255, 0.08)`)
- **Border Radius**: Card `0.625rem` (10px), Input/Button `0.5rem` (8px), Pill `9999px`.
- **Typography**: Header `Plus Jakarta Sans`, Body `Inter`, Monospace `JetBrains Mono`.
