# Tezlify — project index

Details: `reference/whatsapp-subsystem-invariants.md`; daily logs: `YYYY-MM-DD.md`.

## Invariants
- Identity: `resolve_contact_identity` owns names. REST/WS fields match (never `lead_phone`); sort by activity only.
- Gateway owns unread count, including decreases; no `Math.max`. Drop to zero is read evidence. Preserve per-conversation drafts/viewport and canonical merge; use instant scroll.
- Message uniqueness: `(conversation_id, wa_message_id) WHERE NOT NULL`; cursor includes direction/time.
- G-3 owner route: `lid_mappings -> gateway_sessions -> whatsapp_sessions.user_id`; never relaxed tenant filters; ambiguous/unknown ownership fails closed.
- Media: never wrap a Buffer in `{url}`; delivery rank increases only; broadcasts use `target_user_id`.
- No-Create means no `whatsapp_sessions` row before actual connection. G-LEASE renews only held leases.

## State recorded 2026-09-20
- Production last verified at `6f4aa00`: Oracle `130.162.247.20`, `/opt/tezlify`, SSH key `~/.ssh/id_tezlify_oracle`, user ubuntu. Push is not deploy. Frontend built off-box; Caddy bind mount resolves `frontend_candidate` symlink at creation, requiring Caddy recreation on swap.
- QR-start latency improved ~21.6 s -> ~0.21 s after scoped LID lookup deployment. See production deploy and QR latency reports.
- Phase 6.8 local promotion changes remain UNCOMMITTED/UNDEPLOYED. Event promotion adds CREATE path; durable pairing registry plus modal cancellation guards. Backend reproduction: HEAD 15 fail/9 pass -> 24 pass.
- `WHATSAPP_PHASE6_8_PROMOTION_REPORT.md` contains results; LIVE DEVICE E2E NOT RUN. Phase incomplete. Recorded production row 68 needs user-driven relink, not DB edits. A controlled local live test does not inherently require production writes.
- Terminal-status follow-up **DONE** (report §12): ephemeral poll + refresh now learn terminal status; predicate corrected to the documented 3-state set (handed-over tree still had the six-state complement — live false-CONNECTED/socket-leak once `FAILED` became reachable); both TERMINAL checks restored **and falsified** in vivo; real-Chrome check `H` added. Frontend-only, still uncommitted/undeployed.

## Verification
- Last backend: 1113 pass/4 skip on isolated SQLite copy (re-confirmed after the §12 follow-up); gateway previously 22/22. Frontend current: logic 43, DOM 20, Chrome 7, pairing 14, pairing-Chrome 14, merge/equivalence, chat-order 10.
- Never run pytest on dev `tezlify.db`: leftover CONNECTED owners cause 28 fail-closed failures. Copy via SQLite backup, remove test-conflicting sessions/pairing records ONLY in copy, set DATABASE_URL; use a fresh pytest basetemp instead of broad temp deletion.
- Seven npm verify scripts omit chat-order; run that script separately. Bundle relative imports with esbuild, not data-URL string stripping.
- Compare actual exit codes; browser assertions and sandbox housekeeping failures are distinct. Failed auxiliary ORM writes/rollback expire loaded rows: capture PK before rollback and reload asynchronously.
- Falsify a restored regression check against the real broken mechanism before trusting it — counter-only assertions can pass under a missing call site (assert the mechanism-specific signal too). Counter checks after a shared-harness reset need an explicit baseline, never zero.
