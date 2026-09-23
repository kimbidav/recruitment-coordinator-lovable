-- v2 / Package 6: agent rules.
--
-- queue_section: which review queue a card belongs to ("slack" | "ashby"),
--   computed ONCE at enqueue time from whether the client runs Ashby (real
--   snapshot rows, org list, aliases, SEPARATE_CLIENTS) — authoritative
--   across every enqueue site, so an Ashby client's candidate never leaks
--   into the Slack queue whichever step surfaced them.
-- Approve atomicity (agent-act): a card is CLAIMED with an idempotency key
--   before the Slack/Gmail side effect runs and marked acted only after the
--   provider confirms; a failed delivery returns it to its prior status with
--   the error recorded. Replaying the same key returns the stored result.
-- batch_followup_threshold default becomes 2: "2+ stale unscheduled
--   candidates at one client usually means the client has gone quiet".

alter table public.agent_action_cards
  add column if not exists queue_section text,
  add column if not exists act_idempotency_key text,
  add column if not exists act_status text,
  add column if not exists acted_at timestamptz,
  add column if not exists act_result jsonb,
  add column if not exists act_error text;

create unique index if not exists agent_action_cards_act_key_idx
  on public.agent_action_cards (user_id, act_idempotency_key)
  where act_idempotency_key is not null;

alter table public.agent_settings
  alter column batch_followup_threshold set default 2;
