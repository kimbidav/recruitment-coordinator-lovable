
-- Add interview_events table for the interview timeline
CREATE TABLE public.interview_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  candidate_row_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  ashby_event_id text,
  interview_title text NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz,
  interviewers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_interview_events_candidate ON public.interview_events(candidate_row_id);
CREATE INDEX idx_interview_events_start ON public.interview_events(start_time);

ALTER TABLE public.interview_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "interview_events publicly readable"
  ON public.interview_events FOR SELECT USING (true);
CREATE POLICY "interview_events anon insert"
  ON public.interview_events FOR INSERT WITH CHECK (true);
CREATE POLICY "interview_events anon update"
  ON public.interview_events FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "interview_events anon delete"
  ON public.interview_events FOR DELETE USING (true);

-- Add Ashby identifier columns to candidates so we can dedupe across syncs
ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS ashby_candidate_id text,
  ADD COLUMN IF NOT EXISTS ashby_job_id text,
  ADD COLUMN IF NOT EXISTS days_in_stage integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS needs_scheduling boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS feedback_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latest_recommendation text,
  ADD COLUMN IF NOT EXISTS latest_feedback_author text,
  ADD COLUMN IF NOT EXISTS latest_feedback_date timestamptz,
  ADD COLUMN IF NOT EXISTS current_stage_avg_score numeric,
  ADD COLUMN IF NOT EXISTS current_stage_date timestamptz,
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_candidates_session ON public.candidates(session_id);

-- Singleton "default" pipeline session so dashboard auto-loads without needing
-- a session URL param. We'll always use this row.
INSERT INTO public.pipeline_sessions (id)
VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;
