CREATE TABLE public.agent_scan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  scan_run_id uuid NOT NULL,
  slack_submission_id uuid,
  candidate_name text,
  client_name text,
  outcome text NOT NULL,
  reason text,
  signal jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_scan_items_run ON public.agent_scan_items(scan_run_id);
CREATE INDEX idx_agent_scan_items_user_created ON public.agent_scan_items(user_id, created_at DESC);

ALTER TABLE public.agent_scan_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own scan items" ON public.agent_scan_items
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own scan items" ON public.agent_scan_items
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own scan items" ON public.agent_scan_items
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own scan items" ON public.agent_scan_items
  FOR DELETE TO authenticated USING (auth.uid() = user_id);