-- v2 / Package 5: Slack sync hygiene.
--
-- 1. Activity on each submission (thread replies), so the lookback window
--    follows ACTIVITY, not the intro date: a loop is alive while it is moving
--    (Utsav @ Citizenhealth — intro May 13, decision call Aug 24, invisible
--    to every surface because the intro was >60 days old).
-- 2. Channel hygiene: previous client names after a channel rename, and the
--    channel a thread migrated from when a Slack Connect channel is re-shared
--    under a new id (the Prometheus case).
-- 3. Per-user incremental sync state: per-channel watermarks, the live
--    channel set, and when the last full self-heal rescan ran.

alter table public.slack_submissions
  add column if not exists thread_ts text,
  add column if not exists last_activity_at timestamptz,
  add column if not exists reply_count integer not null default 0,
  add column if not exists last_reply_at timestamptz,
  add column if not exists last_refreshed_at timestamptz,
  add column if not exists channel_name text,
  add column if not exists previous_client_names text[] not null default '{}',
  add column if not exists migrated_from_channel_id text;

update public.slack_submissions set thread_ts = message_ts where thread_ts is null;
update public.slack_submissions set last_activity_at = submitted_at where last_activity_at is null;

create index if not exists idx_slack_submissions_activity
  on public.slack_submissions (user_id, last_activity_at desc);
create index if not exists idx_slack_submissions_thread
  on public.slack_submissions (user_id, linkedin_url, thread_ts);

create table if not exists public.slack_sync_state (
  user_id uuid primary key,
  channel_watermarks jsonb not null default '{}'::jsonb,
  live_channel_ids text[] not null default '{}',
  failed_channel_ids text[] not null default '{}',
  last_sync_at timestamptz,
  last_full_sync_at timestamptz,
  last_scan_method text,
  updated_at timestamptz not null default now()
);
alter table public.slack_sync_state enable row level security;
drop policy if exists "users select own sync state" on public.slack_sync_state;
create policy "users select own sync state" on public.slack_sync_state
  for select to authenticated using (auth.uid() = user_id);
