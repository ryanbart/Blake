# Blake — conversation intelligence + CRM autofill

Ingests customer conversations from **Dialpad** (calls) and **Fellow** (meetings),
analyzes them with Claude plus a deterministic rules layer, and turns the result
into coaching feedback, issue flags, customer themes, and — from Phase 3 —
Salesforce field updates a rep approves in one click.

**Phase 1 (Dialpad + coaching UI) is built.** Fellow and Salesforce are planned;
see [Status](#status).

---

## Quick start

No credentials required — the whole app runs on mock transports and seeded data.

```bash
npm install
cp .env.example .env          # then generate a key, see below
npm run db:up                 # local Postgres 16 in ./.pgdata
npx prisma migrate deploy
npm run seed                  # 12 agents, 400 calls, 90 days
npm run analyze               # scores, flags, themes
npm run dev                   # http://localhost:3000
```

Generate the token-encryption key that `.env` needs:

```bash
echo "TOKEN_ENCRYPTION_KEY=\"$(openssl rand -base64 32)\"" >> .env
```

Check everything is wired up at any time:

```bash
npm run verify
```

### Tests

Tests run against a **separate** database and refuse to start if it matches the
development one — the provenance suite truncates every table between tests, and
pointed at your dev database that would silently destroy your seeded data.

```bash
npm run db:test:setup
npm test
```

---

## How it works

```
Dialpad ──webhook / stats CSV──┐
                               ├──► Conversation + Transcript ──► Analysis
Fellow  ──webhook / REST───────┘         (Postgres)              (Claude + rules)
                                                                       │
                                    ┌──────────────────────────────────┤
                                    ▼                                  ▼
                           Coaching & dashboards              Proposed Actions
                                                                       │
                                                          Autonomy Policy Engine
                                                                       │
                                                    ┌──────────────────┴────────┐
                                                    ▼                           ▼
                                            approval queue              auto-execute
                                          (human authorizes)          (policy permits)
                                                    └──────────┬────────────────┘
                                                               ▼
                                                     immutable Audit Log
```

Two abstractions carry the design:

**`Conversation`, not Call.** A Dialpad call and a Fellow meeting normalize into
one record with a `source` discriminator, so coaching, themes, and CRM extraction
are written once and work for both.

**`Action`, not CrmWrite.** A Salesforce field update, a task, a drafted email,
and an internal alert are the same shape — something proposed, authorized, and
executed, each by a recorded actor. The CRM review queue is that queue filtered,
which is what makes "eventually the AI sends the email" an added executor rather
than a second system.

### Provenance: three questions, not one

Every mutating record answers three separate questions as three columns:

| Slot | Question | Example |
|---|---|---|
| `proposedByActorId` | Who originated it | AI agent on `claude-opus-5` |
| `authorizedByActorId` | Who permitted it | A named rep, or a policy rule |
| `executedByActorId` | Who carried it out | That rep's Salesforce connection |

An AI-drafted, human-approved, system-executed action has three different
answers. A null `authorizedBy` is load-bearing: the autonomy gate refuses to
execute without one.

AI actors are keyed on `(model, promptVersion)`, so editing a prompt mints a new
actor rather than relabelling past proposals — otherwise you lose exactly the
information needed to explain a year-old suggestion.

### Safety defaults

- **Kill switch on by default** (`AUTOMATION_KILL_SWITCH=true`). No autonomous
  execution until you turn it off deliberately.
- **The gate fails closed.** Unknown action type, disabled policy, missing
  approval, or engaged kill switch all deny. Blocked work stays *queued*, not
  failed — "not permitted yet" is not "wrong".
- **Audit log is append-only**, enforced by a Postgres trigger rather than
  convention. Row `UPDATE` and `DELETE` both raise.
- **Sensitive CRM fields** (Amount, StageName, CloseDate) always require a human.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run db:up` / `db:down` | Start/stop local Postgres 16 |
| `npm run seed` | Seed agents, conversations, transcripts, reference data |
| `npm run sync` | Backfill from Dialpad (`-- --days 30`) |
| `npm run analyze` | Analyze pending conversations (`-- --force`, `-- --limit 5`) |
| `npm run verify` | Check credentials and connectivity |
| `npm test` | Test suite (96 tests) |

## Configuration

See `.env.example`. The three `*_TRANSPORT` variables select mock vs live per
integration, and all default to `mock` so nothing calls out by accident.

**Without `ANTHROPIC_API_KEY`** the app falls back to a deterministic heuristic
analyzer so the dashboard still fills in. Its output is labelled `heuristic` in
the UI and is pattern matching, not judgment — it exists so the app can be
developed and evaluated without credentials, not as a substitute for analysis.

---

## Going live

Run these in order; each is verifiable on its own.

1. **Dialpad.** Set `DIALPAD_API_KEY` and `DIALPAD_TRANSPORT=live`, then
   `npm run verify -- --dialpad`. It prints live responses next to what the
   mappers expect, so a field-name drift is visible immediately.

   > Vendor documentation sites are unreachable from the environment this was
   > built in, so the API shapes are written defensively — tolerant parsing, one
   > isolated mapper per endpoint. Correcting a field name is a one-line change
   > in `src/lib/dialpad/types.ts`.

   **If transcripts return 403/404**, Dialpad Ai is not on the plan. Calls still
   ingest with metadata and recording links, but coaching analysis needs
   transcripts and the UI will say so rather than showing empty scorecards.

2. **Webhooks.** Register a webhook with Dialpad, put its secret in
   `DIALPAD_WEBHOOK_SECRET`, and point the subscription at
   `POST /api/dialpad/webhook`. Payloads are HS256-signed JWTs; anything that
   fails verification is rejected before it reaches the database.

3. **Claude.** Set `ANTHROPIC_API_KEY` and run `npm run analyze -- --limit 5`.
   Confirm `cache_read_input_tokens` is non-zero from the second call onward —
   the CLI warns if it is not, which is the symptom of per-call content leaking
   into the cached prompt prefix.

4. **Nightly backfill.** Schedule `npm run sync`. The window deliberately
   overlaps what webhooks already delivered; ingest is idempotent on
   `(source, sourceId)`, so re-covering a day is free and dropped deliveries heal.

---

## Status

| Phase | State |
|---|---|
| **1 — Foundation + Dialpad + coaching UI** | Built |
| 2 — Fellow ingestion | Planned |
| 3 — Salesforce OAuth, matching, review queue | Planned |
| 4 — Outbound email + internal notifications | Planned |

Built in Phase 1: provenance schema, autonomy policy engine, append-only audit
log, Dialpad client (mock + live), rules engine, Claude analysis with structured
output and heuristic fallback, idempotent ingest, webhook receiver, CLIs, and the
dashboard (overview, conversations, conversation detail, agents, themes, rules,
audit).

Not yet built: editing rules from the UI, the CRM review queue (the panel exists
and is empty), Fellow ingestion, and any Salesforce write path.

---

## A few things worth knowing

**Coaching scores are advisory.** They come from automated transcript analysis
and are labelled as such throughout the UI. Using them for performance decisions
without reading the underlying calls is a bad idea, and the interface says so
where scores appear.

**Recording and transcription is legally sensitive.** Consent requirements vary
by state and country, and this stores transcripts and verbatim quotes. You own
the consent and retention policy.

**AI voice calls and SMS are deliberately out of scope.** The action layer could
accommodate them, but AI-generated voice in outbound calling falls under TCPA
robocall rules in the US and SMS carries its own consent regime. Those are a
legal project before an engineering one.
