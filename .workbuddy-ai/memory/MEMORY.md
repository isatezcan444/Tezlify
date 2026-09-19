# Tezlify — Project Memory (index)

**Full detail: `.workbuddy-ai/memory/reference/whatsapp-subsystem-invariants.md`** (§A–§J).
Every entry verified against source or a read-only production query. Do not "fix" code that satisfies them.

| § | Topic | One-line anchor |
|---|---|---|
| A | Identity / ordering / payload | `resolve_contact_identity` is the only name authority; REST+WS share field names (**never `lead_phone`**); sort = activity only |
| B | Unread badge | Gateway owns `unread_count` and reports decreases → `Math.max` is always wrong; staleness guard symmetric; drop-to-0 IS read evidence (P6-1/P6-2) |
| C | Frontend React (Phase 6) | Per-conversation state in an **unkeyed** component: P6-3 pill, P6-4 viewport, **P6-5 composer draft → wrong chat**, P6-6 one canonical merge, P6-7 `behavior:'instant'` |
| D | Dedup / uniqueness | C-4 = `UNIQUE (conversation_id, wa_message_id) WHERE NOT NULL`; conversation constraint already solved; history cursor `(wa_message_id, from_me, timestamp_ms)` |
| E | Tenant isolation (G-3) | Route `lid_mappings → gateway_sessions → whatsapp_sessions.user_id`; **never** `get_user_filter`; owner resolution fails closed when ambiguous |
| F | Gateway contracts | P5-1 `buildMediaContent` (never wrap a Buffer in `{url}`); delivery ranks strictly-greater; broadcast kwarg is `target_user_id` |
| G | Pairing (6.4/6.5) | Ephemeral No-Create + `_ephemeral_pairings`; P6-8 pair-token code route; P6-9 owner association (**never global broadcast**); dual-path QR; **G-LEASE** |
| H | Test baselines | backend **1089 pass / 4 skip** (needs a session-free DB), gateway **21/21**, frontend logic 43 / dom 20 / browser 7/7 / pairing 8 / pairing-browser 12/12 |
| I | Production topology | `130.162.247.20`, `/opt/tezlify`, ssh `ubuntu`; **prod = `f6ec68d`, lacks the G-LEASE fix**; push ≠ deploy |
| J | Known-open | New Chat throws (F-5); background sweep over-promotes `FULLY_EXHAUSTED`; monitoring blind to a session dying holding no lease |

## Load-bearing facts to keep in head

- **G-LEASE is the real QR killer** and is **fixed locally** (`armLeaseRenewal()` armed only where a
  lease is held, plus the promotion branch). Production still runs the broken revision.
- **Real FK:** `socket_leases.session_id → whatsapp_private.gateway_sessions(session_id)`. `acquire`
  INSERT fails **23503**; `renew` UPDATE is a **silent** `rowCount 0`. That silence is the defect's cover.
- **Never conflate local test results with production health.**
- **No live-device pairing has ever been run** → report `LIVE DEVICE E2E = NOT RUN`.
- Local real stack (2026-09-19): PostgreSQL 17.11 on `:5432`, db `tezlify`; managed Node 22.22.2;
  backend venv at `./venv`; **no container runtime** on this machine.
