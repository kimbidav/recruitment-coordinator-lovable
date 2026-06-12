-- Org-wide shared Ashby session health (singleton row, id = 1).
-- The session itself lives on the Railway extractor's volume; this table
-- only tracks its health so every user's UI can show connected/expired
-- state and the self-service Reconnect flow.

create table public.ashby_connection (
  id int primary key default 1 check (id = 1),
  status text not null default 'disconnected', -- healthy | expired | disconnected
  last_seeded_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  seeded_by text,
  updated_at timestamptz not null default now()
);

alter table public.ashby_connection enable row level security;

create policy "authenticated can read ashby connection"
  on public.ashby_connection
  for select
  to authenticated
  using (true);

-- Writes go through edge functions with the service role only.
grant select on public.ashby_connection to authenticated;
grant all on public.ashby_connection to service_role;
