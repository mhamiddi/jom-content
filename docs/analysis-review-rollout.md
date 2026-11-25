# Threads analysis review — local preview and owner approval

Status: **deployed 2026-11-25** (page, review API, envelope route, machine ingest route). Production signing keys, the host pin, real analyses and the cron consumer switch are tracked in *Production blockers* below.

The review UI lets the owner inspect an agent-produced analysis (generated post, source
reference, reference metrics, evidence, observation vs hypotheses, confidence, suggestion) and
record one of three decisions. A decision is bound to a SHA-256 digest the server computes from
the content. A client hash is only ever compared, never trusted. Editing the generated post
changes the digest, so the earlier approval no longer counts.

Owner approval then travels to the host learning gate as a **signed envelope**: the dashboard
signs an Ed25519 envelope binding the exact review digest, the exact host candidate version and
the exact host analysis version; the host verifies it with a pinned public key and emits
`n0/approved-lessons.json` containing only those exact versions. Nothing else can enter N0.

## Files

| File | Purpose |
| --- | --- |
| `analysis-review.html` | Owner review page (static, same design language as `analytics.html`) |
| `analysis-review.js` | Render, edit, binding display, envelope download, login gate; no publishing code |
| `functions/api/threads-analysis.js` | `GET`/`POST`/`PATCH` review API |
| `functions/_lib/analysis-review.js` | Canonical content, digest, binding, decision/edit storage, `isApproved()` |
| `functions/api/learning/approvals.js` | `GET` signed approval envelope (host-consumable) + public key block |
| `functions/api/learning/reviews.js` | Machine ingest: bearer-only `PUT` of the record array + `GET` digest readback; cannot touch decisions or edits |
| `functions/_lib/approval-envelope.js` | Envelope build, Ed25519 signing, canonical bytes, self-check |
| `preview/server.mjs` | Local static + API preview, in-memory KV, ephemeral signing key |
| `preview/analysis-seed.json` | Three demo records: performing, underperforming, borderline/low-confidence |
| `tests/threads-analysis-review.test.mjs` | API/auth/hash/invalidation tests (Node, no browser) |
| `tests/threads-analysis-approvals.test.mjs` | Envelope route, signing, exclusion and revocation tests |
| `tests/analysis-review-browser.test.mjs` | Real page at 375px, real preview server, envelope download |
| `docs/analysis-review-rollout.md` | This document |

Host side (outside this repo):

| File | Purpose |
| --- | --- |
| `~/.hermes/scripts/threads_owner_approval.py` | Envelope verification + pinned key loading |
| `~/.hermes/scripts/threads_review_ingest.py` | Builds the `threads_analysis_reviews` array from real candidates + analyses |
| `~/.hermes/scripts/tests/test_review_ingest_e2e.py` | Real-candidate end-to-end: ingest → dashboard → approval → N0 → tamper/revoke |
| `~/.hermes/scripts/tests/test_threads_review_ingest.py` | Ingestion unit rules (exclusions, stability, drift detection) |
| `~/.hermes/scripts/threads_learning_review.py` | Candidates, analyses, `gate()` → approved-only N0, `--consumer` |
| `~/.hermes/scripts/tests/test_approval_bridge_e2e.py` | End-to-end bridge rehearsal (preview → envelope → N0) |
| `~/…/threads/learning/review/approvals/` | Pinned public key, optional envelope cache |

## Data contract (agent-owned)

The learning agent owns an array in KV `threads_analysis_reviews` in `JOM_CONTENT`. On the host it
is produced by `threads_review_ingest.py` (see *Ingestion* below), never typed by hand:

```json
{
  "id": "stable-analysis-id",
  "createdAt": "ISO-8601",
  "generatedBy": "threads-learning-agent",
  "classification": "performing | underperforming | borderline",
  "generatedPost": "exact post text the owner would approve",
  "source": {"type": "threads", "label": "@handle", "url": "", "postId": "", "publishedAt": "ISO-8601", "excerpt": "reference excerpt"},
  "metrics": {"views": 41200, "likes": 1842, "replies": 216, "reposts": 318, "quotes": 64, "shares": 91},
  "comparison": {"metric": "views", "baselineMedian": 9000, "deltaPct": 357.8, "sampleDays": 30, "note": "basis"},
  "evidence": [{"claim": "what the data shows", "source": "where from", "url": "https://…", "value": 41200}],
  "observation": "facts only",
  "hypotheses": ["interpretation that is not yet proven"],
  "confidence": {"level": "high | medium | low", "score": 0.72, "rationale": "why"},
  "suggestion": "next test / change",
  "binding": {
    "candidateId": "tl-<calendar-id>-72h",
    "candidateSha256": "<64 hex, host candidate_sha256>",
    "analysisSha256": "<64 hex, host analysis file hash>",
    "postIds": ["<threads post id>"]
  }
}
```

- `binding` is the link to the host gate. It is **inside the digest**, so an agent cannot repoint
  an already-approved review at a different analysis version: changing any binding field changes
  the digest and the stored decision reads back as stale/pending.
- `candidateId`, `candidateSha256`, `analysisSha256` come from the host's own records
  (`review/candidates/LATEST.json` and `review/analyses/<candidate>/<analysis_sha256>.json`).
  `postIds` must equal the host candidate's `post_ids` list, in order.
- A record **without** a complete binding can still be decided (approve/revise/reject are useful
  owner records) but it is never emitted into the signed envelope, so it can never reach N0. The
  UI states this on the card.
- Records without a non-empty `id` and `generatedPost` are ignored by the API.
- The API response is an explicit allowlist; extra record fields (for example a token) are never
  returned.
- Numeric extra metrics are folded into the digest so adding a metric does not silently leave the
  approval covering less content. Unknown non-numeric fields are **not** covered; adding a new
  reviewable field requires editing `reviewContent` and bumping `schema`.
- **Content schema is 2** (adds `binding`). Decisions stored under schema 1 (or under the earlier
  malformed-JSON canonical form) no longer match and read back as `stale: true, status: pending`.
  That is the intended direction: an old approval must be re-approved by the owner.

## Ingestion: host candidates → dashboard review records

The `threads_analysis_reviews` array is no longer hand-written. `threads_review_ingest.py` builds it
from artifacts that already exist on the host and refuses to write a record the dashboard would
reject.

| Input (read-only) | Used for |
| --- | --- |
| `review/candidates/LATEST.json` | candidate identity, root metrics, verdict, observation, reference block; its `document_sha256` is verified before use |
| `review/analyses/<candidate_id>/<analysis_sha256>.json` | newest analysis version: `finding`, `hypothesis` + `hypothesis_alternatives`, `confidence.level`, `test_variable`, `next_draft_change`, `reference_post_ids` |
| `state.json` → `publications[<calendar_id>].actual_content` | `generatedPost`, copied verbatim |

```bash
python3 ~/.hermes/scripts/threads_review_ingest.py --build      # write review/ingest/records.json
python3 ~/.hermes/scripts/threads_review_ingest.py --check      # re-derive + verify, exit 2 on drift
python3 ~/.hermes/scripts/threads_review_ingest.py --seed /tmp/seed.json   # KV-ready array
python3 ~/.hermes/scripts/threads_review_ingest.py --print      # inspect without writing
```

Rules the module enforces:

- **One record per candidate**, id `ana-<candidate_id>`. Correcting an analysis therefore changes the
  record content, the server digest, and the owner's earlier approval reads back as
  `content_changed_since_decision`; re-approval is a deliberate owner act.
- `generatedPost` is the **verbatim published text** of the reviewed chain (the post the analysis is
  about). The proposal is not invented: it is the analysis `next_draft_change`, exposed as
  `suggestion`.
- `classification` is derived from the candidate verdict (`winning`→`performing`,
  `losing`→`underperforming`, `at_median`→`borderline`, `insufficient_data`→`insufficient_data`).
- `confidence.score` is always `null`; only the analysis `level` is carried, with a rationale that
  says the level is the analyst's judgement.
- `evidence` rows are measured facts: the snapshot metrics with the snapshot hash, the reference
  bank median with the bank hash, the verdict rule with its value/threshold/percentile, and (when
  known) the elapsed hours behind a late cumulative snapshot.
- Excluded with a stable reason instead of guessed: `analysis_missing`, `published_text_missing`,
  `published_text_too_long`, `candidate_sha256_invalid`, `post_ids_missing`,
  `analysis_candidate_binding_mismatch`, `analysis_hash_mismatch`, `analysis_causality_claim`,
  `analysis_missing_<field>`, `analysis_bad_confidence`, `analysis_needs_alternative_explanation`,
  `analysis_created_at_missing`, `duplicate_record_id`.
- **Pre-flight uses the real dashboard code**: every record is passed through
  `analysisDigest` + `reviewView` under node. The build fails if any record is not `pending`,
  reports a `bindingIssue`, or hashes to something other than 64 hex. There is no Python
  re-implementation of the digest to drift out of sync.
- Records are byte-stable across rebuilds (timestamps come from the analysis, never `now`), so an
  existing owner approval does not churn.
- `--check` re-derives every record from current artifacts and fails on candidate-document change,
  candidate version change, post-id change, a record that can no longer be built (e.g. an analysis
  file edited after ingest), or any content drift.

`--build` never writes KV. `--publish [API_BASE]` (default `https://jom-content.com`) builds, stores the
local document, then `PUT`s the records to `/api/learning/reviews` with the bearer token from
`jom_api.py` and fails unless the server digests equal the local pre-flight digests, id for id.

## API

All routes sit behind the existing `_middleware.js` gate, so when `JOM_API_TOKEN` is set an
unauthenticated request gets `401 {"error":"unauthorized"}` from the middleware before the handler
runs. The handlers add the owner checks below.

`GET /api/threads-analysis[?id=]`

- Requires the signed owner session (`jc_session`). A bearer token is rejected with
  `403 owner_session_required`.
- Returns `{ success, preview, generatedAt, reviews: [...] }`, newest `createdAt` first.
- Each review contains the allowlisted record, `effectivePost`, `ownerEdited`, `binding`,
  `bindingIssue` (`''` when the binding can reach the host gate), `hash` (64 hex, full),
  `shortHash`, `status` (`pending|approved|revise|rejected`) and `stale`.
- `status` can only be `approved` when the stored decision's hash equals the current hash.

`POST /api/threads-analysis?id=<id>` body `{decision, hash, note}`

- `decision`: `approved`, `revise`, or `rejected`. `revise`/`rejected` require a note of at least
  4 characters (max 1200).
- `hash`: must be the server's current 64-hex digest. Mismatch → `409 stale_hash` plus the current
  hash, and **nothing is written**.
- Rejects bearer-token callers with `403 agent_approval_forbidden` even when the bearer token is
  the valid `JOM_API_TOKEN`.
- Requires `Origin` exactly equal to the request origin (missing or foreign → `403 cross_origin`).
- Requires `JOM_SESSION_SECRET` distinct from `JOM_API_TOKEN`; otherwise
  `503 owner_session_not_configured`. Fails closed when `JOM_API_TOKEN` is unset (`403 lock_off`).
- Stores `{decision, hash, note, decidedBy:"owner", decidedAt, sequence, history[≤20]}` at
  `threads_analysis_decision:<id>`. A later decision is allowed (owner correction) and appended to
  history.

`PATCH /api/threads-analysis?id=<id>` body `{generatedPost}` or `{reset:true}`

- Stores an owner overlay at `threads_analysis_edit:<id>` without mutating the agent record.
- Any PATCH (edit or reset) revokes an existing decision by adding `revokedAt` /
  `revokedReason:"content_edited"`. The digest is recomputed over the overlay and the review reads
  back `stale:true`, `status:"pending"`. Reverting the text with `{reset:true}` restores the old
  hash but **does not** revive the approval; only a new `POST` decision does.

`GET /api/learning/approvals` → signed envelope. `GET /api/learning/approvals?format=key` → public
key file + `pin`.

- Read-only. It can never create, change or revoke a decision: the only writer of
  `threads_analysis_decision:*` is `POST /api/threads-analysis`, which needs an owner session and a
  matching `Origin`. Because it only re-serialises what the owner already stored, a bearer-token
  caller may read it (the host needs that for HTTPS envelope mode) and still cannot approve.
- Fails closed with `503` and **no body envelope** when `JOM_APPROVAL_PRIVATE_KEY`,
  `JOM_APPROVAL_PUBLIC_KEY`, `JOM_SESSION_SECRET`, the API lock, or the post-signing self-check is
  missing or fails (`approval_signing_key_unavailable`, `approval_public_key_unavailable`,
  `owner_session_not_configured`, `lock_off`, `approval_envelope_self_check_failed`, …).
- `405` for any method other than `GET`; `400 invalid_format` for an unknown `format`.

### Envelope shape

```json
{
  "schema": "threads-learning-approval-envelope/v1",
  "key_id": "owner-2026-11",
  "issuer": "jom-content-dashboard",
  "issued_at": "2026-11-13T02:00:00.000Z",
  "approvals": [{"approval_id": "ap-…", "candidate_id": "tl-…", "candidate_sha256": "…",
                 "analysis_sha256": "…", "post_ids": ["…"], "decision": "approved | rejected",
                 "approved_at": "…", "expires_at": null, "note": "…",
                 "review_id": "ana-…", "review_sha256": "…", "decision_sequence": 1}],
  "revocations": [{"approval_id": "ap-…", "review_id": "ana-…", "revoked_at": "…"}],
  "excluded": [{"review_id": "ana-…", "reason": "approval_revoked_by_edit | content_changed_since_decision | owner_requested_revision | binding_<problem>"}],
  "counts": {"records": 3, "approvals": 1, "rejected": 0, "revocations": 0, "excluded": 1, "pending": 2},
  "provenance": {"source": "jom-content-dashboard", "review_schema": 2, "digest": "sha256",
                 "decisions": "owner_session_only", "generated_by": "functions/_lib/approval-envelope.js"},
  "signature_b64": "…"
}
```

- `signature_b64` is Ed25519 over the canonical UTF-8 JSON (sorted keys, compact separators, no
  ASCII escaping) of the envelope minus `signature_b64`.
- `approval_id` is `ap-` + the first 32 hex of `sha256(review_id + "\n" + review_sha256 + "\n" +
  sequence)`. Re-approving after a revoke yields a **new** id; the old id appears in `revocations`,
  so replaying an old envelope cannot resurrect an approval.
- Pending reviews are absent (`counts.pending` only). `revise` and binding-less approvals are
  listed in `excluded` and never in `approvals`. Rejections are transported as `decision:"rejected"`
  so the host can exclude them by name.
- Signed values are strings, integers, booleans, `null` and arrays/objects of those. **No floats**
  in the signed payload, so JS and Python format every number identically.

### Integration rule (host learning / any future consumer)

Use the API view, not the raw KV decision:

```js
import { isApproved } from './_lib/analysis-review.js';
isApproved(view) // view.status === 'approved' && !view.stale && decision.hash === hash
```

A decision record read straight from KV must still be compared against a freshly recomputed
digest. Never treat `decision.decision === 'approved'` alone as valid. `isApproved` deliberately
does not consider `bindingIssue`: a binding-less approval is a real owner review that simply cannot
become an N0 lesson.

## Host gate contract

`threads_learning_review.gate()` (CLI: `--gate`) emits `review/n0/approved-lessons.json` with
`lessons: []` and `status != ok` unless **all** of the following hold:

1. `OWNER_KEY_FINGERPRINT` is set (reviewed constant) and equals the fingerprint of
   `review/approvals/owner-public-key.json`; optional `pinned.json` must agree.
2. The envelope signature verifies against that key, `key_id` matches, `issued_at` is not in the
   future and not older than 14 days.
3. Every entry's `candidate_sha256` and `post_ids` equal the current candidate record exactly, and
   `analysis_sha256` names an existing analysis file whose stored and recomputed hash both match.
4. The entry is not in `revocations`, is not `decision:"rejected"`, is not expired, and
   `approved_at` is not in the future.
5. `analysis.causality == "not_established"`.
6. No rejected entry covers the same `(candidate_id, analysis_sha256)` — an owner rejection of that
   exact analysis version removes the lesson entirely (fail closed, not last-write-wins). A
   corrected analysis is a new `analysis_sha256` and is unaffected.
7. Candidates that have an analysis but no surviving approval are reported as
   `no_owner_approval`; nothing falls back to `ledger.jsonl`.

### Approved-only consumer (`--consumer`)

`python3 ~/.hermes/scripts/threads_learning_review.py --consumer` prints
`{schema: threads-n0-consumer/v1, ready, gate_status, lesson_count, lessons, errors,
excluded_by_reason, source{path,sha256,document_sha256,generated_at}, fallback, contract}`.

- exit `0` only when the stored N0 document self-checks and the gate is ready;
- exit `2` with `ready:false, lessons:[]` when the gate is blocked or the document was tampered;
- `fallback` states that `ledger.jsonl`, `latest.md` and unapproved analyses are never a lesson
  source. This is the command a cron step can call instead of reading raw learning.

### Local bridge rehearsal (no deploy, no production write)

```bash
python3 ~/.hermes/scripts/tests/test_approval_bridge_e2e.py   # envelope/gate semantics
python3 ~/.hermes/scripts/tests/test_review_ingest_e2e.py      # real candidates -> dashboard -> N0
```

It starts `preview/server.mjs` with a generated seed and an ephemeral Ed25519 key, logs in as the
owner, approves, fetches the signed envelope, verifies it with `threads_owner_approval`, writes a
throwaway N0 document in a temp learning base, then proves the negative cases: pending excluded,
rejection excluded, binding-less excluded, approve+reject conflict excluded, mutation revokes,
tampered envelope blocked, forged signature blocked, wrong pin blocked, and JS↔Python canonical
JSON parity.

The temp base copies the real `review/candidates/LATEST.json` and symlinks `snapshots/` read-only,
so the real candidate/evidence hashes are exercised without writing to the production learning
directory.

## Local preview (no deploy)

```bash
cd /home/hamiddi/projects/jom-content
node preview/server.mjs                # http://localhost:8788/analysis-review.html
node preview/server.mjs --port 0       # any free port, printed on start
```

- Preview-only credentials (local process, not committed):
  `JOM_LOGIN_USER=jomdigital`, `JOM_LOGIN_PASSWORD=preview-only`.
  Override with environment variables for a different local password.
- KV is in-memory and reseeded on every start: `preview/analysis-seed.json` by default, or
  `PREVIEW_SEED=<path>` — use
  `python3 ~/.hermes/scripts/threads_review_ingest.py --seed <path>` to seed **real** ingested
  records instead of the curated demo. Decisions and edits disappear when the process stops.
- On start the server prints a binding census (`bound=N …`) and warns when seeded records cannot
  reach the host gate; the curated demo seed's binding digests are demo values, so those cards are
  reviewable UI examples only.
- A throwaway Ed25519 keypair is generated on every start (`JOM_APPROVAL_PRIVATE_KEY` /
  `JOM_APPROVAL_PUBLIC_KEY` override it for a fixed test key). The public half and `pinned.json`
  are written to `preview/out/approvals/` (git-ignored) and the fingerprint is printed. This key is
  **not** the owner's production key.
- The page shows a demo banner because the preview sets `ANALYSIS_PREVIEW=1`.
- The preview runs the real `_middleware.js`, login/session/logout, review and envelope handlers.
  It does not route `threads-publish`, `social-publish`, or `posts`; the review page never calls
  them.
- `preview/` is **not** in the `.github/workflows/deploy.yml` staging list (that job copies an
  explicit file list into `.deploy`), so a future deployment cannot publish the preview server or
  seed data by accident. `cp -R functions` does pick up `functions/api/learning/approvals.js`,
  which is safe: without the signing env it returns `503`.

The production Cloudflare Pages preview (when approved) would be:

```bash
npx wrangler pages dev . --kv JOM_CONTENT \
  --binding JOM_API_TOKEN=… --binding JOM_SESSION_SECRET=… \
  --binding JOM_LOGIN_PASSWORD=… \
  --binding JOM_APPROVAL_PRIVATE_KEY=… --binding JOM_APPROVAL_PUBLIC_KEY=… \
  --binding JOM_APPROVAL_KEY_ID=owner-2026-11
```

Seed `threads_analysis_reviews` in that local KV from the agent output before opening the page.
Do not seed or alter production KV as part of this change.

## Tests

```bash
cd /home/hamiddi/projects/jom-content
node --test tests/threads-analysis-review.test.mjs     # API, auth, hash, stale decisions
node --test tests/threads-analysis-approvals.test.mjs  # envelope signing, exclusions, revocation
node --test tests/analysis-review-browser.test.mjs     # Chromium at 375px + preview server
node --test "tests/*.test.mjs"                          # full suite (95 tests)

python3 ~/.hermes/scripts/tests/test_approval_bridge_e2e.py   # 50-check envelope/gate rehearsal
python3 ~/.hermes/scripts/tests/test_review_ingest_e2e.py      # 62-check real-candidate end-to-end
python3 -m pytest ~/.hermes/scripts/tests/test_threads_review_ingest.py -q   # ingestion rules
python3 -m pytest ~/.hermes/scripts/tests/test_threads_learning_review.py -q # gate unit tests
```

Browser/runtime test prerequisites: run `npm install` once at the repo root (dev-only `playwright-core`
and `miniflare`, see `package.json`; nothing is deployed). Chromium comes from `CHROMIUM_PATH` or the
newest `~/.hermes/tools/chromium-*` / `~/.cache/ms-playwright/chromium-*` (`tests/helpers/tools.mjs`).
The Python rehearsal needs `cryptography` and `node` on PATH.

What the tests prove:

- no session, a forged session signed with the API token, or a bearer token cannot read or decide;
- a valid bearer token is explicitly rejected from approving, but may read the envelope;
- missing/foreign `Origin` is rejected and storage stays untouched;
- approving with a wrong or stale hash writes nothing;
- every reviewable field — post, classification, source, metrics, comparison, evidence,
  observation, hypotheses, confidence, suggestion, binding — changes the digest;
- object key order does not change the digest, and JS/Python canonical JSON + SHA-256 agree;
- editing changes the hash, flips the status to pending/stale, and revokes the old decision;
- resetting the edit restores the original hash but the old decision stays revoked until a new
  explicit approval;
- revise/reject require a note; decision history keeps each hash;
- responses never include extra record fields or server secrets;
- the envelope is absent (503) when the signing key is missing, and never partially signed;
- pending reviews are excluded, rejections are transported as rejected, and binding-less approvals
  are excluded with `binding_candidate_id_missing`;
- the host verifies the signature, rejects a tampered payload and a forged signature, and refuses
  the preview pin on the production base;
- mutation removes the lesson and re-approval issues a new approval id while the old one stays
  revoked;
- the real page renders all sections including the binding, downloads the exact envelope, fits
  375px, shows the login gate without a session, and makes zero publishing calls.

`test_review_ingest_e2e.py` additionally proves, against the **real** candidate document
(`review/candidates/LATEST.json` copied, real snapshots symlinked, real `state.json` text):

- ingestion emits one record per candidate that has an analysis version and excludes the rest with a
  reason instead of inventing content;
- `generatedPost` is byte-identical to the published text, and the binding carries the exact
  candidate hash, analysis hash and ordered post ids;
- the real dashboard serves every ingested record as `pending` with no binding issue, and its digest
  equals the ingest pre-flight digest;
- owner approve/reject/pending decisions become exactly the approved lessons, nothing else;
- an analysis file edited after approval loses exactly that lesson (`analysis_hash_mismatch`) while
  the other approved lessons survive, and restoring the file restores the lesson;
- an edited post revokes its approval (envelope revocation + `stale_hash` replay refusal) and
  re-approval issues a new approval id;
- a tampered envelope payload and a forged signature both yield zero lessons;
- `--consumer` (`threads_learning_review.py --consumer`) returns approved lessons only and refuses a
  blocked gate or a tampered N0 document instead of falling back to `ledger.jsonl`;
- the production base still refuses the preview pin and still emits zero lessons.

## Production blockers

These are open. Nothing below was changed by this work.

1. **No analysis versions exist on the host.** `review/analyses/` is absent, so ingestion honestly
   emits 0 reviewable records (20 candidates excluded as `analysis_missing`). The agent has to
   attach real analysis versions first (`threads_learning_review.py --attach-analysis`).
2. **Resolved 2026-11-25: production ingestion write path.** `PUT /api/learning/reviews` (bearer only,
   records only) plus `threads_review_ingest.py --publish`. Previously: `threads_analysis_reviews` is written by nothing: the
   dashboard has no agent-authenticated ingest route (by design — an agent must never approve), and
   `threads_review_ingest.py` therefore only emits JSON. Production needs one of: a wrangler KV put
   from the host, or a token-authenticated ingest route that can write records but never decisions.
3. **`OWNER_KEY_FINGERPRINT` is still empty** in `threads_learning_review.py`, so `--gate` returns
   `blocked_owner_key_fingerprint_not_pinned` and N0 stays empty. Pinning requires the real owner
   fingerprint from the deployed dashboard; a local/unverified key must not be pinned.
4. **No signing key material in production.** Without `JOM_APPROVAL_PRIVATE_KEY` /
   `JOM_APPROVAL_PUBLIC_KEY` / `JOM_APPROVAL_KEY_ID` the envelope route is a `503` and the gate has
   nothing to verify.
5. **The production cron still reads unapproved raw learning.** Two jobs are unchanged:
   - `89248e67d5cc` *Threads Daily Topic + Calendar Populate - 7:30AM* reads
     `learning/latest.md` and the newest 3–6 `learning/ledger.jsonl` entries;
   - `54212c6e1eb3` *Threads post-publication learning loop* reads `learning/latest.md`.

   The approved-only replacement for that section is one command, run and verified locally:
   `python3 ~/.hermes/scripts/threads_learning_review.py --consumer` (exit 0 with lessons, exit 2
   when the gate is blocked, `fallback: forbidden`). Switching the prompts is an owner decision and
   was **not** performed here.
6. **Not deployed.** Pages is unchanged; `analysis-review.html`, `analysis-review.js`,
   `functions/api/threads-analysis.js`, `functions/api/learning/approvals.js` and
   `functions/_lib/approval-envelope.js` are all untracked local files.

## Deployment steps (not done)

1. Add `JOM_SESSION_SECRET` (distinct from `JOM_API_TOKEN`) to the Pages project. This invalidates
   existing dashboard sessions.
2. Ensure the agent writes `threads_analysis_reviews` only. It must never write
   `threads_analysis_decision:*`; only the session-authenticated handler does.
3. Generate the owner Ed25519 keypair **off** the host that runs agents, store the private half as
   the Pages secret `JOM_APPROVAL_PRIVATE_KEY` (base64 PKCS#8 or a base64 32-byte seed), and
   `JOM_APPROVAL_PUBLIC_KEY` (base64 raw 32 bytes or SPKI). Set `JOM_APPROVAL_KEY_ID`.
   Without these the route stays a 503 and the gate stays blocked.
4. Publish the public key to the host: `curl -b <owner session> https://…/api/learning/approvals?format=key`,
   save `key` as `review/approvals/owner-public-key.json` and `pin` as `pinned.json`, then set
   `OWNER_KEY_FINGERPRINT` in `threads_learning_review.py` to that fingerprint (reviewed code
   change). **This step is outstanding: the constant is still empty, so `--gate` blocks.**
5. Deploy the Pages project after owner preview approval. Add `analysis-review.html` and
   `analysis-review.js` to the explicit `cp` staging list in `.github/workflows/deploy.yml`;
   `functions` is copied recursively, which includes the new `learning/approvals` route. Do not add
   `preview/`.
6. Smoke test on the deployment: login → open review → approve → refresh (still approved) → fetch
   the envelope (1 approval, exact digests) → run `--gate` against a cached envelope and see one
   lesson → edit the post (envelope loses the approval, gains a revocation, gate returns 0 lessons)
   → replay the old hash (409). Confirm an agent bearer request to `POST /api/threads-analysis` gets
   403 and that `/preview/server.mjs` is not served.

## Honest limits

- KV is not transactional. Two simultaneous owner decisions can last-write-wins; each is still
  bound to the content hash it was made against. A decision racing an edit can be stored for the
  pre-edit hash and will read back as stale, which fails closed.
- Approval has no expiry. It stays valid until the content changes, an edit revokes it, or the
  owner decides again.
- The owner can change a decision (including re-approving after rejecting). This is deliberate for
  correcting mistakes; history keeps the sequence. A rejection of an exact analysis version blocks
  that version even if a second review record approves it — the owner must attach a corrected
  analysis (new hash) instead.
- The digest covers the fields in `reviewContent` only. New reviewable fields need a schema bump.
- Owner edits are a single overlay keyed by analysis id. There is no per-owner attribution or
  merge conflict handling because there is one owner session.
- Envelope `excluded`/`counts` are signed but advisory; the host derives its own exclusions and
  never trusts the dashboard's list.
- Signature verification proves which exact bytes the dashboard key approved; it does not prove the
  analysis is semantically good. That remains an owner judgement.
- The preview signing key is ephemeral and throwaway. The host accepts it only through the explicit
  `gate(owner_fingerprint=…)` rehearsal argument, which raises
  `approval_pin_argument_forbidden_on_production_base` on the production learning base and is never
  reachable from the CLI.
- An operator who can edit `threads_learning_review.py` (or run as root) can re-pin a different key.
  The pin raises the bar from "write a JSON file" to "change reviewed code"; it is not a defence
  against full host compromise.
- The curated `preview/analysis-seed.json` bindings are demo digests, not real host analyses, so the
  host gate would never emit them (`candidate_not_found`). The preview server prints a binding
  census on start to keep that visible. Real records come from
  `threads_review_ingest.py --seed`, which is what both end-to-end rehearsals use.
- Ingestion classifies a candidate from its verdict rule, not from a judgement of post quality; a
  `losing` candidate is only "losing" relative to the eligible own reference median, which admits
  roots with >= 15 likes by construction.
- An approval covers the record as ingested. If the agent attaches a new analysis version, the
  record changes, the digest changes, and the owner must approve again — the old approval is not
  carried over (it appears as `content_changed_since_decision`).
- `analysis-review.html` is linked from `analytics.html` only, not from `index.html`.
- The UI has no attachment upload/screenshot evidence; evidence is text + URL.
- No deploy, no production KV write, no Threads API call, and no schedule change is performed by any
  of these files.
