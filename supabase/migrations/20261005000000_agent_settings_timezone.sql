-- v2 / Package 7: per-recruiter timezone. Drives the day-of 5pm interview
-- reminders (google-calendar-sync) and the Friday-of-the-week follow-up rule
-- (agent-scan). Null = not chosen yet; the dashboard falls back to the
-- browser's zone and saves the first explicit choice.
alter table public.agent_settings
  add column if not exists timezone text;
