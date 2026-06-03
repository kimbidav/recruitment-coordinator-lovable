ALTER TABLE public.fetch_jobs
  ADD COLUMN IF NOT EXISTS result_payload JSONB,
  ADD COLUMN IF NOT EXISTS result_received_at TIMESTAMPTZ;