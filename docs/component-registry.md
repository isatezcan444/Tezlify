# Tezlify Component Registry

This document serves as the single centralized registry for all reusable components in the Tezlify frontend design system (based on the Vuexy Admin Template architecture).

Development profiling: existing `ChatThread` and `ChatBubble` record request/event-to-DOM-commit durations through `/Users/isatezcan/Documents/Github/Scoutify/frontend/src/lib/whatsappLatency.ts` when `VITE_WHATSAPP_LATENCY_PROFILING=true` in development. No visual or public prop changes. DOM commit is not browser paint.

---

## Component Taxonomy

```
src/
├── features/
│   ├── whatsapp/        # WhatsApp feature components, api, hooks, data, lib
│   │   └── components/  # ChatBubble, ChatThread, ChatComposer, ConversationList, SessionCard, etc.
│   ├── campaigns/       # Campaign feature components (CampaignCard, CampaignGroupCard, SpintaxPreviewCard)
│   └── leads/           # Leads and Discovery components (LeadDetailDrawer, CategoryMultiSelect, etc.)
└── components/
    ├── ui/              # Foundation UI Primitives (Buttons, Badges, Cards, Modals, Overlays)
    ├── forms/           # Form Controls, Inputs, Sliders, Switches, Sections
    ├── data-display/    # Tables, Timelines, Toolbars, Cells, Funnels
    ├── Layout/          # Structural Layout Components (Sidebar, TopHeader)
    └── admin/           # Admin panel layout and components
```

---

## 1. Foundation UI Components (`components/ui/`)

### `Button`
- **Purpose**: Primary interactive trigger supporting multiple visual weights and states.
- **Props**: `variant` ('primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info' | 'ghost' | 'outline'), `size` ('sm' | 'md' | 'lg' | 'icon'), `loading`, `disabled`.
- **States**: Default, Hover, Active, Focus, Disabled, Loading (with embedded Spinner).
- **Import**: `import { Button } from '@/components/ui';`

### `IconButton`
- **Purpose**: Compact square button for toolbar actions, icon toggles, and compact triggers.
- **Props**: `icon: LucideIcon`, `tooltip`, `variant`, `size` ('xs' | 'sm' | 'md' | 'lg'), `badge`.
- **Import**: `import { IconButton } from '@/components/ui';`

### `ButtonGroup`
- **Purpose**: Visual grouping for contiguous related action buttons.
- **Props**: `orientation` ('horizontal' | 'vertical'), `children`.
- **Import**: `import { ButtonGroup } from '@/components/ui';`

### `Badge` & `StatusBadge`
- **Purpose**: Micro-status indicators, count tags, and live pulsating dots.
- **Variants**: `default`, `primary`, `success`, `warning`, `danger`, `info`, `outline`.
- **Import**: `import { Badge, StatusBadge } from '@/components/ui';`

### `Chip`
- **Purpose**: Removable filter token or category tag.
- **Props**: `label`, `onRemove`, `variant`, `size`, `icon`.
- **Import**: `import { Chip } from '@/components/ui';`

### `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`
- **Purpose**: Unified card surface with glassmorphism styling and dark mode support.
- **Import**: `import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui';`

### `StatsCard`
- **Purpose**: KPI card displaying metric value, icon tile, comparison trend, and subtitle.
- **Props**: `title`, `value`, `icon`, `trend`, `color`, `subtitle`.
- **Import**: `import { StatsCard } from '@/components/ui';`

### `Avatar` & `AvatarGroup`
- **Purpose**: User/business avatar with deterministic color hashing and clustered group counts.
- **Props**: `name`, `src`, `size` ('xs' | 'sm' | 'md' | 'lg'), `shape` ('circle' | 'rounded').
- **Import**: `import { Avatar, AvatarGroup } from '@/components/ui';`

### `Modal` & `ConfirmDialog`
- **Purpose**: High-priority dialogs and action confirmations portaled to `document.body` (`z-[99999]`).
- **Import**: `import { Modal, ConfirmDialog } from '@/components/ui';`

### `Drawer`
- **Purpose**: Slide-over panel from right edge for item inspection and detailed forms.
- **Props**: `isOpen`, `onClose`, `title`, `size` ('sm' | 'md' | 'lg' | 'xl' | 'full').
- **Import**: `import { Drawer } from '@/components/ui';`

### `Dropdown`
- **Purpose**: Contextual menu overlay with automatic outside-click listener.
- **Import**: `import { Dropdown } from '@/components/ui';`

### `Tooltip`
- **Purpose**: Standalone hover tooltip provider.
- **Props**: `content`, `position` ('top' | 'bottom' | 'left' | 'right').
- **Import**: `import { Tooltip } from '@/components/ui';`

### `Tabs`
- **Purpose**: Navigation bar with 'pills', 'line', and 'segmented' visual styles.
- **Import**: `import { Tabs } from '@/components/ui';`

### `Accordion`
- **Purpose**: Collapsible vertical accordion panels with smooth chevron animation.
- **Props**: `items: AccordionItem[]`, `allowMultiple: boolean`.
- **Import**: `import { Accordion } from '@/components/ui';`

### `CircularProgress`
- **Purpose**: Radial SVG percentage progress indicator.
- **Props**: `value: number`, `size: number`, `variant`, `showLabel: boolean`.
- **Import**: `import { CircularProgress } from '@/components/ui';`

### `LoadingOverlay`
- **Purpose**: Backdrop overlay with central spinner for loading cards and containers.
- **Props**: `isLoading: boolean`, `message?: string`.
- **Import**: `import { LoadingOverlay } from '@/components/ui';`

---

## 2. Form Components (`components/forms/`)

### `FormField`
- **Purpose**: Unified wrapper providing label, asterisk, helper text, and validation message.
- **Props**: `label`, `required`, `helperText`, `error`, `children`.
- **Import**: `import { FormField } from '@/components/forms';`

### `TextInput`
- **Purpose**: Single line input with left/right icons and clear button.
- **Props**: `leftIcon`, `rightIcon`, `error`, `sizeVariant`.
- **Import**: `import { TextInput } from '@/components/forms';`

### `SearchInput`
- **Purpose**: Debounced search bar with automatic clear trigger and loading indicator.
- **Props**: `value`, `onChange`, `debounceMs`, `loading`, `onClear`.
- **Import**: `import { SearchInput } from '@/components/forms';`

### `Textarea`
- **Purpose**: Multi-line input with auto-resize and character count.
- **Props**: `maxLength`, `showCount`, `error`.
- **Import**: `import { Textarea } from '@/components/forms';`

### `Select`
- **Purpose**: Custom styled native dropdown select with icon support.
- **Props**: `options`, `leftIcon`, `error`, `sizeVariant`.
- **Import**: `import { Select } from '@/components/forms';`

### `Switch`
- **Purpose**: Interactive toggle switch with iOS/Vuexy styling.
- **Props**: `checked`, `onChange`, `label`, `description`, `disabled`.
- **Import**: `import { Switch } from '@/components/forms';`

### `Checkbox`
- **Purpose**: Custom checkable control with label and helper description.
- **Props**: `checked`, `onChange`, `label`, `description`.
- **Import**: `import { Checkbox } from '@/components/forms';`

### `RadioGroup`
- **Purpose**: Segmented cards or inline radio buttons.
- **Props**: `options: RadioOption[]`, `value`, `onChange`, `variant` ('cards' | 'inline').
- **Import**: `import { RadioGroup } from '@/components/forms';`

### `Slider`
- **Purpose**: Range slider with interactive numeric bubble and track styling.
- **Props**: `value`, `onChange`, `min`, `max`, `step`, `unit`, `label`.
- **Import**: `import { Slider } from '@/components/forms';`

### `FormSection`
- **Purpose**: Structured visual divider and title block for form grouping.
- **Props**: `title`, `subtitle`, `icon`, `action`, `children`.
- **Import**: `import { FormSection } from '@/components/forms';`

---

## 3. Data Display & Navigation (`components/data-display/`, `components/navigation/`)

### `DataTable<T>`
- **Purpose**: Generic type-safe table with sortable headers, row selection, custom cells, and loading state.
- **Props**: `columns: Column<T>[]`, `data: T[]`, `selectedIds`, `onSelectRow`, `onSelectAll`, `isLoading`.
- **Import**: `import { DataTable } from '@/components/data-display';`

### `TableToolbar`
- **Purpose**: Centralized table control bar with search, filter dropdowns, action buttons, and active filter chips.
- **Props**: `searchSlot`, `filtersSlot`, `actionsSlot`, `activeChips`, `onResetFilters`.
- **Import**: `import { TableToolbar } from '@/components/data-display';`

### `BusinessCell`
- **Purpose**: Standardized first column for CRM and scraper tables showing avatar, name, category, and entity badge.
- **Props**: `name`, `category`, `entityType`, `onClick`.
- **Import**: `import { BusinessCell } from '@/components/data-display';`

### `ProgressFunnel`
- **Purpose**: 4-stage visual conversion funnel with progress bars and percentage metrics.
- **Props**: `stages: FunnelStage[]`.
- **Import**: `import { ProgressFunnel } from '@/components/data-display';`

### `Stepper`
- **Purpose**: Multi-step wizard navigation header (e.g. Campaign Creator, Scraper Setup).
- **Props**: `steps: StepItem[]`, `currentStep: number`, `onStepClick`.
- **Import**: `import { Stepper } from '@/components/navigation';`

---

## 4. Feature Components (`src/features/`)

### WhatsApp Feature Components (`features/whatsapp/components/`)

#### `ChatBubble`
- **Purpose**: WhatsApp message bubble primitive with inbound/outbound styling, timestamps, delivery/read checkmarks (✓ / ✓✓ / mavi ✓✓), inline media previews (image lightbox, native audio/video players, downloadable documents), and retry button for FAILED messages.
- **Props**: `message: Message`, `onRetry?: (messageId: number) => Promise<void> | void`.
- **Import**: `import { ChatBubble } from '@/features/whatsapp/components';`

#### `ChatThread`
- **Purpose**: Interactive scrollable message timeline with date separators, loading skeletons, empty state, smart auto-scroll, peer "typing..." bubble (WhatsApp Web parity), and failure retry dispatching.
- **Props**: `messages: Message[]`, `loading?: boolean`, `hasMore?: boolean`, `loadingOlder?: boolean`, `onLoadOlder?: () => void`, `leadName?: string`, `leadPhone?: string`, `onRetry?: (messageId: number) => Promise<void> | void`, `peerTyping?: boolean`.
- **Import**: `import { ChatThread } from '@/features/whatsapp/components';`

#### `ChatComposer`
- **Purpose**: Bottom message composer bar with 24-hour window status alerts, closed conversation notice with one-click reopen, attachment popover (native file picker with base64 upload + legacy URL modal), outgoing "typing..." presence signals (throttled composing/paused), and template shortcuts.
- **Props**: `onSend?: (text: string) => Promise<void> | void`, `onSendTemplate?: () => void`, `onSendMedia?: (mediaType: 'IMAGE' | 'DOCUMENT', mediaUrl: string, caption?: string, filename?: string) => Promise<void>`, `onSendMediaFile?: (file: File, caption?: string) => Promise<void>`, `onTyping?: (typing: boolean) => void`, `onReopenConversation?: () => void`, `disabled?: boolean`, `isClosed?: boolean`, `isWindowOpen?: boolean`, `placeholder?: string`.
- **Import**: `import { ChatComposer } from '@/features/whatsapp/components';`

#### `ConversationList`
- **Purpose**: Sidebar list of all active conversation threads with search filtering, avatar hashing, unread badges, and last message previews. Includes filter tabs (`ALL`, `ACTIVE`, `GROUPS`, `ARCHIVED`, `CLOSED`, `UNREAD`) — `GROUPS` filters on persisted `is_group`, `ARCHIVED` on `is_archived OR status=ARCHIVED` (Sorun 4).
- **Props**: `conversations: Conversation[]`, `selectedId?: number`, `onSelect: (conv: Conversation) => void`, `loading?: boolean`, `searchQuery?: string`, `onSearchChange?: (q: string) => void`, `activeFilter?: FilterTab`, `onFilterChange?: (filter: FilterTab) => void`, `onNewChat?: () => void`, `onSync?: () => void`, `isSyncing?: boolean`.
- **Import**: `import { ConversationList } from '@/features/whatsapp/components';`

#### `SessionCard`
- **Purpose**: Reusable account card with warmup day indicator, battery level, daily quota, and disconnect/scan triggers.
- **Props**: `session: WhatsAppSession`, `onDisconnect`, `onScanQR`, `onDelete`.
- **Import**: `import { SessionCard } from '@/features/whatsapp/components';`

#### `TemplateSelectModal`
- **Purpose**: Modal for selecting pre-approved WhatsApp business templates with automated recipient variable pre-filling, real-time message preview, and one-click dispatch.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `leadName?: string`, `onSendTemplate: (templateKey: string, variables: Record<string, string>) => Promise<void>`.
- **Import**: `import { TemplateSelectModal } from '@/features/whatsapp/components';`

#### `NewChatModal`
- **Purpose**: Modal for initiating a new WhatsApp conversation with any phone number (including non-CRM numbers), optional contact name, and immediate first message dispatch.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `onSuccess: (conv: ConversationDetail) => void`.
- **Import**: `import { NewChatModal } from '@/features/whatsapp/components';`

#### `WhatsAppQrConnectModal`
- **Purpose**: Multi-step full-lifecycle QR pairing modal with pairing code fallback, retry cooldowns, and live WebSocket connection state synchronization.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `session: WhatsAppSession | null`, `onConnected: () => void`.
- **Import**: `import { WhatsAppQrConnectModal } from '@/features/whatsapp/components';`

---

### Campaign Feature Components (`features/campaigns/components/`)

#### `CampaignCard`
- **Purpose**: Reusable outreach campaign card with live progress bar, sent/replied/failed counters, and start/pause/cancel triggers.
- **Props**: `campaign: Campaign`, `onStart`, `onPause`, `onCancel`.
- **Import**: `import { CampaignCard } from '@/features/campaigns/components';`

#### `CampaignGroupCard`
- **Purpose**: Vuexy-themed card displaying audience group metadata, category/location tags, WhatsApp readiness progress bar, 3-metric statistics grid, and direct actions (`[ 🚀 Kampanya Başlat ]`, `[ 👁️ Görüntüle ]`, `[ 🗑️ Sil ]`).
- **Props**: `group: CampaignGroup`, `onLaunch?: (group: CampaignGroup) => void`, `onView?: (groupId: number) => void`, `onDelete?: (group: CampaignGroup) => void`.
- **Import**: `import { CampaignGroupCard } from '@/features/campaigns/components';`

#### `SpintaxPreviewCard`
- **Purpose**: Interactive Spintax sampler card with dynamic variable injection and variation generator.
- **Props**: `template: string`, `sampleLead?: object`.
- **Import**: `import { SpintaxPreviewCard } from '@/features/campaigns/components';`

#### `CampaignDeleteModal`
- **Purpose**: Focused confirmation modal for single campaign deletion with card preview and loading state.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `onConfirm: () => void`, `isDeleting: boolean`, `campaignToDelete: Campaign | null`.
- **Import**: `import { CampaignDeleteModal } from '@/features/campaigns/components';`

#### `CampaignCreateWizard`
- **Purpose**: Comprehensive multi-step campaign builder and spintax studio supporting 6 communication goals, dynamic goal-specific inputs, AI template generation with debounce, live spintax preview, and anti-ban settings.
- **Props**: `prefill?: object | null`, `onClearPrefill?: () => void`, `onSuccess: () => void`, `onCancel: () => void`.
- **Import**: `import { CampaignCreateWizard } from '@/features/campaigns/components';`

#### `CampaignGroupDetailModal`
- **Purpose**: Read-only audience group inspection modal with metadata cards, in-group lead search, WhatsApp readiness tags, and direct launch/edit triggers.
- **Props**: `isOpen: boolean`, `groupId: number | null`, `onClose: () => void`, `onEdit: (group: CampaignGroup) => void`, `onLaunchCampaign: (group: CampaignGroup) => void`, `allGroups: CampaignGroup[]`.
- **Import**: `import { CampaignGroupDetailModal } from '@/features/campaigns/components';`

#### `CampaignGroupEditModal`
- **Purpose**: Focused group editing modal with metadata form and live CRM lead search selector with suggestions and chips.
- **Props**: `isOpen: boolean`, `group: CampaignGroup | null`, `onClose: () => void`, `onSuccess: () => void`.
- **Import**: `import { CampaignGroupEditModal } from '@/features/campaigns/components';`

#### `CampaignGroupCreateView`
- **Purpose**: Cohesive campaign group creation view with sector autocomplete, hierarchical location selector, and sidebar guide card.
- **Props**: `onCancel: () => void`, `onSuccess: () => void`.
- **Import**: `import { CampaignGroupCreateView } from '@/features/campaigns/components';`

---

### Leads & Discovery Feature Components (`features/leads/components/`)

#### `LeadDetailDrawer`
- **Purpose**: Slide-over inspector for lead records, metadata, phone verification, and campaign history.
- **Props**: `lead: Lead | null`, `isOpen: boolean`, `onClose: () => void`.
- **Import**: `import { LeadDetailDrawer } from '@/features/leads/components';`

#### `VerificationBadge`
- **Purpose**: Verification trust badge with shield icon and score indicator.
- **Props**: `status: string`, `isVerified: boolean`, `score?: number`.
- **Import**: `import { VerificationBadge } from '@/features/leads/components';`

#### `CategoryMultiSelect`
- **Purpose**: Multi-category dropdown filter with autocomplete, badge tags, and database category aggregation.
- **Props**: `selectedCategories: string[]`, `onChange: (categories: string[]) => void`, `disabled?: boolean`.
- **Import**: `import { CategoryMultiSelect } from '@/features/leads/components';`

#### `LocationMultiSelect`
- **Purpose**: Hierarchical city and district multi-select selector with search filtering and all-district bulk toggles.
- **Props**: `selectedCity: string`, `selectedDistricts: string[]`, `onChange?: (city: string, districts: string[]) => void`.
- **Import**: `import { LocationMultiSelect } from '@/features/leads/components';`

#### `SectorAutocomplete`
- **Purpose**: Industry sector search autocomplete input with Turkish search normalization and quick suggestion tags.
- **Props**: `value: string`, `onChange: (value: string) => void`, `placeholder?: string`, `disabled?: boolean`.
- **Import**: `import { SectorAutocomplete } from '@/features/leads/components';`

#### `LeadDeleteModal`
- **Purpose**: Deletion confirmation dialog for single or bulk leads.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `onConfirm: () => void`, `isDeleting: boolean`, `count?: number`.
- **Import**: `import { LeadDeleteModal } from '@/features/leads/components';`

#### `LeadBlacklistModal`
- **Purpose**: Blacklisting dialog for adding leads to the blacklist with reason selection.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `onConfirm: (reason: string) => void`, `isBlacklisting: boolean`.
- **Import**: `import { LeadBlacklistModal } from '@/features/leads/components';`

#### `LeadAddManualModal`
- **Purpose**: Form modal for creating a new lead with validation and duplicate checking.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `onSuccess: () => void`.
- **Import**: `import { LeadAddManualModal } from '@/features/leads/components';`

#### `LeadAddToGroupModal`
- **Purpose**: Selection modal for adding selected leads to an existing or new campaign group.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `leadIds: number[]`, `onSuccess: () => void`.
- **Import**: `import { LeadAddToGroupModal } from '@/features/leads/components';`

#### `LeadFinderSaveModal`
- **Purpose**: Modal to save discovered scraper leads into a new or existing campaign group.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `onConfirm: (mode: 'NEW' | 'EXISTING', groupName: string, groupId: number | null) => void`, `isSavingGroup: boolean`, `savedLeadsCount: number`, `existingGroups: CampaignGroup[]`, `defaultMode?: 'NEW' | 'EXISTING'`, `defaultGroupName?: string`.
- **Import**: `import { LeadFinderSaveModal } from '@/features/leads/components';`

#### `LeadFinderResultCard`
- **Purpose**: Interactive result card for scraper leads displaying contact info, entity badges, rating, address, and quick links.
- **Props**: `lead: any`, `keyword: string`, `isSelected: boolean`, `onToggleSelect: (key: string) => void`, `leadKey: string`, `googleMapsUrl: string`.
- **Import**: `import { LeadFinderResultCard } from '@/features/leads/components';`

#### `BlacklistAddModal`
- **Purpose**: Modal for searching leads and adding their phone numbers to the blacklist with reason selection.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `onSuccess: () => void`.
- **Import**: `import { BlacklistAddModal } from '@/features/leads/components';`

---

### Leads Feature Hooks (`features/leads/hooks/`)

#### `useLeadSelection`
- **Purpose**: Encapsulates Gmail-style multi-row selection logic across paginated tables (single toggle, page toggle, select all matching across pages, clear selection, and selected count).
- **Props**: `{ leads: Lead[]; total: number; }`
- **Returns**: `selectedIds`, `setSelectedIds`, `selectAllMatching`, `setSelectAllMatching`, `isAllCurrentPageSelected`, `isSomeCurrentPageSelected`, `handleToggleSelectAllPage`, `handleToggleSingleSelect`, `handleSelectAllAcrossPages`, `handleClearSelection`, `selectedCount`.
- **Import**: `import { useLeadSelection } from '@/features/leads/hooks';`

#### `useLeadFilters`
- **Purpose**: Encapsulates CRM lead filtering, pagination, search input, active filter chips detection, filter resetting, and API/export query parameter serialization.
- **Props**: `initialPageSize?: number` (default: 20)
- **Returns**: `search`, `setSearch`, `selectedCity`, `setSelectedCity`, `selectedDistricts`, `setSelectedDistricts`, `selectedCategories`, `setSelectedCategories`, `statusFilter`, `setStatusFilter`, `waOnly`, `setWaOnly`, `page`, `setPage`, `pageSize`, `setPageSize`, `hasActiveFilters`, `resetAllFilters`, `buildQueryParams`, `buildExportParams`.
- **Import**: `import { useLeadFilters } from '@/features/leads/hooks';`



