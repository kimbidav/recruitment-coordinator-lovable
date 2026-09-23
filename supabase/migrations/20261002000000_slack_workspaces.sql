-- v2 / Package 2: the Slack app's bot token per workspace.
--
-- The "Add to Ashby" message shortcut is delivered to the app, not to a
-- user, and answering it (views.open / views.update / a DM to the clicker)
-- needs the app's bot token. Stored once per workspace on install
-- (slack-callback), service role only.
create table if not exists public.slack_workspaces (
  team_id text primary key,
  team_name text,
  bot_token text not null,
  bot_user_id text,
  installed_by uuid references auth.users(id) on delete set null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.slack_workspaces enable row level security;
-- No policies: edge functions (service role) only.
