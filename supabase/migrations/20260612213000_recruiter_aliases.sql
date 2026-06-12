-- Per-user Ashby identity: which credited_to values in the org-shared
-- snapshot belong to this user. Drives the "My candidates" pipeline filter,
-- the calendar-sync recruiter guard, and Ashby-derived agent cards.

alter table public.agent_settings
  add column if not exists recruiter_aliases text[] not null default '{}';
