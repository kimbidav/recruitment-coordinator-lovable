-- v2 / Package 4: Ashby correctness.
--
-- 1. Snapshot columns the extractor now emits or the merge/live-check stamp:
--    identity (linkedin_url, credited_to_email/_user_id), restricted-access
--    rows, archive reason type, org reachability, live-verification stamps,
--    provenance of shortcut uploads, rename history.
-- 2. Org reachability tables. An org that disappears from the sweep is a
--    BLIND SPOT, not a conclusion: the audit is surfaced on every refresh
--    (ashby_org_health), renames are learned where the data proves them or
--    confirmed by a human (ashby_org_aliases), and retirement is ONLY ever a
--    human statement about access (ashby_retired_orgs) — never inferred.

alter table public.ashby_snapshot_candidates
  add column if not exists linkedin_url text,
  add column if not exists access_restricted boolean not null default false,
  add column if not exists archived_reason_type text,
  add column if not exists credited_to_email text,
  add column if not exists credited_to_user_id text,
  add column if not exists org_status text,
  add column if not exists org_retired_at timestamptz,
  add column if not exists archived_verified_live_at timestamptz,
  add column if not exists status_verified_live text,
  add column if not exists status_verified_live_at timestamptz,
  add column if not exists added_via text,
  add column if not exists previous_company_names text[] not null default '{}';

create index if not exists ashby_snapshot_candidates_linkedin_idx
  on public.ashby_snapshot_candidates (linkedin_url) where linkedin_url is not null;
create index if not exists ashby_snapshot_candidates_credited_email_idx
  on public.ashby_snapshot_candidates (credited_to_email) where credited_to_email is not null;

-- Org-coverage audit from the last refresh (singleton). Read by the dashboard banner.
create table if not exists public.ashby_org_health (
  id int primary key default 1 check (id = 1),
  checked_at timestamptz not null default now(),
  audit jsonb not null default '{}'::jsonb
);
alter table public.ashby_org_health enable row level security;
drop policy if exists "org health readable by team" on public.ashby_org_health;
create policy "org health readable by team" on public.ashby_org_health
  for select to authenticated using (true);

-- Stale org name -> current org name. source='learned' rows are derived by
-- the sweep (two names, one org_id, one of them swept) and rewritten each
-- refresh; source='manual' rows are human-confirmed and always win.
create table if not exists public.ashby_org_aliases (
  stale_name text primary key,
  current_name text not null,
  source text not null default 'manual' check (source in ('manual', 'learned')),
  confirmed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ashby_org_aliases enable row level security;
drop policy if exists "aliases readable by team" on public.ashby_org_aliases;
create policy "aliases readable by team" on public.ashby_org_aliases
  for select to authenticated using (true);
drop policy if exists "aliases confirmed by team" on public.ashby_org_aliases;
create policy "aliases confirmed by team" on public.ashby_org_aliases
  for insert to authenticated with check (source = 'manual' and confirmed_by = auth.uid());
drop policy if exists "aliases updated by team" on public.ashby_org_aliases;
create policy "aliases updated by team" on public.ashby_org_aliases
  for update to authenticated using (source = 'manual') with check (source = 'manual' and confirmed_by = auth.uid());
drop policy if exists "aliases removed by team" on public.ashby_org_aliases;
create policy "aliases removed by team" on public.ashby_org_aliases
  for delete to authenticated using (source = 'manual');

insert into public.ashby_org_aliases (stale_name, current_name, source)
values ('forge', 'Poetic', 'manual')
on conflict (stale_name) do nothing;

-- Orgs a human has confirmed the team seat no longer reaches. Rows of these
-- orgs are marked org_status='retired' (NOT Archived) on the next refresh
-- and demote out of the active pipeline. Nothing inserts here automatically.
create table if not exists public.ashby_retired_orgs (
  org_name text primary key,
  retired_by uuid references auth.users (id) on delete set null,
  retired_at timestamptz not null default now(),
  note text
);
alter table public.ashby_retired_orgs enable row level security;
drop policy if exists "retired orgs readable by team" on public.ashby_retired_orgs;
create policy "retired orgs readable by team" on public.ashby_retired_orgs
  for select to authenticated using (true);
drop policy if exists "retired orgs confirmed by team" on public.ashby_retired_orgs;
create policy "retired orgs confirmed by team" on public.ashby_retired_orgs
  for insert to authenticated with check (retired_by = auth.uid());
drop policy if exists "retired orgs restored by team" on public.ashby_retired_orgs;
create policy "retired orgs restored by team" on public.ashby_retired_orgs
  for delete to authenticated using (true);
