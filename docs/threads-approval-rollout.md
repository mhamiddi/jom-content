# Threads owner approval + atomic publishing — local change, not deployed

Status: **implemented and tested locally. Not deployed. No production enforcement yet.**

## What it enforces

1. **Explicit owner approval of an exact version.** `POST /api/threads-approval` requires a
   signed interactive owner session and a same-origin request. The server computes the digest;
   the client cannot assert approval. The digest binds caption, ordered media, account and post
   id, and deliberately excludes `post.updatedAt` so publishing the same post elsewhere does not
   invalidate it.
2. **Atomic single publish attempt.** Each `(Threads userId, post id)` is a Durable Object
   (`workers/threads-publish-guard`) backed by SQLite `transactionSync`. Exactly one claim can
   succeed across concurrent requests. A claimed attempt is permanent: a failure becomes
   `uncertain` and blocks retries until an owner reconciles it manually. Published attempts
   return `already_posted`.
3. **Frozen media bytes.** `POST /api/threads-media-prepare` copies owner media to
   `threads-approved/<sha256>.<ext>` using a streaming SHA-256 (`crypto.DigestStream`), R2
   checksum verification and conditional writes/copies. Approval and publishing accept only
   checksum-addressed snapshot URLs, so the mutable original may change afterwards without
   affecting what Meta fetches. `/api/threads-media` serves snapshots (GET/HEAD only, no-store,
   checksum verified on read) through exactly one middleware exemption.
4. **Owner-visible review.** The dashboard shows frozen media, exact caption and account in a
   modal before approval; a failed or non-frozen media preview disables the approve button.

## Tests (all local)

- `tests/threads-guard-runtime.test.mjs` — real workerd/Miniflare: 32 concurrent claims → 1
  winner, restart persistence, identity isolation, permanent uncertain/published barriers.
- `tests/threads-end-to-end-runtime.test.mjs` — real Pages routes + real R2: 24 concurrent
  publishes → 1 Graph publish, mutable source does not affect served bytes, tampered snapshot
  returns 409 and blocks publishing, missing binding fails closed.
- `tests/threads-media-integrity.test.mjs` / `threads-media-route.test.mjs` — snapshot, tamper,
  traversal, SSRF and middleware exemption.
- `tests/threads-approval-browser.test.mjs` — Chromium at 375px: owner sees frozen media and
  exact caption, cancel publishes nothing, media load failure disables approval.

Miniflare and Playwright are installed only in
`/home/hamiddi/.hermes/cache/scratch/threads-approval-tools` (override with `THREADS_TEST_TOOLS`).

## Deployment steps (not done)

1. `wrangler deploy` in `workers/threads-publish-guard` on the Jom Digital Cloudflare account.
   It has `workers_dev = false` and no public routes; its default handler returns 404.
2. Bind it to the Pages project as `THREADS_GUARD` (`script_name = "jom-threads-publish-guard"`).
   Binding changes only apply on the next Pages deployment.
3. Configure `JOM_SESSION_SECRET` (distinct from `JOM_API_TOKEN`). This invalidates existing
   dashboard sessions; everyone signs in again.
4. Deploy, then run the flow against the deployment: login → edit → prepare → review dialog →
   approve → publish → replay (must return `already_posted`).
5. Verify `/api/threads-media?asset=...` is publicly readable while `/api/threads-media-prepare`
   stays session-only, and that a tampered object returns 409.

## Honest limits

- The Durable Object removes the KV race, but a request can still fail **between** the Graph
  publish call and `guard /finish`. That outcome is permanently `uncertain` by design and needs
  manual reconciliation instead of automatic retry. This is intentional: no duplicate post.
- Approval has no expiry; it is replaced only by a new approval or consumed by publishing.
- The guard covers the Jom Content path only. Threads posts made elsewhere are out of scope.
- Rollback: revert the Pages deployment. The guard Worker is independent and can stay deployed.

## Legacy attempts fail closed

Records written before this change live in KV only. A stale `publishing` record, or a `failed`
record with no ids/urls, may already exist on Threads even though nothing was recorded locally.
Publishing therefore returns `reconciliation_required` for any such pre-existing record, even
after a fresh owner approval. Operators must reconcile those posts manually; the guard does not
silently adopt them. New attempts are written to KV only after the durable claim succeeds, so a
stale new-format record always has a matching blocked guard state.

## Previous KV-only state

Superseded: the earlier version claimed approval single-use in KV and bound media URLs only.
KV is not transactional and URL binding did not guarantee the bytes, so that version was never
deployed.
