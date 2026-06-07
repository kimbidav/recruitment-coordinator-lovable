UPDATE public.fetch_jobs
SET status='failed', finished_at=now(),
    error_message = COALESCE(error_message,'Stale job auto-failed (server restart or timeout)')
WHERE status='running' AND started_at < now() - interval '15 minutes';