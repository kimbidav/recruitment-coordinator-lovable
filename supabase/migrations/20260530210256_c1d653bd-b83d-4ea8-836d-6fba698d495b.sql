
CREATE TABLE public.candidate_emails (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  slack_submission_id UUID NOT NULL,
  email TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'llm',
  confidence NUMERIC NOT NULL DEFAULT 0.5,
  learned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, slack_submission_id, email)
);

CREATE INDEX idx_candidate_emails_sub ON public.candidate_emails (user_id, slack_submission_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.candidate_emails TO authenticated;
GRANT ALL ON public.candidate_emails TO service_role;

ALTER TABLE public.candidate_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own candidate emails"
  ON public.candidate_emails FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "users insert own candidate emails"
  ON public.candidate_emails FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users update own candidate emails"
  ON public.candidate_emails FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users delete own candidate emails"
  ON public.candidate_emails FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
