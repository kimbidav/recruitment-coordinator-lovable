-- v2 / Package 2: what makes the shortcut fast and the org resolution sticky.

-- Open jobs per Ashby org, so the form opens without a live Ashby query
-- (an org switch + jobs query took 2-16s; the recruiter's own session is
-- asked only on a miss or "Reload jobs"). Seeded by every sweep. Staleness is
-- safe: the extractor verifies at upload time that the chosen job is open in
-- that org. Team-wide: the open jobs of a client are the same for everyone.
create table if not exists public.ashby_open_jobs_cache (
  org_key text primary key,              -- lower(org_name)
  org_name text not null,
  org_id text,
  jobs jsonb not null default '[]'::jsonb,
  source_id text,
  source_title text,
  fetched_at timestamptz not null default now()
);
alter table public.ashby_open_jobs_cache enable row level security;
create policy "authenticated read open jobs" on public.ashby_open_jobs_cache for select to authenticated using (true);

-- Slack channel -> Ashby org name, learned from SUCCESSFUL uploads only
-- (a mis-click can't stick). A client's Ashby name often differs from its
-- channel-derived name; a recruiter picks it once for everyone.
create table if not exists public.ashby_channel_org_map (
  channel_id text primary key,
  org_name text not null,
  channel_name text,
  learned_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.ashby_channel_org_map enable row level security;
create policy "authenticated read channel org map" on public.ashby_channel_org_map for select to authenticated using (true);
