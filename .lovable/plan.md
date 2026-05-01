## Goal

Make this app a true single pane of glass for an agency recruiter to see all of their candidates across 50+ client companies in Ashby — with interview history, dates, ratings/feedback, and one-click sync of upcoming interviews to Google Calendar. Remove the brittle Railway cookie-scraping flow.

## Why the current setup is broken

- The Railway backend scrapes Ashby by reusing the user's `ashby_session_token` browser cookie.
- That cookie expires constantly, so the user must re-paste it each session.
- Every recruiter would need their own copy of the Railway service — not viable.
- CORS and "Failed to fetch" errors are recurring symptoms of this scraping approach, not the real problem.

## New architecture

Use the **official Ashby API via the Lovable Ashby connector**. The connector is OAuth-based, lives in Lovable Cloud, and handles auth/token refresh automatically. No cookies, no Railway, no CORS surprises.

```text
Browser (React)
  │
  └─► Supabase Edge Functions  ──►  Lovable Connector Gateway  ──►  Ashby API
         (ashby-sync, ashby-list,                 (OAuth handled here)
          gcal-sync)
  │
  └─► Supabase DB (candidates, interviews, sessions)
```

### What gets built

1. **Connect Ashby (one-time, by the agency owner)**
   - Use the Ashby connector (`standard_connectors--connect`) — user picks/creates a connection in a built-in modal. After this, no cookies are ever needed.
   - Replace the "Fetch from Ashby" cookie dialog with a simple "Sync from Ashby" button.

2. **Database schema (migrations)**
   - Extend `candidates` with: `job_id`, `candidate_id` (Ashby IDs), `stage_type`, `last_activity_at`, `days_in_stage`, `needs_scheduling`, `feedback_count`, `latest_recommendation`, `latest_feedback_author`, `latest_feedback_date`, `current_stage_avg_score`, `current_stage_date`.
   - New table `interview_events`: `id`, `candidate_id` (FK → candidates), `interview_title`, `start_time`, `end_time`, `interviewer`, `status` (scheduled / completed), `feedback_rating`, `feedback_summary`, `feedback_author`, `feedback_date`.
   - Add `last_synced_at` to `pipeline_sessions`.
   - Public RLS (matches existing tables) until auth is added.

3. **Edge function: `ashby-sync`**
   - Lists organizations the connection has access to, then for each: open jobs → active candidate applications → interview schedule + feedback.
   - Aggregates across all orgs (the "50+ clients" requirement).
   - Upserts into `candidates` and `interview_events` keyed by Ashby IDs.
   - Returns a summary `{ candidates_synced, interviews_synced, errors }`.
   - Reports streamed progress via a small `sync_jobs` row the UI polls (no WebSockets needed).

4. **Edge function: `ashby-refresh-candidate`**
   - On-demand refresh for a single candidate (used when the user expands a row).

5. **Edge function: `gcal-sync`**
   - Uses the Google Calendar Lovable connector (per-user OAuth via the connector flow).
   - For a given candidate (or all upcoming), creates Google Calendar events from `interview_events` where `status = scheduled` and `start_time > now()`.
   - Stores the returned `google_event_id` on each `interview_event` to avoid duplicates and allow updates/cancellations.

6. **Frontend changes**
   - Remove `src/lib/ashbyAutomation.ts`, `AshbyFetchButton.tsx` cookie UI; replace with a `SyncFromAshbyButton` that calls the edge function and shows the existing simulated-progress bar driven by real `sync_jobs` polling.
   - `CandidateTable`: expandable row shows `interview_events` timeline (date, interviewer, rating ★, feedback snippet) — pulled from the new table.
   - "Sync to Google Calendar" button per candidate (and a bulk button) that calls `gcal-sync`.
   - Rewrite `GoogleCalendarSync.tsx` to use `standard_connectors--connect` for `google_calendar` instead of the Railway OAuth endpoint.

7. **Cleanup**
   - Delete Railway-related code (`ashbyAutomation.ts`, references in components).
   - Update memory files (`mem://features/ashby-integration`, `mem://features/google-calendar-sync`) to describe the new connector-based flow.

## Technical details

- **Connectors used**: `ashby` and `google_calendar` (both go through `https://connector-gateway.lovable.dev/{id}/...` with `Authorization: Bearer LOVABLE_API_KEY` and `X-Connection-Api-Key: <KEY>`).
- **Ashby API endpoints needed**: `organization.list`, `job.list`, `application.list`, `interviewSchedule.list`, `feedback.list`, `user.list` (for interviewer names). All POST JSON.
- **Rate limits**: Ashby is ~1 req/sec/org. Edge function batches per-org with `Promise.allSettled` across orgs and a small delay within an org.
- **Sync trigger**: manual button now; can add a pg_cron schedule later.
- **Auth**: kept open (public RLS) for now to match the current app. A follow-up plan can add per-recruiter auth + RLS keyed to `auth.uid()`.

## Out of scope for this plan

- Per-user authentication / multi-tenant isolation (current app is single-tenant public).
- Two-way write-back to Ashby (scheduling, notes).
- Automated background sync schedule (manual only for v1).

## What the user will see after this ships

1. Click "Connect Ashby" once → pick the Ashby workspace in a Lovable modal.
2. Click "Sync" → progress bar → all candidates across all clients appear in one filterable table.
3. Expand any candidate → full interview timeline with dates, interviewers, ratings, feedback.
4. Click "Connect Google Calendar" once → click "Sync interviews" → upcoming events land on their calendar.
