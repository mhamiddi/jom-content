# Jom Content Topic Bank

## Purpose

Persist every curated daily Threads topic suggestion and let Hamiddi review the suggestion outcome after publication.

## Canonical flow

1. The 7:30AM Threads suggestion cron reads the existing voice/content banks and 14-day performance data.
2. It produces 3-5 curated topic records.
3. `save-daily-topic-suggestions.py` writes every record to the local append-only archive at `~/.hermes/content_bank/daily_suggestions.jsonl` and syncs the batch to `POST /api/topics`.
4. Cloudflare Pages KV key `topic_bank` is the dashboard source of truth for interactive feedback.
5. `topics.html` renders the bank, grouped by suggestion date, with filters, thumbs up/down feedback, feedback notes, and published-state tracking.

## Topic record

```json
{
  "id": "stable-run-id-rank-hash",
  "runId": "cron-run-or-date",
  "suggestedDate": "YYYY-MM-DD",
  "suggestedAt": "ISO-8601",
  "rank": 1,
  "topic": "Short topic title",
  "angle": "The proposed angle",
  "pillar": "Hermes Agentic AI",
  "why": "Why this fits, grounded in the source data",
  "source": "@handle or own performance data",
  "sourceUrl": "https://...",
  "pattern": "Reality Check",
  "hook": "Optional spoken hook",
  "feedback": null,
  "feedbackNote": "",
  "published": false,
  "publishedAt": null,
  "publishedUrl": "",
  "contentNote": "",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

## Interaction contract

- `👍` sets `feedback=up`.
- `👎` sets `feedback=down` and keeps a note explaining what failed or should change.
- Feedback is reversible. Clicking the active thumb clears it.
- `Tanda published` sets `published=true`, records the current time, and optionally stores the final post URL.
- `Undo published` clears the published state without deleting the topic or its feedback history.
- Topic records are never deleted from the dashboard; they remain part of the learning archive.

## API

- `GET /api/topics` supports `date`, `feedback`, `published`, `pillar`, and `q` filters.
- `POST /api/topics` accepts `{runId, suggestedDate, topics:[...]}` and idempotently upserts by `id`.
- `PUT /api/topics?id=<id>` updates feedback, notes, and publication state.
- Storage is isolated from the existing `posts` key in the same `JOM_CONTENT` KV namespace.

## Compatibility

The existing TikTok/Threads post calendar remains unchanged. A new `Topic Bank` link opens `topics.html`. Deployment is intentionally separate from this local implementation and requires the normal preview/user-approval gate.
