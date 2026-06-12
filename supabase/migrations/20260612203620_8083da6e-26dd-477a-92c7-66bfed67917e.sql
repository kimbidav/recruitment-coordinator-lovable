-- Migration 1: 20260612190000_ashby_connection.sql
-- Org-wide shared Ashby session health (singleton row, id = 1).
-- The session itself lives on the Railway extractor's volume; this table
-- only tracks its health so every user's UI can show connected/expired
-- state and the self-service Reconnect flow.

create table public.ashby_connection (
  id int primary key default 1 check (id = 1),
  status text not null default 'disconnected', -- healthy | expired | disconnected
  last_seeded_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  seeded_by text,
  updated_at timestamptz not null default now()
);

alter table public.ashby_connection enable row level security;

create policy "authenticated can read ashby connection"
  on public.ashby_connection
  for select
  to authenticated
  using (true);

-- Writes go through edge functions with the service role only.
grant select on public.ashby_connection to authenticated;
grant all on public.ashby_connection to service_role;

-- Migration 2: 20260612210000_ashby_snapshot.sql
-- Org-shared Ashby snapshot: the cloud equivalent of the desktop app's
-- data/ashby_candidates.json. Written server-side by the ashby-sync edge
-- function (accumulate-and-merge, archive/hired inference); read by every
-- authenticated user and filtered per-user by credited_to in the app.

create table public.ashby_snapshot_candidates (
  id uuid primary key default gen_random_uuid(),
  ashby_candidate_id text not null,
  ashby_job_id text not null default '',
  application_id text,
  org_id text,
  candidate_name text not null,
  company_name text not null,
  job_title text,
  pipeline_stage text,
  stage_type text not null default '',
  decision_status text,
  current_stage_index int not null default 0,
  total_stages int not null default 0,
  stage_progress text,
  days_in_stage int not null default 0,
  needs_scheduling boolean not null default false,
  credited_to text,
  source text,
  feedback_count int not null default 0,
  latest_recommendation text,
  latest_feedback_author text,
  latest_feedback_date timestamptz,
  current_stage_avg_score numeric,
  current_stage_date timestamptz,
  current_stage_interviews text,
  interview_history_summary text,
  last_activity_at text,
  interview_events jsonb not null default '[]'::jsonb,
  archived_reason text,
  archived_inferred boolean,
  archived_detected_at timestamptz,
  fetched_at timestamptz,
  fetch_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ashby_candidate_id, ashby_job_id)
);

create index ashby_snapshot_candidates_company_idx
  on public.ashby_snapshot_candidates (company_name);
create index ashby_snapshot_candidates_credited_idx
  on public.ashby_snapshot_candidates (credited_to);

-- Authoritative Ashby org list (includes orgs with zero candidate rows).
-- The extractor appends an org to its result's `companies` array only after
-- a successful sweep, so last_swept_at doubles as sweep bookkeeping.
create table public.ashby_orgs (
  org_name text primary key,
  org_id text,
  first_seen_at timestamptz not null default now(),
  last_swept_at timestamptz,
  last_sweep_ok boolean
);

alter table public.ashby_snapshot_candidates enable row level security;
alter table public.ashby_orgs enable row level security;

create policy "authenticated can read ashby snapshot"
  on public.ashby_snapshot_candidates
  for select
  to authenticated
  using (true);

create policy "authenticated can read ashby orgs"
  on public.ashby_orgs
  for select
  to authenticated
  using (true);

-- Writes go through the ashby-sync edge function with the service role only.
grant select on public.ashby_snapshot_candidates to authenticated;
grant select on public.ashby_orgs to authenticated;
grant all on public.ashby_snapshot_candidates to service_role;
grant all on public.ashby_orgs to service_role;

-- Migration 3: 20260612213000_recruiter_aliases.sql
-- Per-user Ashby identity: which credited_to values in the org-shared
-- snapshot belong to this user. Drives the "My candidates" pipeline filter,
-- the calendar-sync recruiter guard, and Ashby-derived agent cards.

alter table public.agent_settings
  add column if not exists recruiter_aliases text[] not null default '{}';

-- Migration 4: 20260612220000_ashby_card_pair_key.sql
-- Ashby-derived agent cards (ashby_needs_scheduling / ashby_missing_feedback)
-- are keyed by (company,candidate) pair instead of a Slack submission. The
-- partial unique index is the duplicate-collapse guarantee: one card per
-- user+pair+kind, ever, regardless of how many scans fire.

alter table public.agent_action_cards
  add column if not exists ashby_pair_key text;

create unique index if not exists agent_action_cards_ashby_pair_idx
  on public.agent_action_cards (user_id, kind, ashby_pair_key)
  where ashby_pair_key is not null;