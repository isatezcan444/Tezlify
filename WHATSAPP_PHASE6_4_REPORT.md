# TEZLIFY WHATSAPP — PHASE 6.4 REPORT
## QR Pairing + Phone Pairing Code, End to End

Scope: **"QR ile Bağla" çalışmıyor ve "Telefon Kodu ile Bağlan" da çalışmıyor.**
Nothing else. No deploy, no production DB write, no message sent to any third party.

```
LIVE DEVICE E2E = NOT RUN
```

No real phone was ever paired. Every claim below is either (a) executed against the
real code with only the network boundary faked, or (b) explicitly marked as not run.
Where a proof could not be executed, this report says so rather than implying success.

---

## 1. Verdicts

| ID | Claim | Verdict |
|---|---|---|
| **P6-8** | Phone pairing code is unreachable for a NEW pairing — "Kod Al" is a silent no-op | **CONFIRMED BUG — FIXED** |
| **P6-9** | The backend drops `session_qr_updated` for a new (ephemeral) pairing | **CONFIRMED BUG — FIXED** |
| Gateway QR path | The gateway fails to produce/forward a QR | **NOT A BUG** — proven healthy A1→A12 |

**P6-9 is reported as `CONFIRMED BUG`** (not `NOT A BUG`, not `UNRESOLVED / INCONCLUSIVE`).

---

## 2. Is the gateway QR path healthy? — NOT A BUG

Executed with a **real `SessionManager`** (real QR encoding, real file auth store, real
socket-lifecycle generation guard). The only replacement is `makeWASocket` — the single
call that opens a WebSocket to WhatsApp.

`whatsapp-gateway/scripts/repro-pairing.mjs`, stages A1→A12:

```
session created -> socket opened -> QR handled -> session_qr_updated emitted
  with a real `data:image/png;base64` URI -> CONNECTING -> CONNECTED
  -> qr cleared -> ephemeral promoted
```

The QR that reaches the backend is genuine `qrcode` output, not a stub string. **No defect
was found on this path.** The user-visible "QR ile Bağla çalışmıyor" is fully explained by
P6-9 below (QR produced but never delivered) and, for the code tab, by P6-8.

---

## 3. P6-8 — CONFIRMED BUG, FIXED

### Root cause

`/sessions/{id}/pair` requires a **numeric session id**. A first-time pairing has none —
that is the entire point of the ephemeral lifecycle: **zero rows in
`public.whatsapp_sessions` until the QR is scanned and the connection opens.**

The UI therefore did:

```js
if (!targetSessionId) { await initSession(); if (!activeSessionIdRef.current) return; }
```

…and returned **before setting any loading or error state**. Clicking "Kod Al" was a
silent no-op that additionally fired a **second** `startPairing`.

### Fix

`POST /api/v1/whatsapp/pairing/{pair_token}/pair` — the same gateway `requestPairingCode`
call, addressed by the ephemeral pairing's gateway session. Same lifecycle as QR pairing;
promotion still happens on `connection.open`. **No second session system is introduced.**

Files: `backend/app/api/v1/endpoints/whatsapp.py`,
`backend/app/services/whatsapp/orchestration/sessions.py` (`request_pairing_code_for_token`),
`backend/app/services/whatsapp_service.py`,
`frontend/src/features/whatsapp/api/whatsappApi.ts`,
`frontend/src/features/whatsapp/data/whatsappRepository.ts`,
`frontend/src/features/whatsapp/components/WhatsAppQrConnectModal.tsx`.

### Falsification (§24) — the test has teeth

| Break | Result |
|---|---|
| Endpoint removed | backend: **2 failed** |
| Restored | backend: **8 passed** |
| Modal reverted to the pre-P6-8 `if (!sid) … return` | jsdom: **FAIL**; real Chrome: **FAIL** |
| Restored | jsdom: **7/7**; real Chrome: **7/7** |

---

## 4. P6-9 — CONFIRMED BUG, FIXED

### The four candidate cases (§6)

| Case | Meaning |
|---|---|
| **A** | Gateway emitted, backend rejected → **matches** |
| B | Gateway never emitted |
| C | Event emitted and accepted, frontend dropped it |
| D | Delivered but rendered wrong |

### Evidence

`_map_session_event` resolves the event owner from a **DB row**. A new pairing has none.
The relink branch fires only for `session_connected`. So `session_qr_updated` for an
ephemeral pairing reached `EventOwnerUnresolved` → `ingest_gateway_event` returned `None`
→ `main.py` counted it **`skipped`** and never broadcast it.

Cases B, C and D are excluded: the gateway demonstrably emits the event (§2), and the
frontend renders any `session_qr_updated` it receives (proved in jsdom and in Chrome).

> **Self-correction recorded.** An earlier draft called P6-9 CONFIRMED on a test whose
> `event_id` was `"evt-p69-<uuid>"`. `ingest_gateway_event` parses `event_id` with
> `uuid.UUID(...)` and returns `None` for a non-UUID **silently** — so the early `None`
> looked exactly like "the backend dropped the QR". With a real UUID the correct defect
> reproduced. §5's "do not overclaim" was justified.

### Fix — owner association, NOT a global broadcast (§7)

`events.py` now resolves the tenant from the ephemeral registry the pairing was started
in, **before** the final `EventOwnerUnresolved`:

```python
eph = find_ephemeral_pairing_by_gateway_id(str(gw_session_id))
if eph and eph.get("user_id"):
    event["user_id"] = str(eph["user_id"])
    ...
    return event
```

A global broadcast was explicitly rejected: it would regress **G-3 tenant isolation** by
showing every tenant every new pairing's QR.

### Tenant safety test (§8)

A's QR resolves to A; B's QR resolves to B; a cross-tenant `pair_token` returns **404
without ever calling the gateway**. Falsified by replacing the owner-scoped lookup with a
global one → **FAIL**; restored → **PASS**.

---

## 5. §9 Phone normalization — verified

`normalizePairingPhone` (gateway) is correct and is the **only** normalizer. React forwards
the **raw** input.

| Input | Canonical |
|---|---|
| `+905413749073` | `905413749073` |
| `905413749073` | `905413749073` |
| `00905413749073` | `905413749073` |
| `05413749073` | `905413749073` |
| `+1 512 345 6789` | `15123456789` (not rewritten to +90) |
| `005512345678` | `5512345678` (Brazil, not +90) |

`verify-whatsapp-logic.mjs` now asserts `rawPhone` is forwarded on **both** routes
(token and numeric-id). When my two-branch call broke the original source regex I
strengthened the check rather than weakening it.

---

## 6. §11 Persistence / restart — a real cold-start cycle

Not faked. The fake socket's `completePairing()` reproduces Baileys' one non-event side
effect: mutating `auth.creds` in place (`me`, `registered = true`) before emitting
`creds.update` + `connection.open`. Without it a "restart" test would assert on
credentials that were never registered and prove nothing.

```
ok - §11 pairing completes and clears the QR
ok - §11 the completed pairing persists registered credentials to the auth store
ok - §11 a cold restart restores the registered credentials from disk
ok - §11 a cold restart reconnects without a second QR
```

A brand-new manager instance (empty in-memory session map) over the same on-disk auth
store reloads `registered: true` + the same identity, reconnects, and **emits zero
`session_qr_updated` events**.

**Falsification:** pointing the restarted manager at a fresh directory →
`restart must load registered creds` **FAILS**. The check is not vacuous.

---

## 7. §12 Single-flight

WhatsApp invalidates the previously issued code on every new `requestPairingCode`, so
concurrent requests leave the user holding a dead code.

- **Gateway:** `pairingCodeInFlight` map. 3 concurrent requests → **1** provider call, no
  extra socket; a deliberate retry after settle still issues a fresh code.
- **Frontend:** `pairingInFlightRef` — `disabled={isPairingLoading}` is not enough, React
  has not re-rendered when the second click lands. 3 rapid clicks → **1** request.
- **Backend:** concurrency-safe (every caller answered, every call addressed to its own
  gateway session). Provider-side dedupe deliberately lives in the gateway, where the
  provider call is made.

**Falsification (§15):**

| Break | Result |
|---|---|
| Gateway guard disabled (`if (false && …)`) | `one provider request expected, got 3` — **FAIL** |
| Frontend guard disabled | 3 clicks → 3 requests — **FAIL** |
| Backend resolves a wrong gateway id | **2 failed** |
| All restored | 9/9 gateway, 7/7 jsdom, 8/8 backend |

---

## 8. §13 Real browser (Chrome + CDP, no new framework)

Reuses the Phase 6.3 harness — installed Chrome driven over the DevTools Protocol with
Node's built-in WebSocket, the **real built CSS** from `dist/assets`.

```
ok - A: a new pairing paints a real QR once the gateway produces one
ok - A: a rotated QR replaces the old one in the browser
ok - A: CONNECTED clears the QR and dismisses the modal
ok - B: "Kod Al" for a NEW pairing shows all 8 digits
ok - B: the code digits are actually painted wide enough to read
ok - B: after the phone links, the modal reaches CONNECTED and dismisses
ok - C: a gateway failure shows the real error and leaves a retry
```

These assert **painting**, not just DOM presence: the QR box has real width/height and the
PNG actually decodes (`naturalWidth`); each code cell is laid out ≥20px. jsdom cannot see
either.

---

## 9. §16 Gate set — all green

| Gate | Result |
|---|---|
| `pytest backend/tests -q` | **1089 passed, 0 failed** |
| Gateway `node scripts/test-*.mjs` | **20/20 suites**, incl. `test-pairing-lifecycle` **9 checks** |
| `npx tsc --noEmit` | **exit 0** |
| `npm run build` | **exit 0** |
| `verify:logic` | **43 checks** |
| `verify:dom` | **20 checks** |
| `verify:pairing` (new, jsdom) | **7 checks** |
| `verify:pairing-browser` (new, Chrome) | **7 checks** |
| `verify:browser` | **7/7** |
| `verify:merge` / `verify:merge-equivalence` | **PASS** / **PASS** |

New gates added to `frontend/package.json`: `verify:pairing`, `verify:pairing-browser`.

---

## 10. Honest limits

1. **`LIVE DEVICE E2E = NOT RUN`.** No real phone was paired. The WhatsApp network boundary
   (`makeWASocket`) is faked throughout. Provider-side behaviour — real QR rotation timing,
   real pairing-code expiry, real `connection.open` after a genuine scan — is **not**
   verified by execution.
2. **No production verification.** Production is still on `f6ec68d` and does not contain
   any Phase 6.4 change. Per instruction: not deployed, no production DB write.
3. **`requestPairingCode` timing (§10)** was verified by reading the installed Baileys
   source, not by observing a live provider call.
4. **Ephemeral registry is in-memory.** A backend restart mid-pairing loses the registry, so
   an in-flight pairing cannot be resolved afterwards. Pre-existing by design (Phase 13.1);
   unchanged here.
5. `jsdom` remains a devDependency added in Phase 6.2 — deliberate, still awaiting review.

---

## 11. Changed files

**Product code**
- `backend/app/api/v1/endpoints/whatsapp.py` — `POST /pairing/{pair_token}/pair`
- `backend/app/services/whatsapp/orchestration/sessions.py` — `request_pairing_code_for_token`, `pair_token` on the registry record
- `backend/app/services/whatsapp/orchestration/events.py` — P6-9 owner resolution
- `backend/app/services/whatsapp_service.py` — export
- `whatsapp-gateway/src/session-manager.js` — §12 single-flight
- `frontend/src/features/whatsapp/api/whatsappApi.ts`
- `frontend/src/features/whatsapp/data/whatsappRepository.ts`
- `frontend/src/features/whatsapp/components/WhatsAppQrConnectModal.tsx` — P6-8 + §12

**Tests / harnesses**
- `backend/tests/test_whatsapp_phase6_4_pairing.py` (new, 8 tests)
- `whatsapp-gateway/scripts/test-pairing-lifecycle.mjs` (new, 9 checks)
- `frontend/scripts/verify-whatsapp-pairing-browser.mjs` (new, 7 Chrome checks)
- `frontend/scripts/verify-whatsapp-pairing.mjs`, `verify-whatsapp-logic.mjs`,
  `whatsapp-gateway/scripts/pairing-harness.mjs`, `fake-baileys.mjs`
- `frontend/package.json` — two new gates

**Not committed, not pushed** (§18). Working tree only; `ba8d527` remains HEAD.
