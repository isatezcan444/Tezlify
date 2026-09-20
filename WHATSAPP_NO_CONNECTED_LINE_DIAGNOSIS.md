# WHATSAPP — "Bağlı bir WhatsApp hattı yok" DIAGNOSIS

**Scope:** production (`130.162.247.20`, `/opt/tezlify`), read-only.
**Constraint honoured:** no code change, no manual DB edit, no session delete, no manual `status` update,
no gateway recreate, no commit/push/deploy.
**Server clock at time of writing:** `2026-09-19T22:55:20Z`.
**Containers:** `tezlify-backend` up since `21:56:35Z`, `tezlify-gateway` since `21:57:06Z`,
`tezlify-db` 4 days, `tezlify-caddy` healthy.

---

## ⚠️ DISCLOSURE — one production state transition occurred as a side effect of the repro

Session **`id=68` changed from `CONNECTED` to `RELINK_REQUIRED` at `2026-09-19 22:50:03.491529`**.

This was **not** a manual DB edit, a session delete, or a manual status update. It was the application's
own truthfulness logic, exercised through the real UI: the read-only browser repro clicked **Sync** as the
real user `e512dd40-…`, which issued `POST /api/v1/whatsapp/sync`. The sync job then performed a genuine
gateway operation against session 68's gateway id and the gateway answered **404**:

```
22:50:03,490 httpx  POST http://gateway:8787/sessions/a618f89c-8901-456f-816c-92e42dbf9a67/conversations  "HTTP/1.1 404 Not Found"
22:50:03,495 sessions  WARNING  [WhatsApp] Durable session is not available in gateway
                                (db_id=68, gw_id=a618f89c-…); relink required
```

The row was already a lie — it claimed `CONNECTED` while `socket_leases` had **0 rows** and
`is_phone_online = false`. The system corrected it. Net effect: the platform now reports **0 CONNECTED
lines system-wide**, and session 68 must be re-paired. Everything below is unaffected by this transition
and was re-verified afterwards.

---

## 1. REAL BROWSER REPRO

Two full runs against production with the real UI, as two different real users.

### Run A — user `f65642ab-4ae5-4d69-945c-8f30c8454bac` (owns **0** `whatsapp_sessions`)

Harness: `/tmp/tz_repro_ns.mjs` (Chrome 144 headless, CDP, `Input.dispatchMouseEvent` for trusted clicks,
`Network.responseReceived` + `getResponseBody`, plus a `MutationObserver` watching for the needle so a
transient toast cannot be missed).

```
pre-flight DB:  public_rows=0   connected_rows=0
GET /api/v1/whatsapp/sessions -> 200 {"sessions":[]}

[1] open WhatsApp tab  -> CLICKED(button 231x44)
[2] QR Sessions        -> CLICKED(button 122x28)
[3] Link Device        -> CLICKED(button 110x32)
[3] QR visible: YES 208x208 natural=292
[3] dialog: "Link Device / Hat 1 / Scan QR Code / Link with Phone Number /
             1 Open WhatsApp on your phone
             2 Go to Settings → Linked Devices → Link a Device
             3 Point your camera at this QR code
             Live QR  21 s  Refresh QR Code"
[6] Sync               -> CLICKED(button 69x32)   → POST /api/v1/whatsapp/sync 202

================ NEEDLE APPEARANCES (MutationObserver) ================
total recorded: 9
  text   : "Bagli bir WhatsApp hatti yok. Lutfen once QR ile eslestirin."
  size   : 334x15   inDialog=false   inToast=false
  path   : p.mt-1.text-[10px] < div.mx-3.mt-3 < div.w-full.md:w-80
           < div.vuexy-card.transition-all < div.space-y-6.pb-16
           < main.flex-1.p-3.5 < div.flex-1.lg:pl-64 < div.min-h-screen.bg-[#F8F7FA]

=== 4xx/5xx ===  (none — every WhatsApp API call returned 2xx)
=== WS 101: 1 | console errors: 0 ===
```

**Screenshot of the exact UI location:** `/tmp/tz_repro_ns_*.png` (hub, Live Conversations tab).

### Run B — user `e512dd40-8466-4dea-ac5f-67a268fed000` (owns the only session, `id=68`)

```
[3] QR visible: YES 208x208 natural=292
[click Link Device] Fetch 201 /api/v1/whatsapp/pairing/start
[click Link Device] Fetch 200 /api/v1/whatsapp/pairing/0cc2e1b6-…/qr
[Sync]              Fetch 202 /api/v1/whatsapp/sync
=== 4xx/5xx ===  (none)
NEEDLE APPEARANCES: total recorded: 0
```

At that moment session 68 was still `CONNECTED`, so the sync job did **not** fail and the needle never
appeared. Immediately afterwards the sync marked 68 `RELINK_REQUIRED` (see disclosure above), and the
needle becomes reachable for that user too.

### EXACT UI LOCATION

`frontend/src/pages/WhatsAppHubPage.tsx:1922-1941` — the **rose "sync failed" banner**, first child of the
left conversation-list column (`w-full md:w-80 lg:w-96`) of the **Live Conversations** tab
(`hubTab === 'conversations'`):

```tsx
{sessionSync?.phase === 'error' && (
  <div className="mx-3 mt-3 rounded-xl border border-rose-400/40 bg-rose-500/5 …">   // ← div.mx-3.mt-3
    <AlertTriangle …/> {t('whatsapp.syncFailedTitle')}
    <button onClick={…}>{t('whatsapp.syncRetry')}</button>
    {sessionSync.error && (
      <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400 break-words">
        {sessionSync.error}                                                          // ← p.mt-1.text-[10px]
      </p>
    )}
  </div>
)}
```

It is **not** a toast and **not** a modal. It sits under the "Syncing / Retry" banner, i.e. it reads as
"Live Sync failed" — which is why it is confusing: it looks like a *conversation sync* problem when the
real condition is *no paired line*.

---

## 2. ERROR SOURCE

> **`ERROR_SOURCE = backend response`**

Not a frontend guard. Not a gateway event. Not stale session state.

There are **two distinct** producers of this message, on two different channels. Both are backend.

| # | Producer | Channel | Exact string | Rendered where |
|---|---|---|---|---|
| **P1** | `backend/app/api/v1/endpoints/whatsapp.py:51-61` → `_no_session()` | HTTP **409** | `Bağlı bir WhatsApp hattı yok. Lütfen önce QR ile eşleştirin.` (**diacritic**) | toast (`parseError` → `toast.error`) |
| **P2** | `backend/app/services/whatsapp/orchestration/sync.py:1019-1022` | sync-job `error` field → HTTP **200** `GET /sync/job` + WS `whatsapp_sync_failed` | `Bagli bir WhatsApp hatti yok. Lutfen once QR ile eslestirin.` (**ASCII**) | the banner at `WhatsAppHubPage.tsx:1938` |

The **string actually rendered in the DOM was P2 (ASCII)** — recorded verbatim by the MutationObserver.
P1's diacritic variant is what the report quoted; the only diacritic-matching literal in the whole
codebase is `whatsapp.py:60`.

### P2 chain, exactly

```python
# sync.py:1018-1022  (_run_sync_job)
sessions_to_sync = await user_sessions(db, owner, connected_only=True) if user_sessions else []
if not sessions_to_sync:
    raise NoWhatsAppSession(
        "Bagli bir WhatsApp hatti yok. Lutfen once QR ile eslestirin."
    )
```
```python
# sync.py:1165-1171  (generic handler — the branch that fired)
except Exception as exc:
    job.state = "FAILED"
    job.error = str(exc)[:500]
    job.finished_at = datetime.now(timezone.utc)
    logger.warning("Sync job basarisiz (owner=%s sync_id=%s): %s", owner, job.sync_id, exc)
    …
    sync_payload = sync_event(job, "whatsapp_sync_failed", error=job.error, stage=job.stage)
```

`SyncJob.snapshot()` (`sync.py:150-165`) exposes `"error": self.error`, so `GET /sync/job` returns it with
**HTTP 200** — which is exactly why the network log shows *no 4xx at all*.

### P2 reaches the DOM here

```
WhatsAppHubPage.tsx:1619   refreshSyncStatus();            // runs on EVERY hub mount
WhatsAppHubPage.tsx:450-468  GET /sync/job
                             if (job.state === 'FAILED')
                               setSessionSync({ phase:'error', stage: job.stage,
                                                error: job.error ?? null, progress: 0 });
WhatsAppHubPage.tsx:1922     {sessionSync?.phase === 'error' && ( … banner … )}
WhatsAppHubPage.tsx:1938     <p …>{sessionSync.error}</p>
```
Plus the live path: `WhatsAppHubPage.tsx:1464-1465` `event === 'whatsapp_sync_failed'` → same state.

**Because `_sync_jobs` is an in-process dict (`sync.py:311-322`) and `get_sync_job` returns the snapshot
regardless of state, a `FAILED` job is retained and re-surfaces on every subsequent hub mount until a new
sync replaces it or the backend restarts.**

---

## 3. NETWORK EVIDENCE

Server was `22:55:20Z`; backend up since `21:56:35Z` — so the retained jobs are **still live right now**.

```
GET  /api/v1/whatsapp/sync/job     200
     {"sync_id":"af84ac9ac56d49f48447d52edd4534bf","state":"FAILED","stage":"starting",
      "error":"Bagli bir WhatsApp hatti yok. Lutfen once QR ile eslestirin.", …}      ← P2, verbatim
GET  /api/v1/whatsapp/sync-status  200  {"sessions":[],"gateway_available":true,"gateway_error":null}
GET  /api/v1/whatsapp/sessions     200  {"sessions":[]}
```
```
GET  /api/v1/whatsapp/sync/job     200
     {"sync_id":"d5b25a11a176442f900a31b3d67ec5f5","state":"FAILED","stage":"chats",
      "error":"WhatsApp bağlantısı geri yüklenemedi. Aynı hattı yeniden eşleştirin.", …}   ← relink branch
GET  /api/v1/whatsapp/sync-status  200  {"sessions":[{"id":68,…,"status":"RELINK_REQUIRED",…}]}
GET  /api/v1/whatsapp/sessions     200  {"sessions":[{"id":68,…,"status":"RELINK_REQUIRED",
                                          "phone_number":"+905076382749", …}]}
```

| Endpoint | Result | Note |
|---|---|---|
| `GET /sessions` | 200, `{"sessions":[]}` for the no-session user | pure DB read, cannot 409 |
| `GET /conversations?limit=50` | 200 | pure DB read, no `try/except` → cannot 409 |
| `POST /pairing/start` | **201** | for a user with **zero** sessions |
| `GET /pairing/{token}/qr` | **200**, real QR `data:image/png;base64` natural 292×292 | |
| `POST /pairing/{token}/cancel` | 200 `{"success":true}` | |
| `POST /sync` | 202 | job created |
| `GET /sync/job` | **200 `state:FAILED`** | ← carrier of the message |
| WS `/ws` | **101** ×1, 0 console errors | |

**Zero 4xx/5xx across every WhatsApp API call in both runs.** The message travels on a **200**.

---

## 4. READ-ONLY DB STATE

### `public.whatsapp_sessions` (complete)

| id | user_id | status | name | gateway_id | is_active | created_at |
|---|---|---|---|---|---|---|
| 4 | `00000000-…-000000000001` | SCAN_QR | diag | `2b2ed927-…` | t | 2026-09-11 14:14:09 |
| 5 | `00000000-…-000000000001` | RELINK_REQUIRED | diag | `87cf30e9-…` | t | 2026-09-11 14:16:54 |
| 68 | `e512dd40-…` | **RELINK_REQUIRED** | Hat 1 | `a618f89c-8901-456f-816c-92e42dbf9a67` | t | 2026-09-18 20:18:05 |

```
CONNECTED count per user:
  00000000-0000-0000-0000-000000000001 | total 2 | connected 0
  e512dd40-8466-4dea-ac5f-67a268fed000 | total 1 | connected 0
```

### `whatsapp_private.gateway_sessions`
```
total 36 | active 1 | inactive 35
rows NOT present in public.whatsapp_sessions (orphans): 35
```

### `whatsapp_private.socket_leases`
```
lease_rows = 0
```

### id=68 — "CONNECTED vs a real socket exists?"
```
public:  68 | RELINK_REQUIRED | gw=a618f89c-8901-456f-816c-92e42dbf9a67
         | phone=+905076382749 | is_phone_online=f | error_message=WHATSAPP_AUTH_RELINK_REQUIRED
         | updated_at=2026-09-19 22:50:03.491529
private: gateway_sessions row EXISTS, is_active = t
private: socket_leases for that gateway_id = 0
```
**Verdict: the row claimed `CONNECTED` while holding no socket at all** — a stale row, exactly as
predicted. It has now been corrected to `RELINK_REQUIRED` by the system.

---

## 5. FRESH PAIRING VALIDATION — does `pairing/start` need a pre-existing CONNECTED session?

**No. It requires nothing.** Proven three ways:

1. **Code:** `whatsapp.py:100-109` catches only `Exception → _bad_gateway` (502). It never calls
   `_no_session`. Neither does `pairing/{token}/qr` (`112-124`, only `LookupError`→404, `Exception`→502).
2. **Empirically:** run as `f65642ab` with **0** `whatsapp_sessions` → `POST /pairing/start` **201**,
   `GET /pairing/{token}/qr` **200** with a real 292×292 QR.
3. **No-Create invariant holds:** `start_pairing_session` (`sessions.py:251-260`) calls
   `gw.create_session(line_name, ephemeral=True)`. None of the ephemeral gateway ids from the repro
   (`a11fbe48-…`, and the tokens' ids) exists in `whatsapp_private.gateway_sessions` — **0 rows**. There is
   also **no pair-token table** (`information_schema` → 0 matches for `%pair%`/`%ephemeral%`):
   `_ephemeral_pairings` (`sessions.py:229`) is in-memory only, by design.

---

## 6. POST-QR-SCAN CHAIN

> **QR SCAN with a controlled device = NOT RUN.** No physical phone was available to me.
> What follows is derived from source + the real device activity the logs recorded (below).

**A. `pairing/start` require CONNECTED?** — No (§5).
**B. Row created at `pairing/start`?** — No. Zero rows in either table. `registerSession` writes
`whatsapp_private.gateway_sessions` only when `!ephemeral` (`session-manager.js:1121`).
**C. What happens on `connection.open`?** — `session-manager.js:3015-3042`: flips `session.ephemeral=false`
→ `registerSession(id, name, {active:true})` → `saveCredentials` → `leaseRepository.acquire(...)` →
`armLeaseRenewal()` → `emitEvent({event:'session_connected', phone, self_jid, self_lid})`.
**D. Who creates the durable `public.whatsapp_sessions` row?** — the **backend**, not the gateway:
`events.py:1190-1312` `map_session_event`. Row lookup by `gateway_id` → if None and `session_connected`:
ephemeral registry → `perform_atomic_relink(...)` (`events.py:1248`) → durable row.
**E. What if that lookup fails?** — P6-9 fallback (`events.py:1285-1307`) routes the event to the
ephemeral owner **without creating any row**; if the ephemeral entry is gone too →
`raise EventOwnerUnresolved` (`events.py:1309-1312`).
**F. What did production actually do?** — the phone **did** link, and the chain **did** break. See §7.

---

## 7. CASE PROOF

### CASE B — REFUTED (twice over)

> *"QR Sessions → Cihaz Bağla flow itself refuses with the message and blocks `pairing/start`."*

Refuted by code path (§5.1) **and** empirically (§5.2): for a user with zero sessions,
`POST /pairing/start` → **201** and a **real QR rendered 208×208 (natural 292)**. There is **no**
"CONNECTED required" guard anywhere on the pairing path.

### CASE C — REFUTED

> *"Stale session state produces it."*

The user with **0** rows (`f65642ab`) saw it; the user with a stale `CONNECTED` row (`e512dd40`) did **not**
(needle count 0). Stale state is therefore not the producer. (`id=68` *was* stale — but it produced the
**relink** message, not this one.)

### CASE A — CONFIRMED

> *"The message is a truthful consequence of having no CONNECTED line."*

`sync.py:1019` finds no `connected_only=True` session → raises → `job.error` → `GET /sync/job` 200 →
banner. Every `_no_session()` endpoint (`/contacts`, `/sync-status`, send text, `/read`, `/typing`, media,
`/logout`) behaves the same way. Fail-closed and truthful — **no false success anywhere**.

---

## 8. STALE-SESSION CHECK

| Item | Result |
|---|---|
| CONNECTED count (system-wide) | **0** |
| `resolve_event_owner` (`repositories/sessions.py:116-145`) | selects **all** `CONNECTED` rows, no tenant filter; returns owner only if exactly **1** distinct, else `EventOwnerUnresolved`. With 0 rows → **always raises** for events carrying no `gateway_session_id`. |
| `getConnectedSession` | **removed** — see the security note at `session-manager.js:1801-1807` ("önceki `_getConnectedSession()` / `_assertUnambiguousScope()` çifti…"). |
| `_requireConnectedSession` (`session-manager.js:1815-1823`) | `status !== 'CONNECTED' \|\| !session.sock` → throws `'Bu WhatsApp oturumu bagli degil. Lutfen once QR ile eslestirin.'` — a **third**, gateway-side variant. Fail-closed. |
| Pre-`pairing/start` existence check | **none** |

### The real find — a phone paired and the promotion never landed

Gateway log:
```
22:39:57  id=37c4da78-2121-4a27-a403-6218fda9b4e8  Baileys restartRequired (515) — soket hemen yeniden kuruluyor
22:40:40  id=89214b84-6508-4bd8-87b1-9a616c59c480  Baileys restartRequired (515) — soket hemen yeniden kuruluyor
```
`515 restartRequired` (`session-manager.js:3092-3096`) means **the phone scan succeeded** — Baileys only
needs to restart the socket to finish login.

Backend log, same window:
```
22:40:00,418  WARNING  Gateway olayi sahibi cozulemedi, atlandi (event=message_new):
              Bilinmeyen gateway oturumu (session_id=37c4da78-…, jid=905413749073@s.whatsapp.net)
22:40:43,723  WARNING  Gateway olayi sahibi cozulemedi, atlandi (event=message_new):
              Bilinmeyen gateway oturumu (session_id=89214b84-…, jid=905413749073@s.whatsapp.net)
22:41:00,419  WARNING  Gateway olayi sahibi cozulemedi, atlandi (event=contact_synced, session=37c4da78-…):
              Bilinmeyen gateway oturumu (…) (son 60 sn'de 2904 olay atlandi)
```
**2 904 events dropped in 60 seconds.** The message came from a **real phone**, over real JIDs
(`905413749073@s.whatsapp.net`, `905356872662@s.whatsapp.net`).

And the pairing was torn down within seconds:
```
22:40:00.4xx  POST /api/v1/whatsapp/pairing/a875ee2a-…/cancel      200
22:40:45.455  DELETE http://gateway:8787/sessions/89214b84-…       "HTTP/1.1 200 OK"
22:40:45.5xx  POST /api/v1/whatsapp/pairing/a2775a25-…/cancel      200
```
The observed UI pattern is a **start/cancel loop**:
`pairing/start` → 5× `…/qr` → `…/cancel` → `pairing/start` → `…/qr` → `pairing/start` → 2× `…/qr` → `…/cancel`.

**No `session_connected` promotion was ever processed** — `grep` over `22:35–22:46` for
`session_connected|Phase15.4|relink OK|RelinkCandidate|perform_atomic_relink|map_session_event`
returned **nothing**.

### Mechanism

The gateway promoted both sessions (`gateway_sessions` rows written `22:40:00.368` and `22:40:43.657`,
i.e. `connection.open` **did** fire and `session_connected` **was** emitted). The backend then failed to
convert that into a durable row. Three failure branches are possible and the evidence selects between them:

* `perform_atomic_relink` needs **both** `phone_from_event` **and** `user_id_from_event`
  (`events.py:1246`). With `phone` null it silently skips → P6-9 → routes the event but **creates no row**.
* If the ephemeral registry entry is already gone, even P6-9 fails → `EventOwnerUnresolved` → **this is
  the branch the logs show** (`Bilinmeyen gateway oturumu` = `events.py:1309`).
* `RelinkCandidateNotFound` → `pass` → falls into the same dead end (`events.py:1283-1284`).

The frontend's cancel is what removes the ephemeral entry: `WhatsAppQrConnectModal.tsx:401-409` cancels the
pair token in the **effect cleanup**, and `:379-383` cancels on **modal close**, and `:192-195` cancels a
pairing whose creation was still in flight. The effect deps are `[isOpen, initSession, clearTimers,
existingSessionId]` (`:410`) — any identity change re-runs the effect and cancels the live pairing.

**Net effect: the phone is linked at the WhatsApp/Baileys layer, but the platform holds no CONNECTED line.
Every line-dependent endpoint then truthfully reports "no connected line" — including the sync job, whose
error string is the one the user sees.**

---

## 10. FINAL OUTPUT (fixed format)

```
ERROR LOCATION:
  frontend/src/pages/WhatsAppHubPage.tsx:1937-1939  →  <p className="mt-1 text-[10px] …">{sessionSync.error}</p>
  Surface: WhatsApp hub → "Live Conversations" tab → left conversation column (w-full md:w-80 lg:w-96)
           → rose "Live Sync failed / Retry" banner (lines 1922-1941)
  DOM proof: p.mt-1.text-[10px] < div.mx-3.mt-3 < div.w-full.md:w-80 < div.vuexy-card   (inDialog=false, inToast=false)

ERROR SOURCE:
  backend response   (NOT a frontend guard, NOT a gateway event, NOT stale session state)
  Primary carrier : GET /api/v1/whatsapp/sync/job  →  HTTP 200  {"state":"FAILED","error":"…"}
  String origin   : backend/app/services/whatsapp/orchestration/sync.py:1019-1022
  Captured at     : sync.py:1165-1171  (job.state="FAILED"; job.error=str(exc)[:500])
  Secondary (the diacritic string quoted in the report):
                    backend/app/api/v1/endpoints/whatsapp.py:51-61  _no_session()  → HTTP 409 → toast

TRIGGER:
  A sync job runs while the caller has no CONNECTED line.
  Reached without user intent because WhatsAppHubPage.tsx:1619 calls refreshSyncStatus() on every hub mount
  and _sync_jobs is an in-process dict whose FAILED entry is retained and re-served indefinitely
  (sync.py:311-322 + get_sync_job returning snapshot() regardless of state).

REQUEST:
  GET /api/v1/whatsapp/sync/job        (no body)      → also POST /api/v1/whatsapp/sync for the live path

RESPONSE:
  200 {"sync_id":"af84ac9ac56d49f48447d52edd4534bf","state":"FAILED","stage":"starting",
       "error":"Bagli bir WhatsApp hatti yok. Lutfen once QR ile eslestirin.", …}
  (no 4xx/5xx anywhere — the message travels on a 200)

CURRENT SESSION STATE:
  public.whatsapp_sessions      : 3 rows total, 0 CONNECTED
  whatsapp_private.gateway_sessions : 36 rows (1 active, 35 inactive), 35 orphans not in public
  whatsapp_private.socket_leases    : 0 rows
  id=68 : RELINK_REQUIRED | gw a618f89c-… | phone +905076382749 | is_phone_online=f
          error_message=WHATSAPP_AUTH_RELINK_REQUIRED | updated_at 2026-09-19 22:50:03
          → gateway_sessions row exists (is_active=t) but socket_leases = 0  ⇒ NO LIVE SOCKET

QR START:
  POST /api/v1/whatsapp/pairing/start  →  201 Created
  {"pair_token":"db8c52c3-…","gateway_id":"a11fbe48-…","session_name":"Hat 1","status":"SCAN_QR","qr_code":null}
  Verified for a user owning ZERO whatsapp_sessions → NO pre-existing CONNECTED session required.
  No row written to public.whatsapp_sessions or gateway_sessions (No-Create holds).

QR SCAN:
  NOT RUN by me — no physical phone available. (Honest report: LIVE DEVICE E2E = NOT RUN.)
  A real device DID scan at 22:39:57 and 22:40:40; the gateway logged
  "Baileys restartRequired (515)" for 37c4da78-… and 89214b84-…, i.e. the link succeeded.

PROMOTION:
  FAILED. Gateway promoted both (ephemeral→false, registerSession wrote gateway_sessions rows at
  22:40:00.368 and 22:40:43.657, session_connected emitted) but the backend never produced a durable
  public CONNECTED row. No session_connected / Phase15.4 relink OK line exists in 22:35-22:46.
  Both ephemeral pairings were cancelled within ~2-5 s:
    22:40:00.4xx  POST /pairing/a875ee2a-…/cancel   → 200
    22:40:45.455  DELETE http://gateway:8787/sessions/89214b84-…  → 200
    22:40:45.5xx  POST /pairing/a2775a25-…/cancel   → 200

CONNECTED:
  NO. Zero CONNECTED sessions system-wide.
  Consequence: 2 904 gateway events dropped in 60 s with
  "Gateway olayi sahibi cozulemedi … Bilinmeyen gateway oturumu (session_id=89214b84-…)" (events.py:1309).

ROOT CAUSE:
  The reported message is NOT the bug — it is a TRUTHFUL report of "no CONNECTED line".
  The bug is WHY there is no CONNECTED line after a successful phone scan:
  the ephemeral pairing is torn down before the gateway's post-515 reconnect can reach connection.open
  and before the backend's session_connected → perform_atomic_relink promotion can create the durable
  public row. The frontend cancels on effect cleanup (WhatsAppQrConnectModal.tsx:401-409), on modal close
  (:379-383), and on in-flight creation (:192-195); the effect deps (:410) make a re-run cancel a live
  pairing. Once the ephemeral registry entry is gone, map_session_event can neither relink nor attribute
  the event, so every inbound event is dropped (events.py:1309) and no durable row is ever written.
  Contributing amplifier: a retained FAILED sync job re-renders the message on every hub mount
  (sync.py:311-322 + WhatsAppHubPage.tsx:1619).

IS THIS EXPECTED BEFORE CONNECTED?
  The MESSAGE is expected and correct — with no CONNECTED line, refusing to sync is the truthful,
  fail-closed behaviour (AGENTS.md §1.1). Nothing here is a false success.
  But it is surfaced in the WRONG PLACE and with the WRONG FRAMING: it appears as a "Live Sync failed"
  conversation-sync banner instead of a "no line paired — scan QR" call to action, and it persists across
  every page load for as long as the in-process FAILED job survives.
  The UNDERLYING CAUSE is NOT expected: a real phone scanned successfully and still produced no CONNECTED
  line. That is a genuine defect.

REQUIRED FIX:
  (Proposed only — nothing was applied; code change / DB mutation / session delete / status edit /
   gateway recreate were all forbidden and none was performed.)
  1. PRIMARY — stop the pairing teardown race (frontend). Do not cancel an ephemeral pairing whose socket
     has reached restartRequired/connecting; let connection.open complete and the promotion land.
     Revisit WhatsAppQrConnectModal.tsx:401-410 (effect deps / cleanup cancel), :379-383 (close cancel),
     :192-195 (in-flight cancel).
  2. BACKEND — make promotion independent of the ephemeral registry: when session_connected carries a
     gateway_session_id with no public row, create the durable row from the event's own phone/self_jid
     instead of falling through to EventOwnerUnresolved (events.py:1246-1312).
  3. PRESENTATION — the sync-failure banner must not be the surface for "no line paired". Gate
     WhatsAppHubPage.tsx:1922 on an actual CONNECTED session, and show a QR call to action instead;
     or at minimum relabel it so it does not read as a conversation-sync failure.
  4. LIFECYCLE — clear/replace a retained FAILED sync job so it cannot be re-rendered indefinitely
     (sync.py:311-322), and reap the 35 orphan gateway_sessions rows + the ephemeral leak
     (event_outbox enqueue has no !ephemeral guard; event_outbox currently holds 3 291 rows).
  5. Re-pair session id=68 (now RELINK_REQUIRED) — it holds no lease and cannot serve.
```

### Bottom line

> **Pairing infrastructure is healthy; the UI message is expected until a phone reaches CONNECTED.**
>
> `POST /pairing/start` → 201 and a real QR render for a user with **zero** sessions, so CASE B is
> impossible. The message is a truthful, fail-closed backend report carried on a **200** from
> `GET /sync/job`, rendered in the wrong banner.
>
> **However**, this run also proved a *separate, genuine* defect: a real phone scanned successfully at
> 22:39:57 / 22:40:40 (Baileys `515 restartRequired`), the gateway promoted both sessions, and the
> backend still ended up with **no CONNECTED line** — 2 904 events dropped — because the ephemeral pairing
> was cancelled before `connection.open` could be promoted. **That** is the bug to fix; the message is
> only its symptom.

### Verification integrity

* No code was changed, committed, pushed, or deployed.
* No session was deleted; no `status` was manually updated; no DB state was hand-edited.
* No container was recreated; the gateway was not restarted.
* The only DB writes were **additive, self-expiring auth tokens** in `public.auth_staging_sessions`
  (inserted to run the browser as the real user, then expired to `now() - 1s` immediately after each run).
* **One application-driven state transition is disclosed at the top of this report**: session `id=68`
  `CONNECTED → RELINK_REQUIRED` at `22:50:03`, caused by the sync the repro triggered through the real UI
  hitting a 404 from the gateway for a session that held no lease.
