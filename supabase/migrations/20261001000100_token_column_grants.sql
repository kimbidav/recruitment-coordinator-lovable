-- v2 / Package 0: stop exposing raw OAuth tokens to the browser.
--
-- RLS let each user select their OWN row, which through PostgREST meant the
-- browser could read slack_tokens.access_token and
-- google_calendar_tokens.refresh_token. The UI only ever needs "connected?"
-- and a display name (useOnboardingStatus.ts), so grant those columns only.
-- Edge functions use the service role and are unaffected. Column grants are
-- honored by PostgREST alongside RLS.
revoke select on public.slack_tokens from authenticated;
grant select (user_id, slack_user_id, slack_team_id, slack_team_name, scope, created_at, updated_at)
  on public.slack_tokens to authenticated;

revoke select on public.google_calendar_tokens from authenticated;
grant select (user_id, google_email, scope, created_at, updated_at)
  on public.google_calendar_tokens to authenticated;

-- Writes are edge-only (the callbacks upsert with the service role).
drop policy if exists "users insert own slack tokens" on public.slack_tokens;
drop policy if exists "users update own slack tokens" on public.slack_tokens;
drop policy if exists "users insert own google tokens" on public.google_calendar_tokens;
drop policy if exists "users update own google tokens" on public.google_calendar_tokens;
