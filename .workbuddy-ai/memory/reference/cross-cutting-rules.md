# Tezlify — cross-cutting engineering rules (full reference)

Not WhatsApp-specific and not ops-specific: these are the general defect patterns that have actually
bitten this codebase. The index (`MEMORY.md`) keeps a one-line headline for each; the evidence lives here.

---

## X1. A key the serializer emits but the `response_model` does not DECLARE never reaches the client

`link_preview` was computed correctly server-side and was **invisible in production**. Pydantic v2
defaults to `extra="ignore"` on a `response_model`, so an undeclared key is silently dropped between the
handler's return value and the wire.

The tell is the **asymmetry**: `reactions` was declared on the same model and worked, while `link_preview`
did not — same handler, same payload shape, different outcome. When two sibling fields behave differently,
the difference is the model declaration, not the business logic.

This had already been fixed once for `WhatsAppSessionResponse.sync` (see A8), so the pattern **recurred**;
it is a class of bug, not a one-off. Procedure: `fastapi-response-model-silent-field-drop`.
Evidence: `2026-09-30.md`.

## X2. A code fix is not retroactive over a positive cache

Correcting how a value is *computed* leaves cached rows holding the **old** value for their full TTL.
Two 7-day consent-interstitial rows kept their wrong titles after the compute-path fix, until `expires_at`
was forced into the past.

Rule: always pair a compute-path fix with a cache invalidation. "The code is correct now" is not a claim
about what the database currently serves.

## X3. A served type must come from the BYTES, never from the name or the client's claim

Campaign media trusted `file.content_type` on upload, then re-guessed the type from the stored **filename**
and served it `inline`. Result: `text/plain` upload + `evil.html` filename came back as `text/html` and
**executed on the API origin**. `evil.svg` passed the same way.

The fix has three parts, and all three are required:

1. Sniff magic bytes at **upload**.
2. Sniff again at **serve** — this is what makes the rule retroactive over files already stored with a
   lying extension.
3. `inline` **only** for jpeg/png/webp; everything else `attachment`, plus `X-Content-Type-Options: nosniff`.

Note `text/plain` has no magic bytes at all — it cannot be validated by sniffing, and it was precisely the
carrier in this attack. A content-type that cannot be validated must not be trusted for `inline` serving.

## X4. A GLOBAL `unique=True` on a nullable identity column is a tenant-isolation bug, not a data-quality guard

A global unique constraint on `leads.<identity column>` made the **second** tenant's row impossible *and*
pushed the code into "merge into whatever row matched" — which is a **cross-tenant write**, i.e. one
tenant's data silently absorbed into another's.

Correct shape: a **partial composite** index, `(user_id, col) WHERE col IS NOT NULL`, plus every dedup
lookup scoped by tenant. `NULL` must stay non-unique (multiple rows legitimately have no identity).

Migration order matters: create the new index **first**, drop the old global one **only if that succeeded**,
both inside **one** transaction. Procedure: `non-destructive-schema-constraint-migration`.

## X5. "Persist but don't broadcast" — three mechanisms, two of them are the WRONG tool

Written in Turkish in the original session, kept verbatim because the naming is the point:

**"Persist et ama yayınla-ma" — üç mekanizma, ikisi YANLIŞ araç:** gateway `_internal_only`
(`events.js:337`) olayı backend'e **hiç göndermez** — history-sync için doğru, DB'ye yazılacak şey için
ölümcül. `_skip` (`events.py:2851`) `db.commit()`'i yalnızca postgres+event_id varsa çağırır ⇒ SQLite/test
yolunda persist commit'siz kalır. Doğru araç **`_no_broadcast`**: commit'ten SONRA okunur (`main.py:771`),
ACK eder, broadcast etmez. Eklerken **üç dönüş yolunu da** kapat: normal persist, pre-flight
`return event # dedup`, `IntegrityError` kurtarma.

## X6. A discriminator on the wire is worthless unless it is THREADED end-to-end

`messages.upsert` `type` (`notify`/`append`) `socket-events.js:613`'ten `_ingestUpsertMessage`'a
**geçirilmek zorunda**; geçmezse append canlı mesaj gibi rozet/önizleme/yayın üretir. **`messages.update`
artık açık `upsertType:'replace'` (5.3.9)**: aynı `wa_message_id` yerinde güncellenir, rozet artmaz,
zamansız güncellemede kaydın `created_at`'i korunur (asla `Date.now()`), gerçek içerik değişikliği
yayınlanır, no-op yayınlanmaz.

Append önizleme tuzağı: `should_apply_last_message` `ts <= cur`'u reddeder, AMA
`msg_dt = ... or utc_now_naive()` fallback'i zamansız geçmişi "şimdi" yapar ⇒ append + `created_at` yoksa
`apply_last_message` **hiç çağrılmamalı**. Gateway `_touchChat` de aynı tuzakta.

## X7. A cleanup key must come from the SAME function the writer uses

`_upsert_contact` writes `contact_phone_for_jid(jid)` (`identity.py:164`: `@g.us` → `jid:<jid>`, else
`jid_to_phone() or jid:<jid>`). `jid_to_phone` returns **`None`** for `@g.us` *and* `@lid` ⇒
`WHERE phone_e164 = NULL` silently deletes nothing while the test stays green. **Fixing one copy isn't
enough** — the group test carried an inline duplicate with the same wrong key, so patching `_purge` alone
left the leak intact (measured).

## X8. Tracked ≠ runs, and a counter must match the output dialect it counts

**Tracked ≠ runs.** `test-upsert-notify-append.mjs` was committed at HEAD yet absent from `scripts.test`
(0 occurrences) — a committed test that never executed for 4 stages. Check *chain membership*, not file
existence; a test's own presence proves nothing. Corollary: **a green chain exit is not proof the new link
ran** — match each script's distinctive output marker in the log, exactly once.

**A counter must match the output format it counts.** `test-tz428-…` prints `ok - …` + `PASS (N checks)`,
not `  PASS …`; a `^  PASS` grep reports **0** for a fully green script. Two scripts can be green with
different dialects — verify the dialect before trusting a count.
