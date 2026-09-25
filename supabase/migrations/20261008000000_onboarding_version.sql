-- Required onboarding: which version of the setup wizard each recruiter has
-- finished. The dashboard sends anyone below the current version (see
-- src/lib/onboarding.ts) to /onboarding.
alter table public.agent_settings
  add column if not exists onboarding_version integer not null default 0;
