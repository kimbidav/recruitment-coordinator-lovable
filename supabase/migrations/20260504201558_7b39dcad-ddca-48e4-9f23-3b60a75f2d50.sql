
CREATE TABLE public.agent_action_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  slack_submission_id UUID,
  candidate_row_id UUID,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  snooze_until TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, slack_submission_id, kind)
);

ALTER TABLE public.agent_action_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own agent cards" ON public.agent_action_cards
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own agent cards" ON public.agent_action_cards
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own agent cards" ON public.agent_action_cards
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own agent cards" ON public.agent_action_cards
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER update_agent_action_cards_updated_at
  BEFORE UPDATE ON public.agent_action_cards
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_agent_action_cards_user_status ON public.agent_action_cards (user_id, status);

CREATE TABLE public.agent_scan_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  cards_created INTEGER NOT NULL DEFAULT 0,
  cards_resolved INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_scan_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own agent scan runs" ON public.agent_scan_runs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own agent scan runs" ON public.agent_scan_runs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own agent scan runs" ON public.agent_scan_runs
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own agent scan runs" ON public.agent_scan_runs
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
