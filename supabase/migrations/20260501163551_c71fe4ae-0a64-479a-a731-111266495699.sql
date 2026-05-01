-- Wipe existing shared data
DELETE FROM public.interview_events;
DELETE FROM public.candidates;
DELETE FROM public.pipeline_sessions;

-- Add user_id columns scoped to auth.users
ALTER TABLE public.pipeline_sessions
  ADD COLUMN user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.candidates
  ADD COLUMN user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.interview_events
  ADD COLUMN user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX idx_pipeline_sessions_user ON public.pipeline_sessions(user_id);
CREATE INDEX idx_candidates_user ON public.candidates(user_id);
CREATE INDEX idx_interview_events_user ON public.interview_events(user_id);

-- Drop old public RLS policies
DROP POLICY IF EXISTS "Anyone can create pipeline sessions" ON public.pipeline_sessions;
DROP POLICY IF EXISTS "Pipeline sessions are publicly readable" ON public.pipeline_sessions;
DROP POLICY IF EXISTS "anon_update_pipeline_sessions" ON public.pipeline_sessions;

DROP POLICY IF EXISTS "Anyone can insert candidates" ON public.candidates;
DROP POLICY IF EXISTS "Candidates are publicly readable" ON public.candidates;
DROP POLICY IF EXISTS "anon_delete_candidates" ON public.candidates;
DROP POLICY IF EXISTS "anon_update_candidates" ON public.candidates;

DROP POLICY IF EXISTS "interview_events anon delete" ON public.interview_events;
DROP POLICY IF EXISTS "interview_events anon insert" ON public.interview_events;
DROP POLICY IF EXISTS "interview_events anon update" ON public.interview_events;
DROP POLICY IF EXISTS "interview_events publicly readable" ON public.interview_events;

-- New per-user RLS
CREATE POLICY "users select own sessions" ON public.pipeline_sessions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own sessions" ON public.pipeline_sessions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own sessions" ON public.pipeline_sessions
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own sessions" ON public.pipeline_sessions
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users select own candidates" ON public.candidates
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own candidates" ON public.candidates
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own candidates" ON public.candidates
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own candidates" ON public.candidates
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users select own interview events" ON public.interview_events
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own interview events" ON public.interview_events
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own interview events" ON public.interview_events
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own interview events" ON public.interview_events
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Per-user Google Calendar OAuth tokens (refresh-token-based)
CREATE TABLE public.google_calendar_tokens (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token text NOT NULL,
  access_token text,
  expires_at timestamptz,
  scope text,
  google_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.google_calendar_tokens ENABLE ROW LEVEL SECURITY;

-- Users can see whether they're connected and their google_email, but
-- the edge function (service role) is the only thing that writes/reads tokens for actual sync.
CREATE POLICY "users select own google tokens" ON public.google_calendar_tokens
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users delete own google tokens" ON public.google_calendar_tokens
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER update_google_calendar_tokens_updated_at
  BEFORE UPDATE ON public.google_calendar_tokens
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();