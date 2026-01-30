-- Create pipeline_sessions table to hold shared pipeline data
CREATE TABLE public.pipeline_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create candidates table to store candidate data per session
CREATE TABLE public.candidates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.pipeline_sessions(id) ON DELETE CASCADE,
  candidate_name TEXT NOT NULL,
  company_name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  pipeline_stage TEXT NOT NULL,
  decision_status TEXT NOT NULL,
  credited_to TEXT NOT NULL,
  current_stage_index INTEGER NOT NULL DEFAULT 0,
  total_stages INTEGER NOT NULL DEFAULT 1,
  interview_history_summary TEXT,
  current_stage_interviews TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.pipeline_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;

-- Public read access for sharing
CREATE POLICY "Pipeline sessions are publicly readable"
ON public.pipeline_sessions
FOR SELECT
USING (true);

CREATE POLICY "Anyone can create pipeline sessions"
ON public.pipeline_sessions
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Candidates are publicly readable"
ON public.candidates
FOR SELECT
USING (true);

CREATE POLICY "Anyone can insert candidates"
ON public.candidates
FOR INSERT
WITH CHECK (true);

-- Create index for faster lookups
CREATE INDEX idx_candidates_session_id ON public.candidates(session_id);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_pipeline_sessions_updated_at
BEFORE UPDATE ON public.pipeline_sessions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();