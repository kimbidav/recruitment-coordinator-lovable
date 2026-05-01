## Goal

Make the Ashby fetch pipeline production-grade for an external recruiter using **per-client session cookies**. Two non-negotiables:

1. Session cookie expiry must never cause silent data loss.
2. The "Finalizing" stage must complete reliably in seconds, not minutes — and never silently drop a candidate.

We keep cookie auth (no API key option since you're not an admin on client tenants).

---

## Problems we're fixing

1. **"Finalizing results" stalls for minutes.** Current save path does `delete-all → insert chunks of 500 → row-by-row fallback`. One bad row triggers 500 individual round-trips. With multiple clients × hundreds of candidates, that's the multi-minute hang you're seeing.
2. **Delete-then-insert is destructive.** If the save fails halfway, you lose previously-saved data with nothing to fall back to.
3. **Cookie expiry mid-fetch on the Railway service** can drop an org partway through with no resume path. Today we only see `orgs_failed` after the fact.
4. **No job persistence** — refreshing the tab kills visibility into a running fetch even though the Railway service keeps going.

---

## Plan

### 1. Replace destructive save with idempotent upsert (kills the "Finalizing" stall)

- Add unique constraint on `candidates(session_id, ashby_candidate_id, ashby_job_id)` via migration.
- Add unique constraint on `interview_events(candidate_row_id, ashby_event_id)` (already discussed earlier; verify it exists, add if missing).
- Replace delete + insert with a single `upsert(..., { onConflict: 'session_id,ashby_candidate_id,ashby_job_id' })` for candidates, and same pattern for events.
- After upsert, run one `delete` for rows in the session whose composite key is **not** in the new payload (true "sync" semantics). This is a single bulk delete, not row-by-row.
- Drop the row-by-row fallback entirely. Upsert in chunks of 500; on chunk error, log the chunk and continue (no per-row retries). Reconciliation toast still fires.

Net effect: thousands of candidates save in 2–5 seconds instead of minutes, and partial failures don't wipe prior data.

### 2. Reconciliation that's auditable, not just a toast

- After save, compute `expectedKeys` (from incoming payload) vs `savedKeys` (from a single `select ashby_candidate_id, ashby_job_id where session_id = ?`).
- If they differ, list the missing candidates by name in the toast AND store the diff in a new `pipeline_save_reports` table (jsonb of missing IDs, counts, timestamp). Lets you prove completeness for any past run.

### 3. Cookie-expiry resilience on the client

- Add a **lightweight pre-flight**: before kicking off `/api/extract`, hit a cheap Ashby endpoint via the Railway service (e.g. `/api/validate-cookie`) that returns 200/401 in <1s. If 401, prompt for a fresh cookie immediately — don't waste 5 minutes discovering it later.
- Show a **persistent banner** during the fetch reminding the user not to log out of Ashby in other tabs. (We can't prevent the logout-on-token-reuse, but documenting it stops the panic.)
- If the fetch returns mid-flight 401 from one org, surface that org name explicitly in the toast so you can re-run with a fresh cookie targeting just that client.

### 4. Job persistence so the tab can be closed

- New `fetch_jobs` table: `id, user_id, status (pending|running|succeeded|failed|partial), started_at, finished_at, orgs_total, orgs_fetched, orgs_failed, candidate_count, error_message`.
- On Fetch click: insert a row → call Railway `/api/extract` → on response, update the row.
- On app load, if a `running` job exists for the user (older than X min with no update), show a "Last fetch may have stalled — re-run?" banner. This gives you visibility across refreshes without needing to change the Railway service.

### 5. Telemetry & UI polish

- Replace simulated progress with real status from `fetch_jobs` (poll every 2s while running).
- Show org-level breakdown when fetch finishes: `12/12 orgs ✓` or `10/12 orgs (Acme failed: cookie expired, BetaCo failed: timeout)`.
- Keep the existing reconciliation warning toast but make it persistent (sticky) until dismissed when drops occur.

### 6. What we're NOT doing (and why)

- **Not** moving the long fetch into a Lovable edge function. The Railway service already does this work and has its own runtime; duplicating it would be wasted effort. Improvements 1–5 give us production-grade reliability **on our side** without touching Railway.
- **Not** trying to keep the user logged in to Ashby. As discussed, Ashby invalidates the browser session by design when the cookie is reused server-side — there's no client-side fix for that. The mitigations above (pre-flight check, fast saves, job persistence) make it irrelevant.

---

## Technical details

**Migration:**
```sql
alter table candidates
  add constraint candidates_session_ashby_unique
  unique (session_id, ashby_candidate_id, ashby_job_id);

alter table interview_events
  add constraint interview_events_candidate_ashby_event_unique
  unique (candidate_row_id, ashby_event_id);

create table fetch_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('pending','running','succeeded','failed','partial')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  orgs_total int, orgs_fetched int, orgs_failed int,
  candidate_count int,
  error_message text
);
alter table fetch_jobs enable row level security;
create policy "own jobs" on fetch_jobs for all using (auth.uid() = user_id);

create table pipeline_save_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  created_at timestamptz not null default now(),
  expected_count int, saved_count int,
  missing jsonb
);
alter table pipeline_save_reports enable row level security;
create policy "own reports" on pipeline_save_reports for all using (auth.uid() = user_id);
```

**Files to change:**
- `src/hooks/usePipelineSession.ts` — replace `saveSession` with upsert + diff-delete + report writing.
- `src/components/AshbyFetchButton.tsx` — pre-flight check, fetch_jobs row, real progress polling, banner, org breakdown toast.
- New migration file for the schema above.
- New `src/lib/fetchJobs.ts` helper (CRUD on fetch_jobs).

---

## Acceptance criteria

- Saving 2,000 candidates completes in under 10 seconds with no row-by-row fallback.
- Killing the network mid-save leaves the previous session intact (no destructive delete).
- Re-running the same fetch is a no-op on the DB (idempotent).
- Pasting an expired cookie shows the re-paste prompt within 2 seconds, not after 5 minutes.
- Reconciliation report row exists for every save; missing candidates are listed by name.
- Refreshing the tab during a fetch shows a "fetch in progress" banner instead of looking idle.