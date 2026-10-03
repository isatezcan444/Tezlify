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
- **Purpose**: Bottom message composer bar with 24-hour window status alerts, closed conversation notice with one-click reopen, attachment popover (native file picker with base64 upload + legacy URL modal), live microphone voice note recording (`MediaRecorder` with Opus fallback, elapsed timer, animated soundwave, trash/discard, and native `AUDIO` dispatch), outgoing "typing..." presence signals (throttled composing/paused), reply draft quote header with dismiss, and template shortcuts.
- **Props**: `onSend?: (text: string) => Promise<void> | void`, `onSendTemplate?: () => void`, `onSendMedia?: (mediaType: 'IMAGE' | 'DOCUMENT', mediaUrl: string, caption?: string, filename?: string) => Promise<void>`, `onSendMediaFile?: (file: File, caption?: string) => Promise<void>`, `onTyping?: (typing: boolean) => void`, `onReopenConversation?: () => void`, `disabled?: boolean`, `isClosed?: boolean`, `isWindowOpen?: boolean`, `placeholder?: string`, `replyingTo?: QuotedMessage | null`, `onCancelReply?: () => void`.
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

#### `WhatsAppSyncGate`
- **Purpose**: WhatsApp Web parity — full-panel "syncing" screen shown after QR pairing while the initial sync (all chats + contacts + recent messages) is still running. The live conversation list and chat pane are NOT rendered until the sync completes, so opening a chat can never fall through to an on-demand provider fetch. Progress comes only from real job/gateway counters (no fake timers), the error variant surfaces the real message with retry, and a secondary "continue anyway" escape (controlled by the parent) guarantees the user is never trapped. Faz 3: the optional `loadingGate` prop feeds the single-authority `WhatsAppLoadingGate` state (avatar counters + `loading_profiles` stage) without breaking the legacy `sync`-only behavior.
- **Props**: `sync: SessionSyncState | null`, `loadingGate?: WhatsAppLoadingGate | null`, `showEscape?: boolean`, `onContinueAnyway?: () => void`, `onRetry?: () => void`.
- **Import**: `import { WhatsAppSyncGate } from '@/features/whatsapp/components';`

#### `VoiceNotePlayer`
- **Purpose**: WhatsApp Web authentic waveform audio and voice note player. Displays animated soundwave bars, play/pause toggle, interactive seek scrubber, duration timestamps, playback speed multiplier toggle (1x / 1.5x / 2x), fail-closed audio error handling, and WhatsApp read blue transition (`#53bdeb`) once played.
- **Props**: `mediaUrl: string`, `duration?: number`, `isOutgoing?: boolean`.
- **Import**: `import { VoiceNotePlayer } from '@/features/whatsapp/components';`

#### `ChatSearchBar`
- **Purpose**: WhatsApp Web authentic in-chat message search toolbar. Features debounced query input, occurrence counter (`X / Y`), previous/next match navigation, keyboard shortcuts (Enter / Shift+Enter / Esc), and smooth scroll target integration.
- **Props**: `query: string`, `onQueryChange`, `totalMatches: number`, `currentMatchIndex: number`, `onNextMatch`, `onPrevMatch`, `onClose`.
- **Import**: `import { ChatSearchBar } from '@/features/whatsapp/components';`

#### `MediaLightbox`
- **Purpose**: WhatsApp Web authentic full-screen media inspection overlay. Portaled to `document.body` with `z-[99999]`. Supports high-resolution zoom (wheel, double-click, buttons), draggable panning when zoomed, 90° clockwise rotation, fail-closed media retry, direct download with revocation, keyboard shortcuts (Escape, +/-, R, 0), and floating caption pill.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `src?: string | null`, `mediaType?: 'IMAGE' | 'VIDEO' | 'DOCUMENT'`, `caption?: string | null`, `filename?: string | null`, `senderName?: string`, `timestamp?: string`.
- **Import**: `import { MediaLightbox } from '@/features/whatsapp/components';`

#### `DocumentViewer`
- **Purpose**: WhatsApp Web authentic document & PDF inspection lightbox overlay. Portaled to `document.body` with `z-[99999]`. Supports full embedded PDF viewing via responsive sandboxed iframe, syntax-highlighted code/text reader with line numbers and line-wrapping toggle, one-click copy to clipboard with feedback, direct printing (`Printer`), external tab open (`ExternalLink`), direct download with blob revocation, file size resolution via `HEAD`, and keyboard shortcuts (`Escape`).
- **Props**: `isOpen: boolean`, `onClose: () => void`, `src?: string | null`, `filename?: string | null`, `mimeType?: string | null`, `fileSize?: string | number | null`, `senderName?: string`, `timestamp?: string`.
- **Import**: `import { DocumentViewer } from '@/features/whatsapp/components';`

#### `ChatInfoDrawer`
- **Purpose**: WhatsApp Web authentic Contact and Group Info right-side sliding drawer. Displays high-resolution contact/group avatar (with click-to-expand lightbox), formatted phone number with one-click copy, quick action bar (in-chat search trigger, mute notification toggle), About / Description, CRM Lead profile shortcut button, comprehensive Media, Links and Docs gallery (3 tabs with image/video thumbnail grid, documents list with type badges, and parsed URLs with copy actions), Starred Messages sub-view with live reactive count, message jump navigation, unstar capability, and End-to-End Encryption security notice. Supports Escape key dismissal.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `conversation: Conversation`, `messages: Message[]`, `onOpenLead?: (leadId: number) => void`, `onSearchInChat?: () => void`, `onStatusChange?: (convId: number, status: 'ACTIVE' | 'ARCHIVED' | 'CLOSED') => void`, `onJumpToMessage?: (messageId: string | number) => void`.
- **Import**: `import { ChatInfoDrawer } from '@/features/whatsapp/components';`

#### `useWhatsAppLoadingGate` (hook)
- **Purpose**: Single-authority QR post-pairing loading gate state (WhatsApp Web parity). Fed only by real signals — backend `GET /whatsapp/loading-gate` (REST bootstrap on mount + WS reconnect) and WS `whatsapp_loading_gate` / `session_sync_*` events. No polling, no fake timers. Fires the `onReady` callback exactly once when `phase` transitions to `ready`, so the hub can auto-switch to the Live Conversations tab and eagerly load chats.
- **Signature**: `useWhatsAppLoadingGate(onReady?: () => void) => { gate, dismiss, refresh }`.
- **Import**: `import { useWhatsAppLoadingGate } from '@/features/whatsapp/hooks/useWhatsAppLoadingGate';`

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



---

## 5. Server Operations Center (`components/admin/ops/`)

Composites for the two pages that own changes to the SERVER:
`AdminOperationsPage` (service restart, logs, errors, history) and
`AdminDeploymentPage` (code deploy). The WhatsApp admin page is read-only and
hosts none of these.

All are re-exported from `components/admin/ops/index.ts`; do not create
page-local duplicates. `DeployPanel` is deliberately the only component allowed
on the deployment page, and the only one forbidden on the operations page —
restarting a service and shipping code are different risk classes.

### `ServiceStatusPanel`
- **Purpose**: Live health of each Docker service plus the allowlisted action buttons (restart / deploy). Destructive actions require confirmation, and every control is disabled while an operation is running.
- **Props**: `{ services: OpsServiceStatus[]; health: OpsHealthCheck | null; catalogue: OpsCatalogueEntry[]; loading: boolean; running: OpsOperation | null; busyName: string | null; onRun: (entry: OpsCatalogueEntry) => void }`
- **Import**: `import { ServiceStatusPanel } from '@/components/admin/ops';`

### `OpsHistoryPanel`
- **Purpose**: Recent operations with status, duration and the server-side redacted error, plus the bounded audit trail.
- **Props**: `{ operations: OpsOperation[]; audit: OpsAuditEntry[]; totalOperations?: number; offset?: number; pageSize?: number; onPageChange?: (offset: number) => void; onStatusFilter?: (status: string) => void; onNameFilter?: (name: string) => void; statusFilter?: string }`
- **Export**: `tezlify-operations-history-<ts>.csv` and `.json`, covering the retained operations AND the audit trail. Both are disabled when there is nothing to export, so an empty file can never be mistaken for "no activity". CSV cells are escaped against spreadsheet FORMULA injection: a cell starting with `=`, `+`, `-` or `@` is prefixed with an apostrophe, because the `error` and `actor` fields are attacker-influenced and an audit trail is exactly what gets opened in Excel.
- **Paging**: hidden entirely when the whole retained history fits on one page. Changing a status or name filter resets the offset, otherwise a narrower result set left on page 3 renders as an empty table that looks like data loss.
- **Import**: `import { OpsHistoryPanel } from '@/components/admin/ops';`

### `OpsLogsPanel`
- **Purpose**: Per-service log tail with level filtering. Logs are fetched on demand, never in a loop.
- **Props**: `{ services: string[]; activeService: string; lines: string[]; loading?: boolean; error?: string | null; onServiceChange: (service: string) => void; onReload: () => void; logsByService?: Record<string, string[]>; onClearLogs?: () => void; clearing?: boolean }`
- **Clear all**: `onClearLogs` is owned by the page, not the panel — the page performs the requests, the confirmation and the post-clear reload, and the panel only renders the trigger. The button is **not** disabled when the visible buffer is empty, because a level/search filter can hide every line while the server still holds logs; the endpoint reports `freed_bytes` so the toast can state what was actually reclaimed (`formatBytes.ts`) rather than a bare "done". Backend: `POST /api/v1/admin/ops/logs/clear` truncates the daemon's json log in place — see the `LOG_SERVICES` note in `ops_service.py`.
- **Level detection**: delegated to `logLevel.ts::classifyLogLevel`, shared with `ErrorFeed` so the viewer and the feed can never disagree. It parses the STRUCTURED level first — the gateway emits pino `{"level":50,...}` and caddy `{"level":"error",...}` — and only falls back to a keyword heuristic for non-JSON output. A keyword-only match filed `{"level":50,"msg":"transaction failed, rolling back"}` as INFO, so the Error feed looked empty while the gateway was throwing.
- **Export & Copy**: Two client-side downloads — `tezlify-logs-<ts>.txt` (everything visible) and `tezlify-errors-<ts>.txt` (error lines only, disabled when there are none). Also includes one-click "Panoya Kopyala" (copies all visible logs), per-line hover copy button with checkmark feedback, and a "Canlı Akış (5s)" auto-refresh toggle for real-time live monitoring. Both export and copy respect the FILTERED view, not the raw buffer.
- **Import**: `import { OpsLogsPanel, formatOpsDateTime, formatOpsTime } from '@/components/admin/ops';`

### `ErrorFeed`
- **Purpose**: Deduplicated recent errors aggregated from the loaded service logs, each linking to the owning service, a next action, and direct one-click copy buttons (both bulk "Tüm Hataları Kopyala" and per-error "Kopyala").
- **Props**: `{ logsByService: Record<string, string[]>; catalogue: OpsCatalogueEntry[]; runningName?: string | null; onRun: (entry: OpsCatalogueEntry) => void; onViewLogs: (service: string) => void }`
- **Import**: `import { ErrorFeed } from '@/components/admin/ops';`

### `OverviewPanel`
- **Purpose**: Read-only summary of the whole deployment — service count, health verdict, database and WhatsApp state, recent operations, and a warning when the server cannot persist its audit trail. Composes the existing admin overview and ops payloads; introduces no new endpoint.
- **Props**: `{ overview: AdminOverviewResponse | null; services: OpsServiceStatus[]; health: OpsHealthCheck | null; operations: OpsOperation[]; loading?: boolean; persistenceOk?: boolean; orphanedCount?: number; orphanedDetail?: { id: string; session_name?: string; since?: string | null }[]; ghostConnected?: string[] }`
- **Two distinct warnings, because they are different failures**: `orphanedCount` is a session that IS emitting but whose writes are discarded (its DB row is gone); `ghostConnected` is a session the DATABASE calls CONNECTED while the gateway serves nothing at all, so no message can arrive. The second is the production state behind the unexplained `chats: 0` — `WHATSAPP_AUTO_RESTORE` is false, so a gateway restart leaves zero live sessions while the row still says CONNECTED. Detection compares the gateway's `live_session_ids` against the database's CONNECTED rows; an unreachable gateway yields `null`, not `[]`, so an outage is never mistaken for "no sessions".
- **Orphan warning**: renders a red banner when `orphanedCount > 0`. A gateway session can report `CONNECTED` and still store NOTHING — re-pairing deletes the `whatsapp_sessions` row while the gateway keeps the session in memory, so its events only reach the backend over the live socket and vanish on restart. The banner names the affected session and states the remedy (re-pair from the WhatsApp screen) rather than a vague failure. The count comes from the existing admin WhatsApp payload's `gateway_runtime.orphaned_count`; no new endpoint, and `/health` still reports `status: ok` because an orphaned session is not a gateway fault.
- **Import**: `import { OverviewPanel } from '@/components/admin/ops';`



### `DeployPanel`
- **Purpose**: The cohesive deploy action — pull, rebuild, recreate, verify, as ONE ordered pipeline. Replaces the three separate `deploy_pull` / `deploy_build` / restart controls, which let an operator pull and forget to build (panel shows the new commit while the old image serves) or build without pulling (shipping a rebuild of the previous commit). A failure at any stage stops the rest. The action is resolved from the catalogue so the allowlist stays the single source of truth, and it is disabled whenever another operation is running.
- **Props**: `{ catalogue: OpsCatalogueEntry[]; running: OpsOperation | null; busyName: string | null; onRun: (entry: OpsCatalogueEntry) => void }`
- **Import**: `import { DeployPanel } from '@/components/admin/ops';`

### `useOpsEvents` (hook)
- **Purpose**: Subscribes to `operation.*` events on the shared `/ws` stream so operation progress is realtime. Reuses the managed `createWebSocket` factory, so auth-refresh and backoff behaviour stay identical to the rest of the product. Polling remains only as a fallback when the socket is down.
- **Props**: `(enabled: boolean, { onOperation: (op: OpsOperation, event: string) => void; onConnectionChange?: (connected: boolean) => void })`
- **Returns**: `connected: boolean`
- **Import**: `import { useOpsEvents } from '@/hooks/useOpsEvents';`

### `LinkPreviewCard`
- **Purpose**: WhatsApp Web-shaped preview card for a link found in a message body — image, site name, title, description and an open action. Rendered under the text, never instead of it.
- **Props**: `{ preview: LinkPreview; isOutbound?: boolean }`
- **Image is always proxied, never hotlinked**: `preview.image_url` is the server-issued authenticated path (`/api/v1/whatsapp/link-preview/image?u=<hash>`), not the remote address. Loading the remote image directly would leak the reader's IP and browser fingerprint to the third-party site, and would break on referrer/CORS rules; `referrerPolicy="no-referrer"` is set for the same reason.
- **Embeds are click-to-load and allowlisted**: the iframe renders only when `preview.embed_url` is present, which the server fills **only** for an explicit provider allowlist (YouTube, via `youtube-nocookie.com`). Putting an arbitrary URL in an iframe means running third-party content with the user's session — that is why the decision lives on the server, not in this component.
- **Import**: `import { LinkPreviewCard } from '@/features/whatsapp/components';`

### `DocumentCard`
- **Purpose**: Turns a document message from "a filename and a download icon" into a real card: type icon, type badge, filename, MIME, and separate Open / Download actions.
- **Props**: `{ filename?: string | null; mimeType?: string | null; url?: string | null; isOutbound?: boolean }`
- **Type is resolved from extension AND MIME together**: the gateway reports some attachments as `application/octet-stream`, so MIME alone would lose the type and the filename extension alone would miss the rest. Both are consulted.
- **No file size, deliberately**: `messages` has no size column (`media_id` / `media_mime_type` / `media_filename` / `media_caption` only). Showing a size would mean inventing one. Open and Download are separate actions because they are separate intents — Open renders a PDF in the browser's viewer, Download saves it.
- **Import**: `import { DocumentCard } from '@/features/whatsapp/components';`

### `Dropdown` (extended, not new)
- **Purpose**: Pre-existing menu component; two capabilities were added rather than forking it.
- **`portal?: boolean`**: renders the menu into `document.body` with `position: fixed`, measured from the trigger's rect and **re-measured on scroll/resize** (scroll is listened to in the capture phase, since scroll does not bubble). Without it a menu inside a scrolling container — the conversation list — is clipped by `overflow-y-auto`. The outside-click test must check **both** the trigger and the portalled menu, or `mousedown` closes the menu before the item's `click` ever fires.
- **`onOpenChange?: (open: boolean) => void`**: reports open/close so a caller can keep a hover-revealed trigger visible. A portalled menu is no longer inside the row, so hovering the menu un-hovers the row and the trigger would vanish while its own menu is open.
- **`data-testid="dropdown-menu"`**: stable hook on the menu container. The menu has no accessible role of its own, so a DOM gate would otherwise have to match on Tailwind classes (`z-[99999]`) to find it.
- **Import**: `import { Dropdown, DropdownItem } from '@/components/ui/Dropdown';`

### `ConversationList` row menu ("aşağı ok") — extension of `ConversationList`, not a new component

- **Purpose**: WhatsApp Web parity for a live conversation row: a chevron that reveals Archive / Close / Reopen / Delete. Hidden until hover or focus (`opacity-0` → `group-hover:opacity-100`), and the row's timestamp hides while the chevron is shown, because both occupy the same corner.
- **Props added**: `onArchive?`, `onClose?`, `onReopen?`, `onDelete?` — all `(id: number) => void`. The menu renders only when at least one is provided.
- **The trigger is a SIBLING of the row `<button>`, never a child**: a nested `<button>` is invalid HTML, and the click would also select the conversation. Asserted by the gate.
- **Menu items are state-aware**: an archived row offers Reopen, an active row offers Archive + Close; Delete is always last and carries the danger variant. The action list is derived from the conversation's *current* state — offering "Archive" on an already-archived chat is a promise the UI cannot keep.
- **`isArchived?: boolean` (row prop)** — *the invariant*: "archived" must mean the **same thing** here as in the list filter, i.e. `is_archived` (WhatsApp/gateway metadata) **OR** `status === 'ARCHIVED'` (CRM action). The filter always used both; the row menu originally used only `status`, so a chat archived on the phone showed up in the Archived tab offering "Archive". Both sides now read the same predicate.
- **Callbacks must have stable identities** (`statusChangeRef` + four `useCallback([])` wrappers in `WhatsAppHubPage`). The row is `React.memo`-wrapped, so a callback whose identity changes every render re-renders every row. The same reason `handleSelectById` exists.
- **Gate**: `npm run verify:conv-menu` (`scripts/verify-conversation-menu-dom.mjs`) — 9 checks, including that the menu is portalled **out of** the scroll container and that opening it does not also select the chat.
- **Import**: `import { ConversationList } from '@/features/whatsapp/components';`
