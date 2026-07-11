# Ashby Pipeline Extraction — Architecture & Handoff

**Audience:** an engineer re-implementing this feature in Parker (`parker.candidatelabs.com`).
**Subject:** the *cloud-hosted* Ashby integration that powers the Recruitment Coordinator
(Lovable) app — how candidate pipeline data is pulled from Ashby, kept fresh, stored, and shown.

This document describes the **cloud architecture as it exists today**. It does not prescribe how
Parker should build it. Where the design has sharp edges worth knowing before you copy it, they're
called out in **§10 Gotchas**.

> Source repos this describes:
> - **App / frontend + edge functions:** `github.com/kimbidav/recruitment-coordinator-lovable` (React + Vite; Supabase edge functions in Deno).
> - **Extractor service:** `~/Documents/Ashby-automation` (TypeScript/Node + Express, deployed to Railway as `ashby-automation-production`). This is the only component that talks to Ashby.

---

## 1. What the feature does (product behavior)

The dashboard shows every candidate Candidate Labs has in an Ashby pipeline across **all client
orgs** (~60), each recruiter filtered to the candidates credited to them. For each candidate it
shows company, role, current stage, stage progress (e.g. "3/5"), days in stage, decision status,
and a full interview timeline (interviewer, date, score, and scorecard feedback text).

The user-facing surface is one button in the header:

- **"Sync from Ashby"** — pulls the latest pipeline. Progress shows live ("Syncing 12/60 orgs…").
  On completion the table refreshes. A sweep takes roughly 2–20 minutes depending on Ashby's
  responsiveness.
- When the shared session has expired, the same button becomes **"Reconnect Ashby"** and an
  org-wide amber banner appears. Any teammate can reconnect by pasting their own
  `ashby_session_token` from browser DevTools — it fixes the connection for the whole team.

Key product properties that drive the architecture:

- **One shared team session, not per-user.** Ashby has no per-user API key for external recruiters,
  so the whole team shares a single browser session that the extractor keeps alive. See §3.
- **Org-shared snapshot.** A sync writes to one org-wide table that everyone reads; the app filters
  per-user by `credited_to`. One person's sync updates data for the whole team.
- **Accumulate, never lose.** A sync merges into the stored snapshot rather than replacing it, so a
  partial sweep (some orgs failed) never wipes previously-good data. See §6.
- **Archive/hired inference.** When a candidate who was in the active pipeline stops appearing, the
  system verifies *why* (Hired vs Archived) and stamps them, rather than silently dropping them.

---

## 2. System topology

Three tiers. Data flows **Ashby → Extractor → Supabase → Browser**; the browser never touches
Ashby or the extractor directly.

```
┌────────────┐   supabase.functions.invoke("ashby-sync")   ┌──────────────────────┐
│  Browser   │ ───────────────────────────────────────────▶│  Supabase edge fn    │
│  (React)   │◀─────────────── fetch_jobs row ──────────────│  ashby-sync (Deno)   │
└────────────┘   reads ashby_snapshot_candidates (RLS)      └──────────┬───────────┘
      ▲                                                                 │ X-Extractor-Secret
      │ reads snapshot tables via PostgREST                             ▼
┌─────┴───────────────────────┐                          ┌──────────────────────────┐
│  Supabase Postgres          │                          │  Railway extractor        │
│  • ashby_snapshot_candidates│◀── service-role upsert ──│  Express server.ts :3001  │
│  • ashby_orgs               │    (edge fn only)         │  • holds shared session   │
│  • ashby_connection         │                          │  • /api/extract/start …   │
│  • fetch_jobs               │                          └──────────┬────────────────┘
└─────────────────────────────┘                                     │ session cookie replay
                                                                    ▼
                                                          ┌──────────────────────┐
                                                          │  Ashby internal      │
                                                          │  GraphQL API         │
                                                          │  app.ashbyhq.com     │
                                                          └──────────────────────┘
```

**Why the middle tier (edge function) exists:** a full sweep takes 15–20 min, far longer than an
edge function (or an HTTP request) can stay open. So the extractor runs the sweep as an **async
job**, and the edge function is a thin, repeatedly-called **poller/advancer** that moves a
`fetch_jobs` row forward and, on completion, does the server-side merge into the snapshot. The
browser drives the loop by calling the edge function every 5 seconds.

**Why the extractor is separate from Supabase:** it needs a long-lived process, a persistent
Playwright browser profile / durable session file on a volume, and the ability to run a 20-minute
job — none of which fit an edge function.

---

## 3. Authentication (the hardest part)

Ashby exposes no official API key for external recruiting agencies. The extractor authenticates by
**replaying a real browser session cookie** (`ashby_session_token`) against Ashby's **internal,
non-public GraphQL API** at `https://app.ashbyhq.com` — the same API the Ashby web UI uses.

### The shared session lifecycle

1. **Seed (≈ weekly).** A teammate opens Ashby, copies `ashby_session_token` from DevTools, and
   pastes it into the Reconnect dialog. The app calls `ashby-sync {action:"seed", cookie}`, which
   forwards to the extractor's `POST /api/session/seed`. The extractor verifies the cookie against
   `GET /api/csrf/token`, and on success persists it to `ASHBY_SESSION_FILE` (a Railway **volume**,
   e.g. `/data/ashby-session.json`) so it survives redeploys/restarts.
2. **Rotation (every few minutes, automatic).** Ashby rotates `ashby_session_token` via
   `Set-Cookie` on nearly every request. The extractor mirrors each rotation back into its
   in-memory session and persists the new token to the volume (`persistSessionCookies` in
   `session.ts`, wired through `session.onCookiesRotated`). So the stored chain descends from the
   seed and stays live *without re-seeding* — the login-day token itself goes stale within minutes,
   but the rotation chain keeps the session usable up to Ashby's hard login expiry (~7 days).
3. **Expiry (≈ weekly, at Ashby's login TTL).** When the chain finally dies, extractor calls 401.
   The edge function flips `ashby_connection.status = 'expired'`, the banner appears, and any
   teammate re-seeds. The cycle repeats.

### CSRF

Every write/switch needs a fresh CSRF token from `GET /api/csrf/token`, sent as the `x-csrf-token`
header. The token must be refreshed **after every org switch** (see §4) — the old token is invalid
in the new org context.

### Shared-secret gate

The extractor's `/api/extract`, `/api/applications`, and `/api/session` routes require an
`X-Extractor-Secret` header (`requireSecret` middleware, constant-time compared). Only the Supabase
edge functions hold `EXTRACTOR_SHARED_SECRET` — so nobody who merely knows the Railway URL can pull
the org's entire candidate pipeline. Setup is a one-time infra step (see
[shared-ashby-session-setup.md](shared-ashby-session-setup.md)).

### Auth acquisition modes the extractor supports (`server.ts validateCookie`, in priority order)

1. **Body cookie** — a legacy paste sent on the request; if a persisted chain descends from the
   same seed hash, that fresher chain wins.
2. **Live SSO browser** — `POST /api/auth/start` opens a headed Chromium (with anti-bot-detection
   flags: dropped `--enable-automation`, spoofed `navigator.webdriver`, etc.) so a user can do
   Google SSO; subsequent extract calls route through that browser's cookie jar. Used for local/dev.
3. **Persisted session file / Playwright profile** — the shared-team happy path (the volume file).
4. **`ASHBY_SESSION_COOKIE` env** — frozen panic fallback only.

---

## 4. Extraction engine internals (`~/Documents/Ashby-automation/src`)

`extractPipeline()` in `api-server-extract.ts` is the orchestrator. Per run:

**Org discovery.** `GET /api/auth/available_identities` → list of `{organization, user}` identities.
Deduped to `{orgId, userId, name}`. These are the ~60 client orgs.

**Sequential per-org sweep.** Orgs are processed **one at a time** — this is a hard constraint, not
a choice. Switching org context (`POST /api/auth/change_user/{userId}`) mutates **server-side
user-level state**, so two concurrent sweeps would fight over which org the session is "in."
Per org (`fetchPipelineForOrg` in `client.ts`):

1. `change_user/{userId}` → switch context; update cookies from `Set-Cookie`; refresh CSRF; verify
   via `sessionUserV2`.
2. **`InitialFetch`** GraphQL op — one combined query returning open jobs (`jobsPipelines`), the
   first page of active applications (`applicationsByPrebuiltView`, `prebuiltView: Active`), and the
   session user. Enrichment is **inline**: the application query already pulls `interviewEvents`,
   `scorecardSubmission` (overall recommendation + `submittedFormRender` feedback), and interview
   plan stages — no separate per-candidate call in the common path.
3. **Pagination** — `ApiGetActiveApplications`, cursor-based, 100/page, until `moreDataAvailable`
   is false. Cursor pages must be sequential.
4. **Fallback query** — if the heavy query hits a transient "Unidentified server error" for an org,
   retry with a simplified query that omits `scorecardSubmission` (some orgs' scorecards trip
   server errors). Feedback text is lost for that org but the candidates survive.

**Retry passes.** Orgs that fail get up to **2 more retry passes** (`MAX_RETRIES = 2`) at the end.
A 401 mid-sweep is treated as auth-death: return whatever was collected so far rather than losing it.

**Archived/hired sweep.** For each org, a bounded second sweep over the `Archived` + `Hired`
prebuilt views (`fetchArchivedForOrg`, `ASHBY_ARCHIVED_LOOKBACK_DAYS`, default 60) captures
candidates who left the active pipeline, so they demote correctly instead of showing a false "Not
yet in Ashby." Non-fatal per org.

**Targeted enrichment pass (Pass 4).** The bulk view sometimes lacks interview events for
just-moved candidates (decision flips to "Scheduled" before the new stage's `InterviewEvent`
materializes). A bounded pass re-fetches detailed data for *suspect* candidates (status in
`{scheduled, waiting on feedback/availability/submission, booking link sent, needs scheduling}`, or
active-looking rows with zero events). Concurrency is **5 in live-browser mode, 1 in legacy cookie
mode** — in legacy mode N concurrent requests share one rotating token; the first response
invalidates it and the rest 401, killing the whole chain. Bounded by a wall-clock budget
(`EXTRACT_BUDGET_MS` default 240s, with a guaranteed enrichment floor `ENRICH_MIN_BUDGET_MS`
default 180s) so it can't blow the frontend's timeout.

**Context restore.** After the sweep, the session is switched back to the first org so the human's
browser session isn't stranded in some random client's org.

**Feedback text parsing.** `extractFeedbackText` reads scorecard `submittedFormRender`, handling
both plain strings and ProseMirror rich-text JSON (recursively walked), joined with ` | `. Numeric
values (the recommendation score) are skipped so they don't pollute the prose.

**Output.** `extractPipeline` returns flat `snake_case` `ExtractedCandidate` records (the shape the
app consumes — see [ashby-data-schemas.md](ashby-data-schemas.md)), a `companies` list (candidate
employers — do **not** use for org detection), an authoritative `orgs` list (real swept client-org
names, includes zero-candidate orgs), and `extraction_stats` (`orgs_total/fetched/failed`,
`complete`).

### Extractor HTTP API (`server.ts`, Express, port 3001)

| Endpoint | Purpose |
|---|---|
| `POST /api/extract/start` | Start an async sweep, return `jobId` immediately. Single-flight: a second start while one runs **attaches** to the running job. Serves a 10-min result cache if fresh. |
| `GET /api/extract/status/:id` | Poll job: `running` (+progress) / `completed` (+full payload) / `failed`. Also aliased `/api/extract/jobs/:id`. |
| `POST /api/extract` | Synchronous extract (waits ~2 min). Used by simpler/legacy callers. |
| `POST /api/session/seed` | Verify + install a new shared session cookie on the volume. |
| `GET /api/session/status` | Probe whether the persisted chain still authenticates. |
| `POST /api/applications/archive-status` | For a list of `{application_id, org_id}`, return Hired/Archived verdicts (used by the merge's archive inference). |
| `POST /api/auth/start` · `GET /api/auth/status` · `POST /api/auth/stop` | Live SSO browser lifecycle (local/dev). |
| `GET /api/health` | Build stamp, secret-required flag, cache age, org-cache stats. |
| Google Calendar OAuth + `/api/calendar/add` | Separate feature (interview → calendar); not part of the pipeline pull. |

Caches: a 10-min whole-result cache and a 30-min per-org cache both live **in the extractor's
process memory** (lost on redeploy). The durable state is only the session file on the volume.

---

## 5. The edge function (`supabase/functions/ashby-sync/index.ts`)

A single Deno function, invoked by the browser with different bodies. It holds the shared secret and
brokers between browser and extractor. Modes:

- **Start** (`POST {}`) — calls extractor `/api/extract/start` (no cookie — the extractor uses its
  shared session), inserts a `fetch_jobs` row with the returned `extractor_job_id`, returns
  immediately.
- **Poll** (`POST {poll_job_id}`) — `advanceJob()`: hits `/api/extract/status/:id`, updates the
  `fetch_jobs` row's progress; on completion parses the payload and does the **snapshot merge**.
- **Seed** (`POST {action:"seed", cookie}`) — forwards to extractor `/api/session/seed`, updates
  `ashby_connection`.
- **Status** (`POST {action:"status", live?}`) — reads `ashby_connection`; with `live:true`, probes
  the extractor's `/api/session/status` and reconciles.

**Exactly-once merge.** Multiple teammates may poll the same shared extractor job. The completion
update is a **conditional flip** (`update … .eq("status","running")`); only the poller that wins
`running → done` runs `persistSnapshot()`. After a successful persist, the multi-hundred-KB payload
is dropped from the job row (the durable copy is now the snapshot table).

---

## 6. Merge & archive inference (`supabase/functions/_shared/ashbyMerge.ts`)

This is the "never lose data" core — the cloud port of the desktop app's
`_save_ashby_candidates_preserving_detail`. `mergeCandidateRecords(existing, incoming)`:

- **R1 — never delete:** a stored candidate absent from this fetch is kept (an incomplete sweep
  doesn't erase them).
- **R2 — identity = Ashby `candidate_id` (+`job_id`);** rows without one are skipped. Slack-only /
  synthetic rows never enter the snapshot — it is ATS truth only.
- **R3 — per-field merge:** meaningful incoming values win; the stage/decision fields in
  `ALWAYS_OVERWRITE` (`decision_status`, `pipeline_stage`, `current_stage_index`, `total_stages`,
  `stage_progress`, `stage_type`, `last_activity_at`, `needs_scheduling`) always overwrite so they
  reflect the latest fetch.
- **R4 — interview events merge by event id;** stored rounds never drop (`mergeInterviewEvents`,
  interviewers merged by name/email).
- **R5 — no downgrade:** an enriched row (`hasAtsDetail`) is never overwritten by a thin re-fetch
  that lacks detail.

**Archive inference** (`inferArchivedCandidates`): a real row (`stage_type` set) whose org was
successfully swept but which the fetch no longer returned has left the active pipeline. The system
calls the extractor's `archive-status` endpoint to learn *why* — `Hired` vs `Archived` (+ reason
text) — and stamps `decision_status`, `archived_reason`, `archived_inferred`, `archived_detected_at`.
Reappearance auto-unarchives because `decision_status` always overwrites (R3).

Only **touched** rows (added / updated / downgrade-kept / archive-stamped) are upserted, in chunks
of 50 (one giant PostgREST statement is unreliable). Swept org names are upserted into `ashby_orgs`.

---

## 7. Storage (Supabase Postgres)

All Ashby writes go through the edge function with the **service role**; authenticated users have
**read-only** RLS. Tables:

- **`ashby_snapshot_candidates`** — the org-shared candidate snapshot (cloud equivalent of the
  desktop `data/ashby_candidates.json`). Unique on `(ashby_candidate_id, ashby_job_id)`. Indexed on
  `company_name` and `credited_to`. Full column list in [ashby-data-schemas.md](ashby-data-schemas.md).
- **`ashby_orgs`** — authoritative list of Ashby client orgs (`org_name` PK, `last_swept_at`).
  Includes orgs with zero candidates, which candidate rows alone can never reveal.
- **`ashby_connection`** — singleton (`id=1`) session-health row: `status`
  (`healthy|expired|disconnected`), `last_ok_at`, `last_seeded_at`, `seeded_by`, `last_error`.
  Drives the banner and button state.
- **`fetch_jobs`** — per-sync job rows: `status` (`pending|running|succeeded|failed|partial`),
  `orgs_total/fetched/failed`, `candidate_count`, `result_payload` (transient), `error_message`. A
  scheduled migration auto-fails jobs stuck `running` > 15 min (server restart / timeout).

---

## 8. Frontend consumption (`recruitment-coordinator-lovable/src`)

- **`hooks/useAshbySnapshot.ts`** — paginated read of `ashby_snapshot_candidates` (1000/page) +
  `ashby_orgs`. Maps each row to the app's `Candidate` type, splitting rows into **active** vs
  **archived** (decision in `{archived, hired, closed, rejected}` → behind the archive toggle).
  Attaches `data_quality_warnings` via `getAshbyPipelineWarnings`. This snapshot is the source of
  truth for Ashby rows; per-user `candidates` rows are only a fallback (CSV uploads / pre-snapshot).
- **`components/AshbyFetchButton.tsx`** — the header button. Starts the sync (`ashby-sync {}`),
  polls `ashby-sync {poll_job_id}` every 5s for up to 25 min, shows a simulated + real progress bar
  ("Syncing 12/60 orgs"), re-attaches to an already-running sweep on reload, and on expiry opens the
  Reconnect dialog (paste-token → `{action:"seed"}` → auto-sync). Reports partial syncs distinctly.
- **`components/AshbyConnectionBanner.tsx`** — org-wide amber banner while
  `ashby_connection.status === 'expired'`; polls every 60s so it clears after any teammate reconnects.
- **`lib/ashbyAutomation.ts`** — just the `ASHBY_AUTOMATION_API_BASE` constant (Railway URL) + an
  error-payload reader. The browser does **not** call the extractor directly; only edge functions do.
- **`lib/ashbyCookie.ts`** — retired; only clears stale localStorage cookies from the old per-user
  design.

---

## 9. End-to-end flow (one sync)

1. User clicks **Sync from Ashby**. If a fresh sweep is already running (self or teammate), the
   button re-attaches to it instead of starting a second.
2. `ashby-sync {}` → extractor `/api/extract/start` (uses shared session). A `fetch_jobs` row is
   created with the `extractor_job_id`. Returns immediately.
3. Extractor sweeps orgs sequentially (discover → per-org switch/fetch/paginate/enrich → archived
   sweep → targeted enrichment → restore context), building the result in process memory.
4. Browser polls `ashby-sync {poll_job_id}` every 5s. Each poll advances the `fetch_jobs` row and
   surfaces progress.
5. On completion, the winning poller merges the payload into `ashby_snapshot_candidates` +
   `ashby_orgs` (accumulate + archive inference), flips `ashby_connection` to `healthy`, and slims
   the job row.
6. Browser re-pulls the snapshot (`useAshbySnapshot`) and the table refreshes.
7. **Failure paths:** 401/expired → `ashby_connection = expired`, banner + Reconnect dialog. Partial
   (some orgs failed) → `status = partial`, a warning toast, and the snapshot keeps prior data.

---

## 10. Gotchas & sharp edges (read before copying into Parker)

- **No official API.** The whole thing rests on replaying a browser cookie against Ashby's private
  GraphQL API. It can break whenever Ashby changes that API or tightens bot detection, and it's a
  single shared credential for the org.
- **Sequential orgs are mandatory.** `change_user` is server-side user-level state, so the sweep
  cannot be parallelized across orgs on one session. This is the dominant cost (2–20 min).
- **Token rotation is load-bearing.** In legacy cookie mode only **one** request can be in flight at
  a time; concurrency there revokes the whole session. Enrichment concurrency is gated on live-browser
  mode for exactly this reason.
- **Caches are in-process.** The extractor's 10-min result and 30-min org caches vanish on redeploy;
  only the session file (on a volume) is durable. A Railway redeploy mid-sweep loses the run.
- **Single shared session = single point of failure and a security-sensitive secret.** The
  `EXTRACTOR_SHARED_SECRET` gate is what stops anyone with the URL from pulling the whole pipeline —
  don't omit it.
- **DK-credited filtering happens downstream, not here.** The extractor pulls *all* orgs/candidates;
  the desktop importer filters to DK; the cloud app filters per-user by `credited_to` at read time.
  The snapshot stores everyone.
- **`companies` vs `orgs`.** `companies` is derived from each candidate's employer field and is
  meaningless for "which companies use Ashby." Use `orgs` (swept client-org names) for org-level
  logic and archive-inference trust.

---

## 11. File map (where to look)

**Extractor (`~/Documents/Ashby-automation/src`)**
- `server.ts` — Express API, session-seed/status, async job store, shared-secret gate.
- `api-server-extract.ts` — `extractPipeline()` orchestration; flat snake_case output.
- `client.ts` — GraphQL client: org discovery/switch, `InitialFetch`, pagination, fallback,
  `fetchArchivedForOrg`, `fetchArchiveStatuses`, `doFetch` cookie-rotation mirroring, feedback parse.
- `session.ts` — session load / persist-rotation to the volume file.
- `cli.ts` — local CLI (`auth`, `auth-cookie`, `extract`) — the non-cloud path.

**App (`recruitment-coordinator-lovable`)**
- `supabase/functions/ashby-sync/index.ts` — the broker/poller edge function.
- `supabase/functions/_shared/ashbyMerge.ts` — accumulate-merge + archive inference.
- `supabase/migrations/20260612190000_ashby_connection.sql`, `…210000_ashby_snapshot.sql`,
  `…20260501171337_*.sql` (fetch_jobs) — the schema.
- `src/hooks/useAshbySnapshot.ts`, `src/components/AshbyFetchButton.tsx`,
  `src/components/AshbyConnectionBanner.tsx` — the read + trigger UI.
- `docs/shared-ashby-session-setup.md` — the one-time infra checklist (Railway volume + secrets +
  migrations).

See [ashby-data-schemas.md](ashby-data-schemas.md) for the record/table shapes and the GraphQL
operation inventory.
