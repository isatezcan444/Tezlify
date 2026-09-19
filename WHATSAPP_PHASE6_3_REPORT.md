# TEZLIFY WHATSAPP — PHASE 6.3
## Canonical Message Reconciliation + Real Browser Verification

No production deploy. No production DB write. No message sent to a real third party.

---

## 1. CONFIRMED BUGS

### P6-6 — the live WebSocket merge could leave a sent message rendered twice

**ID:** P6-6 · **STATUS:** FIXED · **Severity:** high (visible duplicate of your own message)

**USER IMPACT**
Send a message. Your own bubble can appear **twice**: one copy advancing to
`DELIVERED`, one stuck at `SENT`. Both rows carry the same `id`, so React also
sees duplicate keys. It persists until the thread is reloaded from the server.

**REPRODUCTION**
`npm run verify:merge-equivalence` (with the pre-fix inline block) →
`late identity link` row.

**ROOT CAUSE**
Two implementations of one job. `mergeWhatsAppMessages`
(`lib/whatsappMessageMerge.ts`, used by refresh / reconnect / sync-chunk /
pagination) keys by `id:` / `wa:` / `client:` **and can collapse two slots** when
a later event links both identities — the code comments it: *"a provider echo
and optimistic row may predate the event linking both IDs."*

The live WS path used its own inline `findIndex` over three OR'd keys
(`WhatsAppHubPage.tsx:1162-1187`). It cannot join two slots. Given:

```
optimistic : client_message_id = C1
echo       : client_message_id = null, wa_message_id = W1   (no shared key yet)
later      : client_message_id = C1, wa_message_id = W1     (identity completed)
```

the later event matches the **optimistic** row by `C1` and updates it, leaving
the **echo** row orphaned:

```
live      : [{id:1, wa:W1, client:C1, DELIVERED}, {id:1, wa:W1, client:null, SENT}]
canonical : [{id:1, wa:W1, client:C1, DELIVERED}]
```

**FIX**
One canonical merge. The live WS path now calls
`mergeWhatsAppMessages(prev[convId] || [], [newMsg])`; the inline block is gone.

**FAIL PROOF**
`AssertionError: the live WS path still diverges from the canonical helper on:
late identity link` (1 of 10 rows divergent).

**PASS PROOF**
10/10 rows agree; `Live WS merge == canonical merge: PASS (mode=canonical)`.

---

### P6-7 — opening a conversation fired an older-page fetch and knocked the viewport off the newest message

**ID:** P6-7 · **STATUS:** FIXED · **Severity:** high (every conversation open; defeats P6-4 in a real browser)

**USER IMPACT**
Open or switch to a chat. The thread requests an older history page that nobody
asked for — a wasted backend + gateway round trip on **every** open — and the
resulting prepend-restore can leave you **mid-history instead of at the newest
message**. This silently undid P6-4 in production, where P6-4 was verified only
under jsdom.

**REPRODUCTION**
`npm run verify:browser` → `G: opening a conversation must not fetch an older page`.
Measured: **1 older-page request on mount, with no user scroll**.

**ROOT CAUSE**
`ChatThread`'s initial scroll used `scrollIntoView({ behavior: 'auto' })`.
`behavior: 'auto'` **defers to CSS**, and the container carries Tailwind's
`scroll-smooth`. So the "instant" jump to the newest message was actually
animated from `scrollTop = 0` upward — sweeping straight through the
pagination trigger (`scrollTop < 60 && hasMore`) in `handleScroll`.

jsdom cannot see this: it has no `scrollIntoView` and no layout, so the initial
scroll never moved and never crossed the trigger.

**FIX** (two parts, both minimal)
1. `scrollIntoView({ behavior: 'instant' })` — forces a real jump, ignoring CSS.
   Opening a chat should not animate through the whole history; this is also
   what WhatsApp Web does.
2. `initialScrollDoneRef` guards `handleLoadOlder`: pagination cannot fire
   before the thread has taken its initial position.

**FAIL PROOF**
`mounting a chat fired 1 older-page request(s) with no user scroll`
(whole suite: 5 passed, 2 failed).

**PASS PROOF**
7/7 browser checks, including `A: switching conversations lands on the newest
message` — which failed before the fix and passes after.

---

## 2. MESSAGE MERGE EQUIVALENCE (§4)

Same event sequences, both implementations. `ROWS` = rows in the final list.

| Event | Old live WS | Canonical helper | Expected | Result |
|---|---|---|---|---|
| optimistic + echo | 1 | 1 | 1 | agreed |
| same `client_message_id`, no `wa_message_id` | 1 | 1 | 1 | agreed |
| **late identity link** | **2 (duplicate)** | 1 | 1 | **DIVERGED → fixed** |
| status update | 1 | 1 | 1 | agreed |
| same `wa_message_id`, different db id | 1 | 1 | 1 | agreed |
| duplicate event (replay) | 1 | 1 | 1 | agreed |
| missing wa id | 1 | 1 | 1 | agreed |
| missing client id (echo has wa only) | 2 | 2 | 2 | agreed — no event yet carries both keys, so neither can link |
| status update without body | 1, body `''` | 1, body `''` | 1 | agreed — see latent risks |
| inbound then outbound ordering | 2 | 2 | 2 | agreed |

Post-fix, all 10 rows are locked as explicit expectations, so the canonical
behaviour itself is now regression-protected.

**Performance (§5).** 500-message thread + 200 live events → **80.1 ms total
(~0.4 ms/event)**, 700 rows. No accidental O(n²); the helper rebuilds the array
per event, which the old append path also did (`sort`). Guarded by an assertion
at 2000 ms. Correctness first — no premature optimisation applied.

**`npm run verify:merge` now really runs.** It was passing but wired to no npm
script (found in 6.2); registered, and `verify:merge-equivalence` added.

---

## 3. BROWSER RESULTS (§10)

Real Google Chrome 153, driven over CDP with Node's built-in WebSocket. No
framework installed into the repo. The harness renders the **real**
`ChatThread` / `ChatComposer` / `I18nProvider`, served from a local static
server, using the **real built Tailwind CSS** (without it `flex-1` and
`overflow-y-auto` are inert and the thread never becomes scrollable).

| # | Scenario | Result |
|---|---|---|
| A | open A, scroll up, open B → B at newest message | **PASS** |
| B | open A, type draft, open B → B composer empty | **PASS** |
| C | at the bottom, inject inbound → visible, no false pill | **PASS** |
| D | reading history, inject inbound → viewport preserved, pill raised | **PASS** |
| E | load older → viewport compensated by the prepended height | **PASS** |
| F | switch remounts the thread; an update in the same chat does not | **PASS** |
| G | opening a chat must not fetch an older page | **PASS (after P6-7 fix)** |

**7 passed, 0 failed.** No real message was sent; no production system touched.

**Determinism.** Run three times: 7 passed each time, output byte-identical.
Browser tests are timing-sensitive, so this matters as much as the pass itself.

---

## 4. JSDOM VS BROWSER MATRIX (§12)

| Behaviour | jsdom | Browser | Authoritative |
|---|---|---|---|
| conversation switch | PASS (20 checks) | PASS | browser — agrees |
| draft isolation | PASS | PASS | browser — agrees |
| active inbound | PASS | PASS | browser — agrees |
| new-message pill | PASS | PASS | browser — agrees |
| scroll anchor / older prepend | PASS (simulated box model) | PASS (real layout) | browser — agrees |
| **initial-scroll pagination (P6-7)** | **not detectable** | **FAIL → fixed** | **browser** |

The one behaviour where they differ is exactly the one jsdom structurally
cannot model: jsdom has no `scrollIntoView` and no smooth-scroll animation, so
P6-7 was invisible to it. Everything jsdom claimed, the browser confirmed.

---

## 5. P6-2 / P6-4 / P6-5 REGRESSIONS (§7–§9)

**P6-5 — wrong-recipient draft.**
- `composer-isolation: switching conversations must not carry the draft over` — PASS
- `composer-isolation: an unkeyed composer really does leak the draft` (broken variant rejected) — PASS
- **new** `composer-persistence: an update in the same chat keeps the draft and delivers it` — the composer is not remounted by a same-conversation update and the draft is delivered to the chat it was typed in — PASS
- **new** `composer-send: after a switch, only the newly typed text is sent` — `sent == ['B icin mesaj']`, never A's — PASS
- Browser B — PASS

**P6-4 — switch viewport / reorder.**
- **new** `conversation-switch-and-reorder: switch remounts, reorder does not` — one test covering both: after a switch the thread is a new DOM node and sits at the newest message; after a reorder it is the *same* node — PASS
- `conversation-switch: opening another chat lands on the newest message` — PASS
- `conversation-list: new activity reorders to the top without remounting the active chat` — PASS
- Browser A and F — PASS

**P6-2 — unread semantics.**
- External read `8 → 0 → stale same-ts 8 ⇒ 0` — PASS (`test_scenario_i_external_read_survives_same_timestamp_snapshot`)
- **new** Legitimate equal-timestamp increase `0 → 5 ⇒ 5` — PASS (`test_scenario_i_legitimate_equal_timestamp_increase_still_applies`, falsified to prove teeth: `assert 0 == 5`)
- Genuine new activity `0 → new message T5 ⇒ 1` — PASS (same scenario I test)

*Note on case 2:* at one identical timestamp, "8" (stale echo) and "5"
(legitimate report) are **indistinguishable by value and timestamp**. The
discriminator is read evidence: P6-2 stamps `last_read_at` on an authoritative
drop to 0, so afterwards an equal-ts raise is correctly blocked. Case 2 is only
meaningful with no read on record — which is what the new test pins. The
docstring records this explicitly so nobody "fixes" it into a blanket ban.

---

## 6. SECONDARY STATE SWEEP (§13)

| Component | State | Belongs to | Protected by |
|---|---|---|---|
| ChatThread | scroll position, `isNearBottom`, pill, prepend/restore refs, newest-key ref | conversation | `key={selectedConv.id}` (P6-4) |
| ChatComposer | `text` (draft), `sending`, `isAttachMenuOpen`, `mediaModalType`, `mediaUrl`, `mediaCaption` | conversation | `key={selectedConv.id}` (P6-5) |
| TemplateSelectModal | `selectedKey`, `variables` | conversation *in effect* | re-initialised by the `isOpen` effect (`initVariables(tmpl, leadName)`, deps `[isOpen, leadName]`) — safe **without** a key |
| TemplateSelectModal | `templates`, `loading` | global (catalog) | correctly global |

**No new bug.** Template variable values are the one state here that could carry
a recipient's name to the wrong person, and the open-effect resets them every
time the modal opens and whenever `leadName` changes.

---

## 7. LATENT RISKS

Only what genuinely remains.

1. **An event with no text blanks the body.** Both merge paths spread the
   incoming message, so a `message_status_updated` reaching the new-message
   block with no `body` would set `body: ''`. Not a divergence, and the live
   status-update path is separate (`WhatsAppHubPage.tsx:1201`), so it is not
   currently reachable. Locked in the matrix as a documented expectation.
2. **Two merge entry points still exist in the file.** The canonical helper is
   now used everywhere, but `mergeDeliveryStatus` is still called directly at
   `:1230`. That is status-only and correct; unifying it is cosmetic.
3. **Chrome `--no-sandbox`.** The browser harness needs it because Chrome's own
   sandbox cannot initialise inside this environment. Standard for CI; the page
   is a local fixture, but it is a flag worth knowing about before wiring this
   into a pipeline.
4. **The browser harness depends on `dist/assets/*.css`.** Run `npm run build`
   first, or it falls back to a minimal layout shim and the thread will not be
   scrollable.
5. **Unchanged from 6.2:** production is at `f6ec68d` with all Phase 3–6 work
   still uncommitted locally; P5-1 needs one live media send; `jsdom` is a new
   devDependency for review.
6. **Repo hygiene found while preparing the commit.** Seven
   `frontend/vite.config.ts.timestamp-*.mjs` files — Vite's own transpiles of
   the config, left behind by interrupted runs — were untracked and **not**
   gitignored, so they would have been committed. Deleted, and the pattern added
   to `.gitignore`.

---

## 8. TEST GATES

| Gate | Result |
|---|---|
| Backend `pytest backend/tests -q` | **1081 passed** (was 1080; +1 P6-2 case-2 test) |
| Gateway `test-*.mjs` | **19/19** |
| `npx tsc --noEmit` | **0** |
| `npm run build` | **success** (1630 modules) |
| `npm run verify:logic` | **43 checks PASS** |
| `npm run verify:dom` | **20 checks PASS** (was 17; +3 regressions) |
| `npm run verify:merge` | **PASS** |
| `npm run verify:merge-equivalence` *(new)* | **PASS** (10 rows, canonical) |
| `npm run verify:browser` *(new)* | **7/7 PASS** |
| `git diff --check` | **clean** |

---

## 9. RELEASE CRITERIA (§17)

- **live WS merge == canonical merge** — YES, 10/10 rows, fail→pass proven.
- **P6-5 wrong-recipient regression PASS** — YES (jsdom + browser).
- **P6-4 switch viewport PASS** — YES (jsdom + browser).
- **P6-2 unread PASS** — YES (all three cases).
- **Critical 5 scenarios PASS in a real browser** — YES (A–E, plus F and G).

New confirmed bugs were found and fixed (P6-6, P6-7). **No unfixed confirmed bug
remains.**

**Not yet done, deliberately:** no commit, no review, no deploy.
