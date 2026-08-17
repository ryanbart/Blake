# Connecting live Dialpad

Everything in this repo runs on mock data with no credentials. This document is
for the step after that: pointing it at a real Dialpad account.

**Run this on your own machine.** The API key reads call recordings and
transcripts of real customer conversations — it is a credential *and* a key to
other people's data. Don't paste it into a chat, a ticket, or a shared terminal.

---

## Why this step exists

The Dialpad API mappings in `src/lib/dialpad/types.ts` were written **without
access to the documentation** — developers.dialpad.com is unreachable from the
environment this was built in. The field names come from prior knowledge and
search results, so they are educated guesses, isolated deliberately: one mapper
per endpoint, tolerant parsing, nothing that fails the whole sync on one bad row.

`npm run verify -- --dialpad` is how you find out whether those guesses were
right. A wrong field name shows up here as a `null` or a 1970 date, and it is a
one-line fix once you know the real name.

---

## Path 1 — Credential check only

**No database, no Postgres install.** About two minutes.

```bash
git clone -b claude/dialpad-api-coaching-ui-3nmqai https://github.com/ryanbart/Blake
cd Blake
npm install
cp .env.example .env
```

Edit `.env` and set two values:

```ini
DIALPAD_API_KEY="your-key-here"
DIALPAD_TRANSPORT="live"
```

Then:

```bash
npm run verify -- --dialpad --redact --dump
```

`--redact` masks names and emails. `--dump` prints the raw field names Dialpad
returned beside the ones the mappers expect. Between them the output is safe to
share and sufficient to diagnose drift.

### What you should see

```
  ✓  dialpad.users          12 users, 12 with an email. Sample: R. A.<r***@unitedmh.com>, …
  ✓  dialpad.calls          37 calls. Field check on the first row: startedAt=2026-08-15T… duration=140s …
  ✓  dialpad.transcripts    available — 42 lines on call 8891. Speaker labels seen: agent, external
```

### What each failure means

| Symptom | Cause | What to do |
|---|---|---|
| `dialpad.users` fails with 401 | Bad or expired key | Regenerate in Dialpad admin |
| `startedAt=1970-01-01`, `duration=0`, or `direction=unknown` | A field was renamed | Send me the `--dump` output |
| `dialpad.transcripts` warns "unavailable" | Dialpad Ai not on the plan | Coaching analysis needs transcripts — see below |
| `stats export succeeded but returned no calls` | Empty window, not a failure | Fine if the account is quiet |

**Send me:** the whole output block, with your reps' names and emails scrubbed
(`--redact` does this for you). Everything else — counts, durations, field names,
speaker labels — identifies nobody and is exactly what makes a fix possible.

**Never send:** the API key itself, or anything from `npm run sync`, which
contains real customer conversation content.

---

## Path 2 — The full app locally

Adds the database, seeded data, and the dashboard.

**Prerequisites:** Node 20+, Postgres 16, and on Windows, WSL — `scripts/dev-db.sh`
is bash and uses Unix domain sockets.

```bash
# macOS
brew install postgresql@16

# Debian/Ubuntu
sudo apt install postgresql-16
```

You do not need to configure Postgres. `npm run db:up` creates a cluster inside
the repo at `.pgdata/` on port 5433, so it cannot collide with an existing
install and `npm run db:down` / `bash scripts/dev-db.sh nuke` disposes of it.

```bash
npm run db:up
npx prisma migrate deploy
npm run seed                  # 12 agents, 400 mock calls, 90 days
npm run analyze               # scores, flags, themes
npm run dev                   # http://localhost:3000
```

That gives you the whole product on mock data. To pull **real** calls:

```bash
npm run sync -- --source dialpad --days 1
```

Start with `--days 1`. That command downloads real customer transcripts onto
whatever machine runs it — a narrow first window lets you confirm the shape is
right before pulling ninety days of other people's conversations onto a laptop.

Ingest is idempotent on `(source, sourceId)`, so widening the window later
re-covers the same days for free rather than duplicating them.

---

## If Dialpad Ai is not on your plan

`GET /transcripts/{call_id}` returns 403 or 404 and `verify` says so explicitly.

Calls still ingest with metadata and recording links, and the UI says "no
transcript" rather than showing an empty scorecard. But coaching scores, flags,
themes, and CRM extraction all read the transcript — without it, most of this
product has nothing to work with.

Two options: add Dialpad Ai, or lean on Fellow for transcript-based coaching and
treat Dialpad as volume and metadata. Fellow meetings already flow through the
same pipeline, so the second option needs no code changes.

---

## Real-time ingest (optional)

Backfill alone is enough to evaluate this. When you want live updates:

1. Register a webhook in Dialpad pointing at `POST /api/dialpad/webhook`.
2. Put the returned secret in `DIALPAD_WEBHOOK_SECRET`.

Payloads are HS256-signed JWTs. Anything that fails verification is rejected
before it reaches the database, and the algorithm is pinned so a token cannot
downgrade itself to `alg: none`.

Webhooks and the nightly `npm run sync` are meant to overlap — idempotent ingest
means a dropped delivery heals on the next backfill.

---

## A note on what this stores

Transcripts and verbatim quotes, including customers' words. Recording and
transcription consent requirements vary by state and country. You own the
consent and retention policy; this repo does not decide it for you.
