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
  /** Migration-stable identity with linkedin_url (= message_ts for parents). */
  thread_ts?: string | null;
  /** Last thread reply or the intro — the lookback window keys off this. */
  last_activity_at?: string | null;
  reply_count?: number | null;
  last_reply_at?: string | null;
  previous_client_names?: string[] | null;
}

/** Days the dashboard keeps a Slack loop in scope, measured from last activity. */
export const SLACK_LOOKBACK_DAYS = 60;
const CLOSED = new Set(["not_in_process", "disqualified"]);

/** Open rows stay while their last activity is inside the window; closed rows by intro date. */
export function submissionInWindow(row: Pick<SlackSubmissionRow, "submitted_at" | "last_activity_at" | "status">, now = Date.now(), days = SLACK_LOOKBACK_DAYS): boolean {
  const oldest = now - days * 86_400_000;
  const anchor = CLOSED.has(row.status) ? Date.parse(row.submitted_at) : Date.parse(row.last_activity_at ?? row.submitted_at);
  return !Number.isFinite(anchor) || anchor >= oldest;
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
            "id, channel_id, message_ts, client_name, candidate_name, linkedin_url, submitted_at, status, needs_review, permalink, thread_ts, last_activity_at, reply_count, last_reply_at, previous_client_names",
          )
          .eq("user_id", user.id)
          .order("submitted_at", { ascending: false })
          .limit(4000);
        if (error) throw error;
        // Activity-based window: a long-running loop stays visible while it
        // moves, however old its intro (Utsav @ Citizenhealth).
        setSubmissions(((data ?? []) as SlackSubmissionRow[]).filter((r) => submissionInWindow(r)));
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
