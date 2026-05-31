CREATE TABLE public.ashby_known_clients (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  client_name text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ashby_known_clients TO authenticated;
GRANT ALL ON public.ashby_known_clients TO service_role;

ALTER TABLE public.ashby_known_clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own ashby known clients" ON public.ashby_known_clients FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own ashby known clients" ON public.ashby_known_clients FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own ashby known clients" ON public.ashby_known_clients FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own ashby known clients" ON public.ashby_known_clients FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Backfill from existing candidates so current Ashby clients are immediately recognized
INSERT INTO public.ashby_known_clients (user_id, client_name)
SELECT DISTINCT user_id, company_name
FROM public.candidates
WHERE ashby_candidate_id IS NOT NULL AND company_name IS NOT NULL AND company_name <> ''
ON CONFLICT (user_id, client_name) DO NOTHING;