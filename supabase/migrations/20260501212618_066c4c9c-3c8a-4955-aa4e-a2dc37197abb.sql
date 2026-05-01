
-- slack_tokens: per-user Slack OAuth tokens
CREATE TABLE public.slack_tokens (
  user_id uuid PRIMARY KEY,
  slack_user_id text NOT NULL,
  slack_team_id text NOT NULL,
  slack_team_name text,
  access_token text NOT NULL,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.slack_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own slack tokens" ON public.slack_tokens
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own slack tokens" ON public.slack_tokens
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own slack tokens" ON public.slack_tokens
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own slack tokens" ON public.slack_tokens
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER update_slack_tokens_updated_at
  BEFORE UPDATE ON public.slack_tokens
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- slack_channel_mappings: discovered channels with editable client-name override
CREATE TABLE public.slack_channel_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel_id text NOT NULL,
  channel_name text NOT NULL,
  client_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel_id)
);

ALTER TABLE public.slack_channel_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own channel mappings" ON public.slack_channel_mappings
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own channel mappings" ON public.slack_channel_mappings
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own channel mappings" ON public.slack_channel_mappings
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own channel mappings" ON public.slack_channel_mappings
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER update_slack_channel_mappings_updated_at
  BEFORE UPDATE ON public.slack_channel_mappings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- slack_submissions: parsed candidate submissions
CREATE TABLE public.slack_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel_id text NOT NULL,
  message_ts text NOT NULL,
  client_name text NOT NULL,
  candidate_name text NOT NULL DEFAULT '',
  linkedin_url text,
  submitted_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'submitted',
  raw_text text,
  permalink text,
  needs_review boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel_id, message_ts)
);

CREATE INDEX idx_slack_submissions_user ON public.slack_submissions(user_id);
CREATE INDEX idx_slack_submissions_client ON public.slack_submissions(user_id, client_name);

ALTER TABLE public.slack_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own slack submissions" ON public.slack_submissions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own slack submissions" ON public.slack_submissions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own slack submissions" ON public.slack_submissions
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own slack submissions" ON public.slack_submissions
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER update_slack_submissions_updated_at
  BEFORE UPDATE ON public.slack_submissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
