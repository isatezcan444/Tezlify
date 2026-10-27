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
