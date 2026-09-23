-- v2 / Package 0: company-only sign-up + OAuth state nonces.
--
-- Anyone with any Google account (or an email/password) could create a
-- Candidate Compass account. Every recruiter is @candidatelabs.com, so the
-- database refuses anything else. This trigger is the real lock: the
-- Lovable-managed Google sign-in may not pass `hd=`, and the email/password
-- form is removed in the UI but the API would still accept a sign-up.
create or replace function public.enforce_candidatelabs_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is null or lower(new.email) not like '%@candidatelabs.com' then
    raise exception 'Candidate Compass is for @candidatelabs.com accounts only'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_candidatelabs_domain on auth.users;
create trigger enforce_candidatelabs_domain
  before insert on auth.users
  for each row execute function public.enforce_candidatelabs_domain();

-- Existing off-domain accounts (anyone who signed up before the lock).
delete from auth.users where email is null or lower(email) not like '%@candidatelabs.com';

-- OAuth `state` used to be the user id, so a callback URL could be replayed
-- against any user whose id was known. A random nonce, bound to the user
-- and provider and consumed on use, replaces it.
create table if not exists public.oauth_states (
  state uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('slack', 'google')),
  created_at timestamptz not null default now()
);
alter table public.oauth_states enable row level security;
-- Service role only: written by the *-connect functions, consumed by the callbacks.
create index if not exists oauth_states_created_idx on public.oauth_states (created_at);
