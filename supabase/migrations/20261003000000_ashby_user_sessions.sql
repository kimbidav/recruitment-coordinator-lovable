-- v2 / Package 3: each recruiter's own Ashby login (health only).
--
-- The login itself (cookies) lives on the extractor's volume, keyed by
-- email and verified against the recruiter's identity when seeded. This
-- table mirrors its HEALTH so the dashboard can show "connected as", warn
-- when it has expired (~weekly, an Ashby limit), and route the recruiter to
-- reconnect before a click fails.
create table if not exists public.ashby_user_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  status text not null default 'unknown' check (status in ('healthy', 'expired', 'unknown', 'disconnected')),
  identity_verified boolean not null default false,
  org_count int not null default 0,
  last_seeded_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  expires_estimate_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.ashby_user_sessions enable row level security;
create policy "users read own ashby session" on public.ashby_user_sessions
  for select to authenticated using (auth.uid() = user_id);
-- Writes: edge functions only (service role).
