
CREATE TABLE public.client_domain_cache (
  user_id uuid NOT NULL,
  client_name text NOT NULL,
  domain text NOT NULL,
  source text NOT NULL DEFAULT 'inferred',
  confidence numeric NOT NULL DEFAULT 0.5,
  learned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_name)
);
ALTER TABLE public.client_domain_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users select own domain cache" ON public.client_domain_cache FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own domain cache" ON public.client_domain_cache FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own domain cache" ON public.client_domain_cache FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own domain cache" ON public.client_domain_cache FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.agent_settings (
  user_id uuid NOT NULL PRIMARY KEY,
  intro_stall_min_days integer NOT NULL DEFAULT 3,
  batch_followup_threshold integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users select own agent settings" ON public.agent_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own agent settings" ON public.agent_settings FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own agent settings" ON public.agent_settings FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own agent settings" ON public.agent_settings FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER update_agent_settings_updated_at BEFORE UPDATE ON public.agent_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
