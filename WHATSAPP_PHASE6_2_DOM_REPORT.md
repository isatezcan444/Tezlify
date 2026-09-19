# TEZLIFY WHATSAPP — PHASE 6.2 REPORT
## DOM / React Runtime Verification

Phase 6.1 established that DB, backend event state, WebSocket payload and React
**state** converge. This phase answers the remaining question:

> React state may be correct — but is the *rendered DOM behaviour* correct under
> WhatsApp-Web-like usage?

---

## 1. DOM TEST RESULTS

| Scenario | Result | Evidence |
|---|---|---|
| **G-bottom** | **PASS** | `G-bottom: a new inbound while at the bottom stays pinned and shows no pill` — message in DOM, `scrollTop == scrollHeight - clientHeight`, no pill. |
| **G-reading-old** | **PASS** | `G-reading-old: ... preserves the position and raises the pill` — `scrollTop` unchanged, pill visible, new message rendered. |
| **scroll-anchor** | **PASS** | `scroll-anchor: prepending an older page keeps the same message in place` — anchor viewport offset identical before/after a 30-message prepend. Falsification variant (`scrollTop = previousScrollTop`) is rejected. |
| **older-page + new-message race** | **PASS** | `older-page-race: ... keeps position, message and pill` — live message appears exactly once, prepend compensated, user not thrown to the bottom, pill raised. |
| **new-message pill** | **PASS** | 3 checks: no pill at bottom; pill when away from bottom; click → scrolls to bottom and dismisses; manual scroll to bottom dismisses. |
| **pagination-render** | **PASS** | `pagination-render: a refresh keeps both loaded pages in the DOM` — 100 rows retained, oldest page still rendered, new message once. `messages = incoming` variant rejected. |
| **conversation-list + active chat** | **PASS** | `conversation-list: new activity reorders to the top without remounting the active chat` — conversation moves to top; the thread DOM node is the **same object** (no remount); scroll position and selection preserved. |
| **unread-render** | **PASS** | `unread-render: a real external-read payload clears the badge in the DOM` — badge 5 gone from the DOM for all three real backend payloads (external read, stale-older, stale-same-timestamp). |
| **identity-render** | **PASS** | `identity-render: ...` — no raw `@lid`/`@s.whatsapp.net` ever rendered; after mapping, the resolved name renders in list **and** header; conversation id unchanged. |
| **group-render** | **PASS** | `group-render: late group metadata updates the title without disturbing the thread` — subject applied, preview / `last_message_at` / ordering unchanged. |
| **conversation-switch** | **BUG → FIXED** | `conversation-switch: opening another chat lands on the newest message` — see P6-4. |
| **composer-isolation** | **BUG → FIXED** | `composer-isolation: switching conversations must not carry the draft over` — see P6-5. **Critical**: the draft could be sent to the wrong person. |

**17 DOM checks PASS.** Four **CONFIRMED BUGS** were found and fixed while
building them (P6-2, P6-3, P6-4, P6-5) — so the answer to the phase question is
*not* "no new bug": the React state was right, but four real defects lived on
the path to what the user actually sees. One of them (P6-5) can deliver a
message to the wrong recipient.

---

## 2. CONFIRMED BUGS

### P6-2 — a stale snapshot with the SAME timestamp resurrected the unread badge

**ID:** P6-2 · **STATUS:** FIXED · **Severity:** high (regression gap in the P6-1 fix)

**USER IMPACT**
You read a chat on your phone. Tezlify's badge clears. A snapshot produced
*before* that read then arrives and **the badge comes back** — and it stays,
because no new message ever supersedes it. P6-1 (Phase 6.1) only closed the
strictly-older case; this is the equal-timestamp case, which is the realistic
one, since reading a chat does not create a new message.

**EXACT REPRODUCTION**
`backend/tests/test_whatsapp_phase6_scenarios.py::
test_scenario_i_external_read_survives_same_timestamp_snapshot`

```
conversation: unread_count = 8, last_message_at = T4
1. gateway snapshot  unread_count = 0, last_message_at = T4   (external read)
2. gateway snapshot  unread_count = 8, last_message_at = T4   (pre-read snapshot)
   -> BEFORE FIX: unread_count = 8   (resurrected)
   -> AFTER  FIX: unread_count = 0
```

**ROOT CAUSE**
`should_apply_unread_count` guarded staleness purely by timestamp, and
specifically blocked only `inc_ts < cur_ts`. An **external** read changes
neither timestamp:

- `last_message_at` — no new message arrived, so it stays `T4`;
- `last_read_at` — only `mark_conversation_read` (our own read) stamps it, so it
  stays `NULL`.

A pre-read snapshot is therefore **byte-identical in its evidence** to the
current state, so no guard fired. Measured directly:
`PROBE equal-ts unread = 8, last_read_at = None`.

**FIX**
Two changes, in `backend/app/services/whatsapp/repositories/conversations.py`:
an authoritative drop to zero **is** read evidence, so it now stamps
`conv.last_read_at`. The stamp is `conv.last_message_at` (not wall-clock `now`)
so the read guard stays comparable with provider timestamps and a message that
genuinely arrives later still raises the badge.

```python
if new_value == 0 and previous > 0:
    conv.last_read_at = conv.last_message_at or conv.last_read_at
```

The guard is unchanged; it simply now has evidence to compare against
(`inc > cur and inc_ts <= read_ts` → reject).

**Rejected alternative.** I first tried "a raise requires strictly newer
activity" (`inc_ts <= cur_ts` → reject). The full suite proved that wrong: it
broke 3 tests, because a snapshot legitimately reporting the **full** count
(0 → 5, 1 → 7) at an unchanged timestamp is normal, not stale. Recording read
evidence is the targeted fix.

**FAIL PROOF**
```
AssertionError: same-timestamp stale snapshot resurrected unread to 8
assert 8 == 0
```
(literal probe output before the fix: `PROBE equal-ts unread = 8`)

**PASS PROOF**
`1080 passed` across `backend/tests`; the specific test passes, and the
`ws_stale_snapshot_same_ts` payload emitted by the real backend now carries
`unread_count: 0`.

**REGRESSION TEST**
`test_scenario_i_external_read_survives_same_timestamp_snapshot` — also asserts
a genuinely new message still raises the badge afterwards (0 → 1), so the fix
cannot over-suppress.

---

### P6-3 — loading an older page raised a spurious "new message" pill

**ID:** P6-3 · **STATUS:** FIXED · **Severity:** medium (misleading UI)

**USER IMPACT**
While reading older history, every older page you load pops the green "new
message" pill, as if something arrived. Clicking it throws you to the bottom,
away from the history you were reading.

**EXACT REPRODUCTION**
`node frontend/scripts/verify-whatsapp-dom.mjs` — check
`scroll-anchor: a pure older-page load must NOT raise the new-message pill`
(found by a probe added while verifying §3).

**ROOT CAUSE**
`ChatThread` decided "a new message arrived" from the list length alone:

```js
const isNewMessageAdded = sortedMessages.length > prevMessagesCountRef.current;
if (isNewMessageAdded && !isPrependingRef.current) { ...pill / auto-scroll... }
```

`isPrependingRef` would have excluded a prepend — but the prepend-restore
`useLayoutEffect` sets `isPrependingRef.current = false` on the successful
restore path, and **layout effects run before passive effects in the same
commit**. By the time the auto-scroll `useEffect` runs, the guard is already
cleared, so the prepend is reported to the user as a new message.

**FIX**
Distinguish a prepend from an append by the identity of the **newest** message.
A prepend grows the list but leaves the newest message untouched; only a
genuinely new message changes it.

```js
const isNewMessageAdded =
  sortedMessages.length > prevMessagesCountRef.current &&
  newestKey !== prevNewestKeyRef.current;
```

This also keeps the §4 race correct: a prepend **and** a real new message in the
same commit still raises the pill (`older-page-race` still passes).

**FAIL PROOF**
`AssertionError [ERR_ASSERTION]: loading older messages raised a spurious
new-message pill`

**PASS PROOF**
14/14 DOM checks, including `older-page-race` (pill still raised when a real
message arrives alongside a prepend).

**REGRESSION TEST**
`scroll-anchor: a pure older-page load must NOT raise the new-message pill`.

---

### P6-4 — switching conversations inherited the previous thread's viewport

**ID:** P6-4 · **STATUS:** FIXED · **Severity:** high (every conversation switch)

**USER IMPACT**
Scroll up to read history in one chat, then open another: the new chat opens at
whatever offset you were at — mid-history instead of the newest message — and
often with a spurious green "new message" pill. WhatsApp Web always opens a
chat at the newest message.

**EXACT REPRODUCTION**
`node frontend/scripts/verify-whatsapp-dom.mjs` →
`conversation-switch: opening another chat lands on the newest message`

**ROOT CAUSE**
`ChatThread` is rendered **without a key** (`WhatsAppHubPage.tsx:2109`), so
switching conversations reuses the same component instance. Two pieces of state
survive the switch that must not:

- the real DOM `scrollTop` of the scroll container (same element, new children);
- `isNearBottom`, which is `false` after reading history, so the initial-scroll
  effect (`if (!loading && length > 0 && isNearBottom)`) deliberately does
  nothing.

Whether the new chat has more, fewer, or the same number of messages, the auto-
scroll effect never fires: it requires the list to **grow**, and `isNearBottom`
is stale.

**FIX**
Key the thread by conversation id, so a switch remounts it (fresh state →
lands at the bottom) while a *reorder* keeps the same id and therefore does
**not** remount — which is what §7 requires:

```jsx
<ChatThread key={selectedConv.id} messages={activeMessages} ... />
```

**FAIL PROOF**
`AssertionError: switching conversations must land at the bottom, not inherit
A's viewport` (and the source guard fails with
`ChatThread must be keyed by conversation id so a switch remounts it`).

**PASS PROOF**
17/17 DOM checks; `conversation-list: new activity reorders to the top without
remounting the active chat` still passes, proving reorder is unaffected.

**REGRESSION TEST**
`conversation-switch: opening another chat lands on the newest message` in the
DOM harness, plus a source assertion `§P6.4` in `verify-whatsapp-logic.mjs`
that fails if the key is ever removed.

---

### P6-5 — a draft typed in one chat is carried into the next chat and can be sent to the wrong person

**ID:** P6-5 · **STATUS:** FIXED · **Severity: critical** (wrong-recipient message)

**USER IMPACT**
Type a message in chat A without sending it, switch to chat B, press send: the
text written for A is delivered to B. The user sees the text still sitting in
the box, so nothing signals the switch. This is the worst failure mode found in
Phase 6 — silent, irreversible, and invisible until the recipient replies.

**EXACT REPRODUCTION**
`node frontend/scripts/verify-whatsapp-dom.mjs` →
`composer-isolation: switching conversations must not carry the draft over`

**ROOT CAUSE**
`ChatComposer` is rendered **without a key** (`WhatsAppHubPage.tsx`), and it
owns the draft in **private state** — `const [text, setText] = useState('')`.
It is worse than P6-4 because there is no *prop* that could reset it: the
component's props carry **no conversation identifier at all**. Its only two
effects are a typing-idle timer and an unmount cleanup; neither clears `text`.

So switching conversations changes nothing observable to the composer: same
instance, same state, draft intact. The same applies to the other private state
(`mediaUrl`, `mediaCaption`, `isAttachMenuOpen`).

**FIX**
Key the composer by conversation id, exactly as for the thread:

```jsx
<ChatComposer key={selectedConv.id} onSend={async (text) => { ... }} ... />
```

A switch remounts the composer (draft cleared); typing in the same chat does
not. Chosen over adding a reset effect because the composer has no conversation
prop to watch — a key is the only mechanism that expresses "this state belongs
to *this* conversation" without threading new props through the component.

**FAIL PROOF**
The DOM harness renders both variants: keyed → the switched-to composer's
`textarea` is empty; unkeyed → it still contains the text typed for the other
chat. The unkeyed variant is asserted to leak, so the check fails if the bug is
ever reintroduced *and* stays honest about what it is testing.

**PASS PROOF**
17/17 DOM checks.

**REGRESSION TEST**
`composer-isolation: switching conversations must not carry the draft over` plus
its broken-variant twin, and a source assertion in `verify-whatsapp-logic.mjs`
that fails if the key is removed.

**SECOND CALL SITE CHECKED — NOT AFFECTED**
`ChatThread` / `ChatComposer` are also rendered in
`LeadDetailDrawer.tsx:321/340`. Verified that P6-4/P6-5 do **not** apply there:

- `Drawer.tsx:52` returns `null` when closed, so the whole subtree unmounts on
  close — every open builds a fresh composer.
- `Drawer.tsx:66-67` renders a full-screen backdrop with `onClick={onClose}`,
  so the `lead` prop cannot change while the drawer is open; any click behind
  it closes first.
- `LeadDetailDrawer.tsx:188` gates the chat branch on `activeTab === 'chat'`,
  so leaving the chat tab also unmounts the composer.

Consequence, deliberately left as-is: switching to the Overview tab and back
**discards** a draft in the drawer. That is a minor UX difference from the hub
page, not a wrong-recipient risk. No change made.

**SIDE EFFECT ACCEPTED**
Keying the composer means its unmount cleanup fires on a switch, which sends a
`typing = false` signal — but only when the user actually was typing
(`typingActiveRef`). That is the desired behaviour: chat A must stop showing
"typing…" when the user moves to chat B.

**NOTE**
P6-4 and P6-5 share one root cause — *per-conversation state in an unkeyed
component* — but they are distinct defects: P6-4 is a display bug (wrong
viewport), P6-5 is a correctness bug (wrong recipient). Both were found by the
same question: "what state must not survive a conversation switch?"

---

## 3. NOT BUG

| Observation | Verdict | Why |
|---|---|---|
| The frontend raises the badge when fed a stale payload directly | **Not a bug** | `resolveUnreadCount` applies the backend value verbatim *by design* — the backend is the sole authority and now rejects both stale cases. Feeding the helper a payload the backend would never emit is not a reachable state. The DOM test was rewritten to consume **real** backend payloads instead. |
| `markAsRead` in `useWhatsAppConversation.ts:151` and its `markAsRead` locale string appear unused | **Not a bug** | The hub page marks read directly, in two places that together cover every path: opening a chat (`WhatsAppHubPage.tsx:521-531`) and an inbound arriving in the chat you are already viewing (`:1189-1196`, guarded at `:1138` by `selectedConv.id === convId`). The hook export and the locale key are dead code, not a missing feature. |
| The auto-read call at `:1193` omits the `known` argument that `:525` passes | **Not a bug** | `known` only shapes the *return value* (`whatsappApi.ts:751`); the repository is a straight pass-through (`whatsappRepository.ts:220-226`). No extra request is made either way. |
| A failed auto-read would toast on every inbound | **Not a bug** | `reportReadSync` (`:179-191`) toasts only when `opts.notify` is set. Only the list-click path passes `notify: true` (`:1980`); the open and auto paths log to console only — exactly what the comment at `:1191` promises. |
| `scrollTop` clamped to 0 with 2 messages | **Test artefact** | Content shorter than the viewport is genuinely unscrollable; my box model clamps correctly. Fixed by giving the test 30 rows. |
| `'mesaj-61'` matched 2 rows | **Test artefact** | `mesaj-6` + timestamp `15:00` concatenates to `mesaj-615:00`, which contains `mesaj-61`. Fixed with a `#` delimiter. |
| Anchor offset "moved" 80 → 230 | **Test artefact** | I measured `offsetBefore` at a different scroll position than the one the component captured. Fixed. |
| Thread scroll position lost after reorder | **Test artefact** | My selector grabbed `ConversationList`'s scroller. Scoped to `#thread`. |

---

## 4. TEST INFRASTRUCTURE

**Runtime chosen — minimal intervention.** The repo is an **npm workspace root**
(`workspaces: [frontend, whatsapp-gateway]`), has no test runner, and no DOM.
Rather than adding vitest + React Testing Library + jsdom, I added **one**
devDependency — `jsdom@30.1.0` — and reused the repo's existing
esbuild-script pattern. React 18.3.1 already ships `act`, and `esbuild` was
already present via vite. New commands:

```
npm run verify:dom      # node scripts/verify-whatsapp-dom.mjs
npm run verify:logic    # node scripts/verify-whatsapp-logic.mjs
```

`jsdom` is declared in `frontend/package.json` and hoisted to the workspace
root `node_modules` (expected workspace behaviour).

**Real components, not copies.** `ChatThread`, `ConversationList` and
`I18nProvider` are the shipped modules, rendered with React 18 `createRoot`
into a real jsdom document. Only the network/provider boundary is stubbed.

**Layout model — and why it is honest.** jsdom has **no layout engine**:
`scrollHeight`/`clientHeight` are always 0 and `scrollTop` is unobservable, so
scroll anchoring cannot be *measured* without a model. The harness installs an
explicit one — uniform `ROW_H` per rendered child, fixed `VIEWPORT`, and a real
mutable `scrollTop` clamped to `[0, scrollHeight - clientHeight]`. The
component's logic (scroll handler, `useLayoutEffect` restore, pill state,
auto-scroll decision) all really execute; only the box metrics are simulated.
This is stated in the harness header.

**Falsification is in-script, not manual.** Every critical invariant has a
broken variant executed on each run, and the script asserts the broken variant
**throws**:
- scroll anchoring — `scrollTop = previousScrollTop` (no height compensation);
- pagination — `messages = incoming` (pages wiped).

Both are listed in the output as "(broken variant correctly rejected)".

**Isolation.** Each check mounts into a fresh host element and unmounts; no
database, no network, deterministic timestamps. Order-independent by
construction. `dom.window.close()` + `process.exit(0)` are required — jsdom's
`pretendToBeVisual` keeps a rAF timer alive and the process otherwise hangs
(this cost one 5-minute hang).

**Source change made to enable testing.** `WhatsAppHubPage`'s inline
`conversation_updated` merge was extracted verbatim into
`frontend/src/features/whatsapp/lib/whatsappConversationPatch.ts`
(`applyConversationEvent`) so §8 could drive the **real** merge path instead of
a copy — the same pattern as Phase 5's `resolveUnreadCount`. The harness
asserts the hub page still delegates to it.

**Stale assertion fixed (self-inflicted).** `verify-whatsapp-logic.mjs` had a
source-text check requiring `resolveUnreadCount(...)` to appear literally in
`WhatsAppHubPage.tsx`. After the extraction it does not; the check now asserts
delegation to `applyConversationEvent` **and** that the helper routes through
`resolveUnreadCount`.

**`npm run build` intermittently failed in long chains — environment, not product.**
`vite build` empties `dist/` first; the sandbox's bulk-delete guard aborted it with
`SAFE_DELETE_BULK_CONFIRM_REQUIRED {"count":170,"threshold":50,"scope":"turn"}`. The count is
**cumulative for the whole turn**, not the size of `dist` (which holds 2 files), which is why the
first build in a chain succeeds and a later one fails. Verified green: `tsc --noEmit` exit 0,
1630 modules transformed, `vite build --emptyOutDir false` exit 0, and `npm run build` exit 0.
No change was needed to the project.

**Real backend payloads.** `scratch/p6_dump_ws_payloads.py` now also emits
`ws_stale_snapshot_older` and `ws_stale_snapshot_same_ts`; both carry
`unread_count: 0`, proving the backend fix reaches the wire.

---

## 5. FINAL GATES

| Gate | Result |
|---|---|
| Backend `pytest backend/tests -q` | **1080 passed** (was 1079; +1 P6-2 regression test) |
| Gateway `test-*.mjs` | **19/19** |
| Frontend `tsc --noEmit` | **0** |
| Frontend `npm run build` | **success** |
| Frontend `verify:logic` | **43 checks PASS** (was 40; +2 extraction-equivalence, +1 P6-4 key guard) |
| Frontend `verify:dom` *(new)* | **17 checks PASS** |
| `git diff --check` | **clean** |

---

## 6. REMAINING BLOCKERS

1. **Nothing in Phases 3–6 is committed, let alone deployed.** Production is at
   `f6ec68d`; local HEAD is `f4db4dd` (2 missing commits), and **all Phase 3–6
   work is uncommitted locally**. P6-2 and P6-3 are therefore not live either.
   No deploy, migration, pairing or send was performed in this phase.
2. **P5-1 still has no live end-to-end confirmation** — one media send to a
   self-owned number after deploy.
3. **Rendered behaviour is now covered, but only under a simulated layout
   model.** A real browser (Playwright) would verify true layout, smooth
   scrolling and real measurement. The logic is covered; the pixels are not.
4. **jsdom is a new devDependency.** Deliberate and minimal, but it is a
   dependency change that should be reviewed.

---

## 8. FINAL SWEEP — THREE HYPOTHESES TESTED, ALL CLEAN

Having found four bugs, I looked for a fifth along three more axes and **found
none**. Reporting the negative results because "clean" is only meaningful once
you say what was checked.

- **Other per-conversation state in the hub page.** `messagesMap`,
  `messagePaging` and `peerTypingMap` are all keyed by conversation id, so
  unlike the two child components they cannot leak. The chat pane contains only
  `ChatThread`, `ChatComposer` and `TemplateSelectModal`; the first two are now
  keyed and the third is driven by `isOpen`. **Class exhausted.**
- **Is a conversation marked read?** Yes, on both paths (see §3). The one gap I
  expected — a message arriving in the chat you are already looking at — is
  explicitly handled and guarded to the selected conversation.
- **Does the read-sync failure spam toasts?** No — `notify` is opt-in and only
  the click path sets it.

**One real (small) finding:** `frontend/scripts/test-whatsapp-message-merge.mjs`
passes but was wired to **no npm script**, so nothing ran it and it would
silently rot. Registered as `npm run verify:merge`; it passes.

**Two message-reconciliation implementations — not a bug today, but a latent one.**
`mergeWhatsAppMessages` (`lib/whatsappMessageMerge.ts`, used by refresh/reconnect/sync-chunk) keys
by `id:`/`wa:`/`client:` and can **collapse two slots** when a later event links both identities —
"A provider echo and optimistic row may predate the event linking both IDs." It also keeps a
positive `id` over a placeholder and never clears `wa_message_id`/`client_message_id`.
The **live WS path** instead uses an inline `findIndex` (`WhatsAppHubPage.tsx:1162-1187`) over three
OR'd keys. It cannot link slots, and falls back to `id: msgId || Date.now()`. It does apply
`mergeDeliveryStatus` on a match.

This is safe today only because the backend backfills `client_message_id` into the WS event
(`orchestration/events.py:1179`; lookups at `:1019-1027`, `:1159-1160`) and into created payloads
(`messaging.py:70`), so the key is present when the echo arrives. **If an echo ever omits it, the
live path would render a duplicate message where the helper would not.** Recorded rather than
refactored: unifying them is a change to shipped code, and the two paths are not byte-identical, so
it needs the same equivalence proof I used for `applyConversationEvent`.

**Build flake, correctly attributed.** `npm run build` failed twice more in long
chains. The log names the cause exactly:
`SAFE_DELETE_BULK_CONFIRM_REQUIRED {"count":179,"threshold":50,"scope":"turn"}`
— `vite build` empties `dist/` first and my sandbox's bulk-delete guard blocks
it once the *turn's* cumulative delete count exceeds 50. It is not the size of
`dist` (2 files) and not the project. Verified green in a fresh turn:
`1630 modules transformed`, `built in 1.90s`, exit 0.

## Final gates
Backend **1080 passed** · Gateway **19/19** · tsc **0** · build **success** ·
logic **43** · DOM **17** · merge **PASS** · `git diff --check` clean.

---

## 7. POST-REPORT HARDENING

Three follow-ups after the first draft, all verified:

- **`last_read_at` consumer audit (P6-2 safety).** The new write touches a field
  used by `mark_conversation_read`. Audited all consumers: the only other reader
  is the read guard itself, and the other writer (`events.py:1147`) is behind
  `unread_count > 0`. Critically, the gateway call in `messaging.py:283-287`
  happens **before** the `if` at line 301, so a read is always forwarded to the
  provider — the guard only skips a redundant local write. No regression.

- **Extraction equivalence.** `applyConversationEvent` is asserted equal to the
  pre-extraction implementation on all four real backend payloads
  (`§P6.2: the extracted merge agrees with the pre-extraction implementation`),
  plus a check that it keeps the known name when the payload carries none.

- **Temp-dir pollution fixed.** The harnesses built into `frontend/.tmp-*`, so
  crashed or killed runs left **25 untracked directories** in the working tree
  (ready to be committed). Both now build into `os.tmpdir()` with
  `absWorkingDir` + `nodePaths` so esbuild still resolves the workspace
  `node_modules`, and React is bundled rather than externalised so the output is
  position-independent. Leftovers deleted; two fresh runs leave zero.
  The DOM harness is deterministic: 3 runs produce byte-identical output.

- **P6-4 found by checking an assumption.** My §7 DOM test had passed a `key`
  to `ChatThread`, so it never exercised how the hub page actually renders it.
  Checking the real call site showed there is no key.
- **Instrument-lag exposed a vacuous assertion.** Moving the box model onto the
  prototype (so it exists at element creation, not after `act`) revealed that
  `no auto-scroll expected yet` had been passing only because the stub could
  not see a container that had not been instrumented yet. It now asserts the
  real behaviour: mount scrolls to the bottom once.
