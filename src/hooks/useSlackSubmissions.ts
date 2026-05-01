import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface SlackSubmissionRow {
  id: string;
  channel_id: string;
  message_ts: string;
  client_name: string;
  candidate_name: string;
  linkedin_url: string | null;
  submitted_at: string;
  status: string;
  needs_review: boolean;
  permalink: string | null;
}

export interface SlackChannelMapping {
  channel_id: string;
  channel_name: string;
  client_name: string;
  enabled: boolean;
  last_synced_at: string | null;
}

export function useSlackSubmissions() {
  const { user } = useAuth();
  const [submissions, setSubmissions] = useState<SlackSubmissionRow[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!user) {
      setSubmissions([]);
      setConnected(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const { data: tok } = await supabase
        .from("slack_tokens")
        .select("slack_team_name")
        .eq("user_id", user.id)
        .maybeSingle();
      setConnected(!!tok);
      setTeamName(tok?.slack_team_name ?? null);

      if (tok) {
        const { data, error } = await supabase
          .from("slack_submissions")
          .select(
            "id, channel_id, message_ts, client_name, candidate_name, linkedin_url, submitted_at, status, needs_review, permalink",
          )
          .eq("user_id", user.id)
          .order("submitted_at", { ascending: false })
          .limit(2000);
        if (error) throw error;
        setSubmissions((data ?? []) as SlackSubmissionRow[]);
      } else {
        setSubmissions([]);
      }
    } catch (e) {
      console.error("Failed to load Slack submissions:", e);
    } finally {
      setIsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { submissions, connected, teamName, isLoading, reload };
}
