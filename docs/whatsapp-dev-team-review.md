# WhatsApp Module — Review by the Delivery Team

**Date:** 2026-09-30 · **Branch:** `main` · **Deployed backend:** `f9e92fa` · **Deployed frontend:** `ae7a9b2` (built)
**Scope:** the WhatsApp surface end to end — `whatsapp-gateway` (Node/Baileys), `backend/app/services/whatsapp/**`,
`frontend/src/features/whatsapp/**`, the Caddy/Compose deployment, and the verification harnesses.

**How this review was produced.** Every finding below is either (a) something measured on production during this
session, (b) something read directly out of the source, or (c) something a gate in this repo actually reported.
Where a claim rests on a measurement, the measurement is quoted. Nothing here is inferred from "it looks fine".

---

## 0. Summary

| Area | State | Verdict |
| --- | --- | --- |
| Inbound message correctness | Duplicate-ingest race could abort a whole transaction | **Fixed** `f9e92fa` |
| Composer ergonomics | Draft lost focus on every send; no emoji input at all | **Fixed** `72b8ff4`, `ae7a9b2` |
| Message reactions | Does not exist, and inbound ones currently produce junk rows | **Open — P0** |
| Media + link previews | Media renders, but there is no unfurling of any kind | **Open — P0** |
| Loading/session state machine | Single-authority gate from durable state | Good |
| Deployment | Manual, file-copy based, not reproducible from git, ~4 s of 502 per deploy | **Open — P1** |
| Verification | Broad but fragmented; one gate never exited; lint is red on `main` | **Open — P1** |
| Local test fidelity | Suite runs on SQLite, production is PostgreSQL | **Open — P1** |

Two of the four requests in this round are shipped and verified. The other two are new verticals that do not exist
anywhere in the tree; they are specified at the end of this document with their seams identified, so they are a plan
rather than a guess.

---

## 1. Lead Developer — architecture, correctness, data

### 1.1 [P0, FIXED] A lost duplicate-insert race could take a whole transaction with it

`_ingest_message` checked for an existing message and then inserted without a savepoint. The check is a TOCTOU
filter: two ingests of the same WhatsApp message both pass it, and the loser hits `uq_msg_conv_wa_message_id`. With
no nested block, that `IntegrityError` aborted the **entire** transaction — the contact upsert and the conversation
row written for that very message included — and the only recovery left was `ingest_gateway_event`'s
transaction-wide rollback plus a re-select.

Observed live: `2026-09-30 14:32:01.065 UTC` on conversation 17600, 30 ms after the winner committed. Attribution
came from the backend log, not the statement shape (both insert paths render the same 24 columns):

```
14:32:01,080 INFO message_new DB yarisi kazanan satirla yeniden yayinlandi (conversation_id=17600)
```

`grep -c "concurrent ingest race"` over the same log returned **0**, so the savepointed `_persist_gateway_message`
was not involved. Fixed by isolating the insert in `db.begin_nested()` and resolving the duplicate locally from the
row that won, with the conversation summary applied only on the success path (`752...`→`f9e92fa`).

**Residual, stated plainly:** a savepoint rollback does **not** suppress PostgreSQL's log line. Verified with a
throwaway probe (temp table, `SAVEPOINT` → `ROLLBACK TO SAVEPOINT`, 14:50:46): the `ERROR` was still written. The
fix removes the *damage*, not the log entry. Silencing it needs `INSERT … ON CONFLICT DO NOTHING`, which cannot
return the ORM row and would add one `SELECT` per inbound message — the exact round-trip Phase 10.9 removed.

### 1.2 [P0, OPEN] Inbound reactions become junk messages

`whatsapp-gateway/src/messages/message-classifier.js:64` maps a reaction to the placeholder body `'[REACTION]'`:

```js
if (c.reactionMessage) return '[REACTION]';
```

That marker exists so reactions do not leave an *empty* conversation preview (a real bug it fixed). But it means a
reaction is persisted as an ordinary message row with body `[REACTION]`: a junk bubble in the thread, and a wrong
`last_message` preview in the conversation list. Reacting to a message in WhatsApp Web is not a message, and the
data model must not pretend it is. See §5.1 for the fix.

### 1.3 [P1] The mirror route of every write path must be checked for the same isolation

`_persist_gateway_message`, `_insert_messages_resilient`, `_persist_sync_batch_safely`, `_upsert_contact` and the
sync contact/conversation inserts all isolate their inserts. `_ingest_message` was the one that did not. That
asymmetry — one sibling missing a guard the others have — is the actual defect class here, and it is worth a
repository-level invariant test rather than a fixed list: any `db.add(...)` / `flush()` on a table with a partial
unique index, outside `begin_nested()`, is a latent version of 1.1.

### 1.4 [P1] The suite runs on a different database engine than production

`DATABASE_URL="sqlite+aiosqlite:///./tezlify.db"` locally; production is PostgreSQL 16 (`tezlify-db`). So the 665
tests executed in this session exercised SQLite. The consequence is not hypothetical: the savepoint/`ON CONFLICT`/
partial-index nuances in §1.1 behave differently per dialect, and the fix in 1.1 only produces its log-line artefact
on PostgreSQL — SQLite would never have shown it. A PostgreSQL job for the WhatsApp suites is the single highest-value
test-infrastructure change available.

### 1.5 [P2] The deferred provider-ACK store is in-process memory

The store that lets an early ACK land on a message that has not been written yet is a bounded in-memory dict
(`_DEFERRED_STATUS_TTL_S=300`, `_DEFERRED_STATUS_MAX_KEYS=1000`). A backend restart between the ACK and the message
record loses it, and the ACK is then applied by… nothing. Making it a PostgreSQL table removes a whole class of
"the tick never turned" reports at the cost of one small write per early ACK.

### 1.6 [P2] Ephemeral gateway sessions are gated but never reaped

The FK 23503s (`event_outbox_session_id_fkey`, `lid_mappings_session_id_fkey`) came from No-Create ephemeral QR
sessions that have no `gateway_sessions` row by design; `5f24d60` made the durable writers skip work they cannot
satisfy. Nothing deletes the rows afterwards, so the population only grows. A periodic reap of inactive
`gateway_sessions` rows with no corresponding public `whatsapp_sessions` row closes the loop.

---

## 2. Lead UI/UX Architect — the gap against WhatsApp Web

The reference the user keeps pointing at is not "a chat UI", it is *their* chat UI: focus behaviour, emoji, reactions,
previews. Ranking the gaps by how often a user would hit them:

### 2.1 [P0, FIXED] The cursor left the composer after every send
The draft input was rendered `disabled` while `sending`, and a focused element that becomes disabled is blurred by
the browser; re-enabling never restores focus. So `Enter` — the fastest path in the product — ended with the user
reaching for the mouse. Now only the *actions* are gated on `sending`, focus is reclaimed when nothing else claimed
it, and the completion clears only the draft that was sent (the field stays usable mid-flight, so an unconditional
clear would eat the next message). `72b8ff4`.

### 2.2 [P0, FIXED] There was no way to send an emoji
Added an iOS/WhatsApp-Web-shaped panel: search on top (English **and** Turkish — this app is Turkish-first, and
someone looking for ❤️ types "kalp"), grid in the middle, category bar pinned to the bottom, recently-used first,
insertion at the caret. `ae7a9b2`.

Two UX details worth keeping: the panel opens on the smileys when there is no history (opening on an empty
"recently used" tab shows a first-time user a blank panel), and it deliberately stays open across picks, because
adding three emoji in a row is the common case.

### 2.3 [P0, OPEN] No reactions
WhatsApp Web puts six quick reactions behind a hover/right-click on the bubble and a full picker behind the "+".
The result is visible in the conversation list too ("X reacted ❤️ to your message"). Today reactions do not exist and,
worse, create junk bubbles (§1.2). Users will read that as "the app is broken", not "the feature is missing".

### 2.4 [P0, OPEN] Nothing is ever previewed
Verified: `og:image`, `link_preview`, `linkPreview`, `unfurl`, `openGraph` — **zero matches** in the whole repository.
A pasted YouTube/Instagram/PDF URL arrives as a plain blue line of text. Media rendering does exist
(`ChatBubble.tsx` renders `<img>`, `<video>`, `<audio>` and a document link off `/api/v1/whatsapp/media/{id}`), but:

* a video renders with **no poster**, so the bubble is a black rectangle until Play is pressed;
* a PDF is a filename and a link, not a document card;
* there is no thumbnail for stickers/documents beyond what the provider sent.

### 2.5 [P2] Known ergonomic debt already on record
`docs/whatsapp-open-findings.md` still carries the "load older" reachability issue (`ChatThread.tsx` requires
`win.start <= 0 && hasMore`) and the missing scroll-anchor DOM test. Both are worth clearing before adding more
surface.

---

## 3. QA Lead — what is actually proven

### 3.1 [P1, FIXED] A gate reported 9/9 and then never exited
`verify-whatsapp-realtime-inbound.mjs` printed `9/9 scenarios passed` and hung: the bundled React/jsdom graph keeps
the event loop alive and the script never called `process.exit`. A gate whose result and exit code cannot be read is
not a gate — and it looked exactly like a hang. Fixed (`72b8ff4`), and the same artefact is now documented in the
harness that needs it.

### 3.2 [P1, OPEN] `npm run lint` is red on `main`
`npx eslint src` reports **248 problems (175 errors, 73 warnings)**. The gate script is `eslint … --max-warnings 0`,
so it always fails; a red gate is ignored, which is how the next real error gets ignored too. Today's own file
contributes one pre-existing warning and zero errors.

### 3.3 [P1, OPEN] No end-to-end coverage of the paths users care about
`verify-production-whatsapp.mjs` self-reports 6/6 and then lists what it cannot check without an authenticated
session: A→B→C→A chat switching on live data, incoming latency on a real conversation, the send → ACK → DELIVERED
round trip, group history pagination and scroll preservation, and the mobile viewport/iOS keyboard. Those are
precisely the five things the last three rounds of bug reports were about. A seeded test tenant with a scripted
Playwright session would convert all five from "believed" to "measured".

### 3.4 [P2] Verification is 20 npm scripts, not one entry point
There is no `npm run verify:all` (or CI job) that runs the suites and fails the build; each script is invoked by
hand, and their failure modes differ (some `process.exit`, some set `exitCode`, some do neither). One aggregator
that exits non-zero on the first failure would have caught 3.1 immediately.

### 3.5 What is genuinely well covered
Worth stating so it is not rebuilt: the loading-gate authority, the message-merge equivalence (including the
hydration guard), realtime inbound merge, the chat-loading lifecycle, dialog focus-trap/a11y, and the emoji data
layer each have executed gates. The backend WhatsApp suite is broad (665 passed, 4 skipped in this session) and the
WhatsApp regression tests are written as *contracts* with the production evidence in the docstring, which makes them
maintainable.

---

## 4. Project Lead — delivery, risk, and what to do first

### 4.1 [P1, OPEN] Deployment is not reproducible from git
Production `/opt/tezlify` is a checkout whose `git log -1` is **`70d0395`**, six-plus commits behind the content it
is actually running, with 16 files carried as uncommitted local modifications. `.deployed-commit` is a
**hand-written file**. The practical consequence, verified by inspection: a reflexive `git reset --hard` or
`git pull --ff-only` on that host would **revert the deployed frontend and gateway fixes**. Today's backend deploy
had to be done with `git checkout <sha> -- <path>` for exactly this reason. Either make the host a clean deploy
target on a fixed ref, or stop pretending it is a git checkout and deploy artefacts (image digests + a bundle).

### 4.2 [P1, OPEN] Every deploy is a short outage
Recreating the backend drops the gateway event bridge and Caddy answers 502 on `/ws` until it reconnects. Measured
window: backend recreate at **14:57:49**, gateway `event_bridge_socket_closed` (1012) → one `ECONNREFUSED` attempt
at **14:57:52**, reconnected **14:57:55**. Every Caddy 502 in the logs traces to a deploy. For a chat product, a
`/ws` 502 is a visible reconnect for every open client. A blue/green or `start-first` roll (new container healthy →
Caddy switches → old container stops), with an image health-check before the swap, removes it.

### 4.3 [P1, OPEN] The frontend deploy has a sharp edge
Caddy bind-mounts the *directory* `/opt/tezlify/frontend_candidate`. Replacing that directory leaves the container
serving the old inode; the content must be written **into** it. Documented here because it is invisible until it
bites, and the last two deploys hand-rolled it.

### 4.4 Roadmap, in the order I would spend the next rounds

| # | Item | Why now | Effort | Risk |
| --- | --- | --- | --- | --- |
| 1 | **Message reactions, full slice** (§5.1) | Explicit request; today reactions actively produce wrong UI | M–L | Medium — new table + event + WS shape |
| 2 | **Link previews + document/media cards** (§5.2) | Explicit request; zero code exists | M–L | Medium — outbound HTTP needs an SSRF guard |
| 3 | **Zero-downtime deploy + artefact-based releases** | Every deploy is a user-visible outage now | M | Low |
| 4 | **PostgreSQL test job** (§1.4) | Makes §1.1 class detectable before production | S | Low |
| 5 | **One verification entry point** (§3.4) | Would have caught §3.1 the day it landed | S | Low |
| 6 | **Lint back to green** (§3.2) | Restores a cheap early-warning signal | S–M | Low |
| 7 | **Durable deferred-ACK store** (§1.5) | Removes a restart-shaped failure class | S | Low |
| 8 | **Ephemeral session reaper** (§1.6) | Bounds a table that only grows | S | Low |
| 9 | **Authenticated E2E suite** (§3.3) | Converts the five unverified paths into measurements | L | Medium |

Effort: S ≈ within one work session, M ≈ a day, L ≈ several days.

---

## 5. Implementation notes for the two open verticals

Recorded so the next pass starts from seams that were actually verified, not from a guess.

### 5.1 Reactions

*Storage.* New table `message_reactions`: `id`, `user_id`, `message_id` (FK → `messages.id`, `ON DELETE CASCADE`),
`conversation_id`, `reactor_jid`, `from_me`, `emoji`, `created_at`, `updated_at`, with a **unique
`(message_id, reactor_jid)`**. WhatsApp semantics = one reaction per person per message, replaceable, and empty
`text` means *remove*. Mirror it in `ensure_*` style in `backend/app/core/migrations.py` (called from the
`lifespan` block in `app/main.py`) **and** in `Message.__table_args__`, or a fresh install and a migrated install
diverge — that trap is already documented on `uq_msg_conv_wa_message_id`.

*Gateway.* Add `sendReaction` next to `sendTextMessage` in `session-manager.js` (Baileys:
`sendMessage(jid, { react: { text, key: { remoteJid, fromMe, id } } })`, empty `text` clears), and in
`_ingestUpsertMessage` (≈ line 1181) branch on `reactionMessage` **before** the message row is built, emitting
`{ event: 'message_reaction', conversation_id, target_wa_message_id, reactor_jid, from_me, emoji, ts }` instead of
letting `systemContentMarker` turn it into a `[REACTION]` body. That is also the fix for §1.2.

*Backend.* Ingest `message_reaction` in `orchestration/events.py` (upsert or delete; isolate the write in a savepoint
as in §1.1), broadcast the same shape to the client, expose reactions on `serialize_message` (`orchestration/messaging.py:70`,
where `media_url` is already derived) via one batched query for the page being returned, and surface the newest
reaction on the conversation payload for the list.

*Frontend.* Extend the `Message` type with `reactions`, apply `message_reaction` in `WhatsAppHubPage.handleWsEvent`
the way message merges are applied today, render chips on `ChatBubble` plus a quick-six bar on hover, and reuse
`EmojiPicker` for the "+" affordance. The conversation list already receives a preview string; the reaction line is a
second, smaller line under it.

### 5.2 Media and link previews

*Link unfurling.* New backend service: extract the first URL from a message body, fetch it **server-side** with a
strict guard (http/https only, resolve DNS and refuse private/loopback/link-local ranges, cap redirects, ~200 KB and
a short timeout), parse OpenGraph/Twitter/`<title>`/`<meta description>`, and store the result keyed by
normalised URL with a TTL. YouTube and Instagram need no special-casing beyond OG tags *plus* a deterministic
`embed`/thumbnail URL, which is cheaper and more reliable than scraping. Cache in a `link_previews` table so a thread
reload costs no outbound requests.

*Rendering.* A `LinkPreviewCard` in `ChatBubble` for the URL-only case; a document **card** for PDFs (icon, filename,
size, "Open"); a poster/thumbnail for video so the bubble is not a black rectangle; a click-to-load iframe only for
an explicit allowlist (YouTube/Vimeo), never for arbitrary URLs.

*SSRF is the whole risk here.* This is the one new place in the product that makes outbound requests driven by
untrusted input. The guard belongs in the service, with tests for `127.0.0.1`, `localhost`, `169.254.169.254`,
`::1`, decimal/hex-encoded IPs and a redirect to a private range.

---

## 6. Appendix — fixed during this review

| Finding | Evidence | Commit |
| --- | --- | --- |
| Duplicate-ingest race aborted a whole transaction | Production `14:32:01.065`, conversation 17600, backend log `message_new DB yarisi…`; zero `concurrent ingest race` lines | `f9e92fa` |
| Draft lost focus on every send | Input rendered `disabled` while `sending`; new DOM gate fails against the unfixed component | `72b8ff4` |
| Realtime gate reported 9/9 then never exited | Ran bounded: printed `9/9`, still alive at 60 s | `72b8ff4` |
| No emoji input at all | Not implemented anywhere; `npm run verify:emoji` now 8/8, composer DOM gate 7/7 | `ae7a9b2` |
| Turkish search missed inflected nouns | `searchEmojis('bayrak')` did not return 🇹🇷 (`bayrağı`) — caught by the new gate | `ae7a9b2` |
