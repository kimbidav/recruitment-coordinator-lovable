# Ashby Integration — Data Schemas & API Inventory

Companion to [ashby-architecture.md](ashby-architecture.md). Field shapes at each hop, plus the
Ashby endpoints/operations the extractor calls. All example values are placeholders — no real
candidate data.

---

## 1. Extractor output — `ExtractedCandidate`

Produced by `extractPipeline()` (`~/Documents/Ashby-automation/src/api-server-extract.ts`), returned
in the extractor's job payload, and consumed by the `ashby-sync` edge function. Flat `snake_case`.

```jsonc
{
  "company_name": "Acme Robotics",        // the CLIENT org (from cand.orgName), not the candidate's employer
  "job_title": "Staff Backend Engineer",
  "job_id": "0e029a8c-…",
  "candidate_name": "Jane Placeholder",
  "candidate_id": "a31d974a-…",           // IDENTITY: Ashby candidate id (see merge rules)
  "application_id": "0ac3c9ec-…",         // needed for archive/hired verification after they leave
  "org_id": "03dc9cfe-…",
  "pipeline_stage": "Take Home Review",   // currentInterviewStage.title
  "decision_status": "Scheduled",         // applicationStatus.description — Active | Scheduled | Archived | Hired | …
  "archived_reason": "",                  // set on the archived/hired sweep or by inference
  "archived_reason_type": "",
  "stage_type": "Active",                 // "" for placeholder rows; presence = "this is real ATS state"
  "current_stage_index": 3,               // 1-based position among Active/Offer stages
  "total_stages": 5,
  "stage_progress": "3/5",
  "last_activity_at": "2026-07-07T07:57:41.499Z",
  "days_in_stage": 3,
  "needs_scheduling": false,
  "credited_to": "Lydia Moon",            // recruiter; the app filters per-user on this
  "source": "Candidate Labs",
  "feedback_count": 0,
  "latest_recommendation": "",            // latest scorecard overallRecommendation
  "latest_feedback_author": "",
  "latest_feedback_date": "",
  "interview_events": [ /* see §2 */ ],
  "current_stage_interviews": "• Take Home Review (07/13) - Michael Evans - No score yet",
  "current_stage_avg_score": null,        // numeric avg of current-stage scores, or null
  "current_stage_date": "2026-07-13",
  "interview_history_summary": "HM Screen (06/23) - Michael Evans - No score"
}
```

Field-building notes:
- `company_name` ← `cand.orgName` (the swept client org). The separate top-level `companies[]` list
  is derived from candidate *employers* and must not be used for org-level logic.
- `current_stage_interviews` / `interview_history_summary` are pre-rendered human strings built in
  `api-server-extract.ts` (`splitCurrentAndPreviousInterviews`) so the app and LLM steps get
  ready-to-read summaries without walking `interview_events`.
- `stage_progress` counts only stages with `stageType ∈ {Active, Offer}` (matches the Ashby pipeline
  UI; excludes sourcing/terminal stages).

## 2. `interview_events[]` element (`ExtractedInterviewEvent`)

```jsonc
{
  "id": "ccc9f633-…",
  "interview_title": "HM Screen",
  "start_time": "2026-06-23T19:00:00.000Z",
  "end_time":   "2026-06-23T19:15:00.000Z",
  "interview_stage_id": "f3300b32-…",
  "interview_stage_title": "Initial Screen",
  "interviewers": [
    {
      "name": "Michael Evans",
      "email": "michael@acme.example",
      "score": null,                     // string overallRecommendation, or null
      "feedback_submitted": false,
      "feedback_text": null              // parsed scorecard prose (ProseMirror-aware), joined by " | "
    }
  ]
}
```

## 3. Extractor job payload (what the poll returns on completion)

```jsonc
{
  "success": true,
  "status": "completed",
  "extracted_at": "2026-07-10T13:58:55.566Z",
  "stats": { "companies": 812, "jobs": 240, "candidates": 2026 },
  "candidates": [ /* ExtractedCandidate[] */ ],
  "companies": [ /* {id,name} — candidate employers; DO NOT use for org detection */ ],
  "orgs": ["Acme Robotics", "Globex", "Initech", …],   // authoritative swept client-org names (incl. zero-candidate orgs)
  "extraction_stats": {
    "orgs_total": 60, "orgs_fetched": 58, "orgs_failed": 2,
    "orgs_retried": 3, "failed_org_names": ["Rilla","Umbrella"],
    "total_seconds": 173, "complete": false
  }
}
```

---

## 4. Storage — `ashby_snapshot_candidates` (Supabase)

The org-shared snapshot table. Written only by the `ashby-sync` edge function (service role);
authenticated users read-only via RLS. `snapshotRow()` in the edge function maps an
`ExtractedCandidate`/merged record onto these columns.

```
id                        uuid  pk  default gen_random_uuid()
ashby_candidate_id        text  not null           ─┐ unique (ashby_candidate_id, ashby_job_id)
ashby_job_id              text  not null default '' ─┘
application_id            text
org_id                    text
candidate_name            text  not null
company_name              text  not null            -- indexed
job_title                 text
pipeline_stage            text
stage_type                text  not null default ''
decision_status           text
current_stage_index       int   not null default 0
total_stages              int   not null default 0
stage_progress            text
days_in_stage             int   not null default 0
needs_scheduling          bool  not null default false
credited_to               text                      -- indexed (per-user filter)
source                    text
feedback_count            int   not null default 0
latest_recommendation     text
latest_feedback_author    text
latest_feedback_date      timestamptz
current_stage_avg_score   numeric
current_stage_date        timestamptz
current_stage_interviews  text
interview_history_summary text
last_activity_at          text
interview_events          jsonb not null default '[]'
archived_reason           text                      ─┐ stamped by archive inference
archived_inferred         bool                       │
archived_detected_at      timestamptz               ─┘
fetched_at                timestamptz               ─┐ merge provenance
fetch_source              text  -- new|merge|kept   ─┘
created_at / updated_at   timestamptz
```

## 5. Storage — supporting tables

**`ashby_orgs`** — authoritative Ashby client-org list.
```
org_name       text pk
org_id         text
first_seen_at  timestamptz default now()
last_swept_at  timestamptz
last_sweep_ok  bool
```

**`ashby_connection`** — singleton session-health row (id=1).
```
id             int pk  check (id = 1)
status         text default 'disconnected'   -- healthy | expired | disconnected
last_seeded_at / last_ok_at   timestamptz
last_error     text
seeded_by      text
updated_at     timestamptz
```

**`fetch_jobs`** — one row per sync.
```
id             uuid pk
user_id        uuid → auth.users
status         text  -- pending | running | succeeded | failed | partial
started_at / finished_at   timestamptz
orgs_total / orgs_fetched / orgs_failed / candidate_count   int
result_payload timestamptz/jsonb  -- transient; slimmed to {extractor_job_id} after merge
result_received_at             timestamptz
error_message  text
```

## 6. Session file (`ASHBY_SESSION_FILE`, on the Railway volume)

```jsonc
{
  "cookies": { "ashby_session_token": "s%3A…" },  // rotates every few minutes; persisted each rotation
  "csrfToken": null,
  "orgIds": [],
  "persistedAt": "2026-07-10T13:00:00.000Z",
  "seedHash": "<sha256 of the seed cookie>"       // ties the rotation chain to the pasted seed
}
```

---

## 7. Ashby API inventory (what the extractor calls)

Base host: `https://app.ashbyhq.com`. Internal/non-public API — no versioning guarantees.

**REST**
| Method · Path | Purpose |
|---|---|
| `GET /api/csrf/token` | Fresh CSRF token (also the cheap auth-liveness probe). Refresh after every org switch. |
| `GET /api/auth/available_identities` | List `{organization, user}` the session can access → the org list. |
| `POST /api/auth/change_user/{userId}` | Switch session into an org's context (server-side, user-level state). |

**GraphQL** — `POST /api/graphql?op=<OperationName>`, `x-csrf-token` header, retries transient
"Unidentified server error" 2× with exponential backoff.
| Operation | Purpose |
|---|---|
| `InitialFetch` | Combined: `jobsPipelines` (open jobs) + first page of `applicationsByPrebuiltView(prebuiltView: Active)` (candidates w/ inline interview events, scorecards, plan stages) + `sessionUserV2`. |
| `ApiGetActiveApplications` | Cursor pagination over `applicationsByPrebuiltView`, 100/page. |
| `ApiGetSessionUser` (`sessionUserV2`) | Verify the current org context after a switch. |
| Archived/Hired prebuilt-view queries | `fetchArchivedForOrg` — bounded sweep of candidates who left the active pipeline (lookback `ASHBY_ARCHIVED_LOOKBACK_DAYS`, default 60). |
| Archive-status lookups | `fetchArchiveStatuses` — per-application Hired vs Archived + reason, for merge inference. |

**Auth cookie:** `ashby_session_token` (and/or `authenticated`), replayed via the `Cookie` header.
Rotated by Ashby via `Set-Cookie` on nearly every response; the extractor mirrors and persists each
rotation. Hard login expiry ~7 days.

---

## 8. Key environment variables

**Extractor (Railway)**
| Var | Meaning |
|---|---|
| `ASHBY_SESSION_FILE` | Path to the durable session file (e.g. `/data/ashby-session.json`). |
| `EXTRACTOR_SHARED_SECRET` | Must match the Supabase edge-function secret; gates extract/session routes. |
| `PORT` | Express port (default 3001). |
| `ASHBY_EXTRACT_BUDGET_SEC` / `ASHBY_ENRICH_MIN_BUDGET_SEC` | Wall-clock budget (240) + enrichment floor (180). |
| `ASHBY_INCLUDE_ARCHIVED` / `ASHBY_ARCHIVED_LOOKBACK_DAYS` | Archived/hired sweep toggle (on) + lookback (60). |
| `ASHBY_SESSION_COOKIE` | Legacy frozen panic-fallback cookie; delete on the shared deploy. |

**Edge function (Supabase)**
| Var | Meaning |
|---|---|
| `ASHBY_AUTOMATION_API_BASE` | Railway extractor URL. |
| `EXTRACTOR_SHARED_SECRET` | Same value as Railway. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` | Standard Supabase wiring. |

**Frontend**
| Var | Meaning |
|---|---|
| `VITE_ASHBY_AUTOMATION_API_BASE` | Railway URL (constant only; browser never calls it directly). |
