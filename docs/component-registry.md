# Tezlify Component Registry

This document serves as the single centralized registry for all reusable components in the Tezlify frontend design system (based on the Vuexy Admin Template architecture).

---

## Component Taxonomy

```
components/
├── ui/              # Foundation UI Primitives (Buttons, Badges, Cards, Modals, Overlays)
├── forms/           # Form Controls, Inputs, Sliders, Switches, Sections
├── data-display/    # Tables, Timelines, Toolbars, Cells, Funnels
├── navigation/      # Steppers, Breadcrumbs, Tabs
├── domain/          # Product/Domain Composites (LeadDetailDrawer, SessionCard, CampaignCard)
└── Layout/          # Structural Layout Components (Sidebar, TopHeader)
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

## 4. Domain Components (`components/domain/`)

### `LeadDetailDrawer`
- **Purpose**: Slide-over inspector for lead records, metadata, phone verification, and campaign history.
- **Props**: `lead: Lead | null`, `isOpen: boolean`, `onClose: () => void`.
- **Import**: `import { LeadDetailDrawer } from '@/components/domain';`

### `SessionCard`
- **Purpose**: Reusable WhatsApp account card with warmup day indicator, battery level, daily quota, and disconnect/scan triggers.
- **Props**: `session: WhatsAppSession`, `onDisconnect`, `onScanQR`, `onDelete`.
- **Import**: `import { SessionCard } from '@/components/domain';`

### `CampaignCard`
- **Purpose**: Reusable outreach campaign card with live progress bar, sent/replied/failed counters, and start/pause/cancel triggers.
- **Props**: `campaign: Campaign`, `onStart`, `onPause`, `onCancel`.
- **Import**: `import { CampaignCard } from '@/components/domain';`

### `CampaignGroupCard`
- **Purpose**: Vuexy-themed card displaying audience group metadata, category/location tags, WhatsApp readiness progress bar, 3-metric statistics grid, and direct actions (`[ 🚀 Kampanya Başlat ]`, `[ 👁️ Görüntüle ]`, `[ 🗑️ Sil ]`).
- **Props**: `group: CampaignGroup`, `onLaunch?: (group: CampaignGroup) => void`, `onView?: (groupId: number) => void`, `onDelete?: (group: CampaignGroup) => void`.
- **Import**: `import { CampaignGroupCard } from '@/components/domain';`

### `SpintaxPreviewCard`
- **Purpose**: Interactive Spintax sampler card with dynamic variable injection and variation generator.
- **Props**: `template: string`, `sampleLead?: object`.
- **Import**: `import { SpintaxPreviewCard } from '@/components/domain';`

### `VerificationBadge`
- **Purpose**: Verification trust badge with shield icon and score indicator.
- **Props**: `status: string`, `isVerified: boolean`, `score?: number`.
- **Import**: `import { VerificationBadge } from '@/components/domain';`

### `ChatBubble`
- **Purpose**: WhatsApp message bubble primitive with inbound/outbound styling, timestamps, delivery/read checkmarks, and inline retry button for FAILED messages.
- **Props**: `message: Message`, `onRetry?: (messageId: number) => Promise<void> | void`.
- **Import**: `import { ChatBubble } from '@/components/domain';`

### `ChatThread`
- **Purpose**: Interactive scrollable message timeline with date separators, loading skeletons, empty state, smart auto-scroll, and failure retry dispatching.
- **Props**: `messages: Message[]`, `loading?: boolean`, `hasMore?: boolean`, `loadingOlder?: boolean`, `onLoadOlder?: () => void`, `leadName?: string`, `leadPhone?: string`, `onRetry?: (messageId: number) => Promise<void> | void`.
- **Import**: `import { ChatThread } from '@/components/domain';`

### `ChatComposer`
- **Purpose**: Bottom message composer bar with 24-hour window status alerts, closed conversation notice with one-click reopen, attachment popover (Photo/Document), and template shortcuts.
- **Props**: `onSend?: (text: string) => Promise<void> | void`, `onSendTemplate?: () => void`, `onSendMedia?: (mediaType: 'IMAGE' | 'DOCUMENT', mediaUrl: string, caption?: string, filename?: string) => Promise<void>`, `onReopenConversation?: () => void`, `disabled?: boolean`, `isClosed?: boolean`, `isWindowOpen?: boolean`, `placeholder?: string`.
- **Import**: `import { ChatComposer } from '@/components/domain';`

### `TemplateSelectModal`
- **Purpose**: Modal for selecting pre-approved WhatsApp business templates with automated recipient variable pre-filling, real-time message preview, and one-click dispatch.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `leadName?: string`, `onSendTemplate: (templateKey: string, variables: Record<string, string>) => Promise<void>`.
- **Import**: `import { TemplateSelectModal } from '@/components/domain';`

### `ConversationList`
- **Purpose**: Sidebar list of all active conversation threads with search filtering, avatar hashing, unread badges, and last message previews.
- **Props**: `conversations: Conversation[]`, `selectedId?: number`, `onSelect: (conv: Conversation) => void`, `loading?: boolean`, `searchQuery?: string`, `onSearchChange?: (q: string) => void`.
- **Import**: `import { ConversationList } from '@/components/domain';`

### `NewChatModal`
- **Purpose**: Modal for initiating a new WhatsApp conversation with any phone number (including non-CRM numbers), optional contact name, and immediate first message dispatch.
- **Props**: `isOpen: boolean`, `onClose: () => void`, `onSuccess: (conv: ConversationDetail) => void`.
- **Import**: `import { NewChatModal } from '@/components/domain';`


