-- Ashby-derived agent cards (ashby_needs_scheduling / ashby_missing_feedback)
-- are keyed by (company,candidate) pair instead of a Slack submission. The
-- partial unique index is the duplicate-collapse guarantee: one card per
-- user+pair+kind, ever, regardless of how many scans fire.

alter table public.agent_action_cards
  add column if not exists ashby_pair_key text;

create unique index if not exists agent_action_cards_ashby_pair_idx
  on public.agent_action_cards (user_id, kind, ashby_pair_key)
  where ashby_pair_key is not null;
