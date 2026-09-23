-- v2 / Package 2: state for the "Add to Ashby" shortcut.
--
-- A Slack modal's private_metadata holds 3,000 characters and a prefill
-- carries a whole write-up plus job list, so the modal carries only a session
-- id; everything else lives here (replaces the desktop bot's in-memory
-- SessionStore). Resumes go to a private Storage bucket, never into jsonb.
create table if not exists public.slack_shortcut_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slack_team_id text not null,
  slack_user_id text not null,
  channel_id text not null,
  message_ts text not null,
  thread_ts text,
  view_id text,
  org_override text,
  prefill jsonb,
  resume_path text,
  resume_meta jsonb,
  email_value text not null default '',
  email_block_version int not null default 1,
  joiners jsonb not null default '[]'::jsonb,
  note_locked boolean not null default false,
  enriched_at timestamptz,
  last_payload jsonb,
  last_result jsonb,
  uploading boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours'
);
create index if not exists slack_shortcut_sessions_expires_idx on public.slack_shortcut_sessions (expires_at);
alter table public.slack_shortcut_sessions enable row level security;
-- No policies: service role only.

-- The one upload in flight per session, so a lost callback or a restart
-- mid-upload becomes "check Ashby before retrying" rather than silence.
create table if not exists public.ashby_uploads (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.slack_shortcut_sessions(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  extractor_job_id text unique,
  candidate_name text,
  org_name text,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed', 'lost')),
  http_status int,
  result jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ashby_uploads_user_idx on public.ashby_uploads (user_id, started_at desc);
alter table public.ashby_uploads enable row level security;
create policy "users read own uploads" on public.ashby_uploads for select to authenticated using (auth.uid() = user_id);

-- Private bucket for resume PDFs pulled from Slack threads (<= 10 MB each).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shortcut-resumes', 'shortcut-resumes', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;
