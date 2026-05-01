-- Drop any duplicate rows first so the unique constraint can be added
DELETE FROM public.candidates a
USING public.candidates b
WHERE a.ctid < b.ctid
  AND a.session_id = b.session_id
  AND a.ashby_candidate_id IS NOT DISTINCT FROM b.ashby_candidate_id
  AND a.ashby_job_id IS NOT DISTINCT FROM b.ashby_job_id;

ALTER TABLE public.candidates
  ADD CONSTRAINT candidates_session_ashby_unique
  UNIQUE (session_id, ashby_candidate_id, ashby_job_id);

-- Same for events
DELETE FROM public.interview_events a
USING public.interview_events b
WHERE a.ctid < b.ctid
  AND a.candidate_row_id = b.candidate_row_id
  AND a.ashby_event_id IS NOT DISTINCT FROM b.ashby_event_id;

ALTER TABLE public.interview_events
  ADD CONSTRAINT interview_events_candidate_ashby_event_unique
  UNIQUE (candidate_row_id, ashby_event_id);

-- Fetch jobs
CREATE TABLE public.fetch_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','partial')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  orgs_total INT,
  orgs_fetched INT,
  orgs_failed INT,
  candidate_count INT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.fetch_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own fetch jobs" ON public.fetch_jobs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own fetch jobs" ON public.fetch_jobs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own fetch jobs" ON public.fetch_jobs
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own fetch jobs" ON public.fetch_jobs
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX idx_fetch_jobs_user_started ON public.fetch_jobs(user_id, started_at DESC);

CREATE TRIGGER update_fetch_jobs_updated_at
  BEFORE UPDATE ON public.fetch_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Save reports
CREATE TABLE public.pipeline_save_reports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  expected_count INT NOT NULL DEFAULT 0,
  saved_count INT NOT NULL DEFAULT 0,
  missing JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.pipeline_save_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own save reports" ON public.pipeline_save_reports
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own save reports" ON public.pipeline_save_reports
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own save reports" ON public.pipeline_save_reports
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX idx_save_reports_user_created ON public.pipeline_save_reports(user_id, created_at DESC);