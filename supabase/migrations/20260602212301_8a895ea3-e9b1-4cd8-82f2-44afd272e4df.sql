
CREATE TABLE public.client_aliases (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  alias TEXT NOT NULL,
  canonical TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, alias)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_aliases TO authenticated;
GRANT ALL ON public.client_aliases TO service_role;

ALTER TABLE public.client_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own client aliases" ON public.client_aliases
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own client aliases" ON public.client_aliases
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own client aliases" ON public.client_aliases
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own client aliases" ON public.client_aliases
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER update_client_aliases_updated_at
  BEFORE UPDATE ON public.client_aliases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_client_aliases_user ON public.client_aliases(user_id);
