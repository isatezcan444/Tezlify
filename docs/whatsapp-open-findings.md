# WhatsApp — open findings

Live-test findings that are not yet fixed. Written down so they are not lost;
each one is unverified in the browser and needs a real session to confirm.

## 1. "Load older messages" button is unreachable by design

`frontend/src/features/whatsapp/components/ChatThread.tsx:900`

```jsx
{win.start <= 0 && hasMore && loadOlderButton}
```

The control renders only when the virtualized window has scrolled to the very
top (`win.start <= 0`). The scroll handler triggers the same load at
`scrollTop < 60`, so by the time the button is visible the scroll path has
already fired it — the button has no independent use, and with the K.19
virtualization (K19_MIN_ROWS = 200) it stays hidden for most of a long thread.

The pagination itself is fixed (provider exhaustion no longer hides stored
history — see a95fb8e). This is about the affordance, not the fetch.

Needs a decision: either render the control inside the window (at the top of
the first mounted row) so it is usable, or drop it and rely on the scroll
trigger. Requires a browser session to confirm the current behaviour.

## 2. Scroll-anchor preservation has no real test

The existing `frontend/scripts/test-whatsapp-chat-scroll.mjs` asserts the
arithmetic of the height-delta trick against a hand-written object literal. It
never mounts ChatThread and would keep passing if the component stopped pinning
entirely.

A real JSDOM test was attempted and abandoned rather than committed. Findings
from that attempt, which are the hard part of writing it:

- The virtualized path only engages above K19_MIN_ROWS = 200 rows. A small
  fixture silently exercises the legacy height-delta path instead, so the suite
  would test the wrong code while appearing to pass.
- The bundle must export React, createRoot and I18nProvider from the same
  bundle as ChatThread; rendering against a second React instance throws
  "Invalid hook call". `verify-whatsapp-dom.mjs` already does this — follow it.
- JSDOM needs shims for `ResizeObserver` (a no-op leaves every row unmeasured
  and the window never fills), `scrollIntoView` and `scrollTo`.
- The component reads Vite's `import.meta.env` at module scope; `define` it in
  esbuild.
- Row rects must be computed on every `getBoundingClientRect` call. A captured
  rect keeps the geometry from capture time, and the test then validates nothing.
- The leading spacer must be read from the rendered `div[aria-hidden]`'s inline
  height rather than recomputed.
- `scrollTop` must have a single owner. An earlier version had the harness write
  to a dataset while the component read an accessor, so the two diverged.

With those in place the component mounts and the virtualizer runs, but the
resulting assertion was red with a 50-row offset that could not be attributed
with confidence to the component rather than the harness's height model. Left
uncommitted rather than committed failing or, worse, committed passing for the
wrong reason.

## 3. Unverified

- Real A -> B -> C -> A conversation switching.
- Group chats.
- Physical iOS keyboard behaviour (safe-area, viewport resize).

---

## Pass 2 — 2026-09-30: live reports, root causes, proof

Committed as `01e41be`, `5f932c0`, `5f24d60` and deployed to
`ubuntu@130.162.247.20:/opt/tezlify` (`.deployed-commit` = `5f24d60`).

### Why the earlier fixes were not live

The production checkout was still at `70d0395`. The backend image had been
built before the source was updated, so the running container lacked
`resolve_gate_phase`, `resolve_has_more` and the "plain open never blocks on the
provider" read path; the served frontend bundle was built before the
hydration-merge and gate edits. Both were rebuilt from `git archive HEAD` and
verified by hash — backend `whatsapp_service.py 47e39a11…`, `events.py
6bae3146…`, gateway `events.js 6a2eddc1…`, and the live bundle md5
`f56c995e…` equals the local build.

### Report -> root cause -> fix

1. **A sent message looked duplicated.** The conversation hydrator
   concatenated each revalidated page onto the painted thread
   (`[...fetched, ...existing]`), so every list refresh or WS revalidation
   re-added every row. Both hydration paths now merge by identity
   (`mergeWhatsAppMessages`). `5f932c0`.
2. **The loading screen closed early.** Gateway `session_sync_completed` was
   translated to `phase='ready'` in the hook and to `sessionSync.phase='ready'`
   in the page while the backend's own first sync (chats snapshot + contacts +
   messages + empty-chat backfill) was still running. Both now re-ask the single
   authority (`GET /whatsapp/loading-gate`). `5f932c0` + `01e41be`.
3. **Opening a conversation was slow.** The running backend image predated the
   measured fix that returns local rows immediately on a plain open instead of
   awaiting the gateway history round-trip (~3–4 s observed live). Rebuilding
   the image was the fix; no new code was needed.
4. **A refresh after QR pairing showed an unfinishable gate.**
   `resolve_gate_phase` derived the phase from in-memory job/gateway state and
   checked `avatars_missing` before `ready` — none of which survive a restart.
   It now returns `ready` from the durable
   `whatsapp_sessions.initial_sync_completed_at` (verified on session 112:
   `2026-09-30 12:47:07`), never lets avatars hold the gate, and the frontend
   only blocks on `syncing_history`. `01e41be` + `5f932c0`.
5. **`event_outbox` / `lid_mappings` FK 23503** (24 + 8 in one day). No-Create
   ephemeral pairings have no `gateway_sessions` row by design, so every
   QR-window durable write failed. The outbox and LID persistence now mirror
   the `registerSession`/lease guard and resume after `connection.open` promotes
   the session. `5f24d60`.

The Caddy `/ws` 502s were backend downtime during deploy windows (the two most
recent ones are this deploy's own container recreate); the backend is healthy
with `RestartCount=0` and has not 502'd since.

### Log provenance — not application bugs

The other PostgreSQL statements in the 2026-09-30 log were ad-hoc diagnostics
run through `psql`, not application SQL: `SELECT ... FROM
public.history_sync_states` (the table is `whatsapp_private.history_sync_states`),
`table_name LIKE %history%` (unquoted), `contacts.avatar_url` (it lives in
`contacts.custom_attributes`), `conversations.avatar_url` (no such column), the
`messages.created_at` GROUP BY and the `UNION` syntax error. None of them is
produced by the product.

The two genuine insert races (`uq_contact_user_phone`,
`uq_msg_conv_wa_message_id`) already have savepoint handling in the source —
the duplicate is caught and ignored — but the production image that logged them
predated those fixes and has now been replaced.
