import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface AgentCardPayload {
  candidate_name?: string;
  company_name?: string;
  channel_id?: string;
  message_ts?: string;
  candidate_email?: string | null;
  signal_summary?: string;
  thread_excerpt?: string;
  slack_permalink?: string | null;
  suggested_followup_at?: string;
  meeting_time?: string;
  suggested_slack_message?: string;
  suggested_email_subject?: string;
  suggested_email_body?: string;
}

export interface AgentCard {
  id: string;
  slack_submission_id: string | null;
  kind: "intro_stall" | "post_interview_followup";
  status: "open" | "snoozed" | "dismissed" | "resolved";
  snooze_until: string | null;
  created_at: string;
  updated_at: string;
  payload: AgentCardPayload;
}

export function useAgentCards() {
  const { user } = useAuth();
  const [cards, setCards] = useState<AgentCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("agent_action_cards")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setCards((data ?? []) as unknown as AgentCard[]);

      const { data: run } = await supabase
        .from("agent_scan_runs")
        .select("finished_at")
        .eq("user_id", user.id)
        .not("finished_at", "is", null)
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      setLastScanAt(run?.finished_at ?? null);
    } catch (e) {
      console.error("loadAgentCards", e);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { data, error } = await supabase.functions.invoke("agent-scan", {
        body: { tz },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      await reload();
      return data;
    } finally {
      setScanning(false);
    }
  }, [reload]);

  const updateStatus = useCallback(async (id: string, status: AgentCard["status"], snooze_until?: string | null) => {
    const patch: Record<string, unknown> = { status };
    if (snooze_until !== undefined) patch.snooze_until = snooze_until;
    const { error } = await supabase.from("agent_action_cards").update(patch).eq("id", id);
    if (error) throw error;
    await reload();
  }, [reload]);

  return { cards, loading, scanning, lastScanAt, reload, runScan, updateStatus };
}

export function visibleCards(cards: AgentCard[]): AgentCard[] {
  const now = Date.now();
  return cards.filter((c) => {
    if (c.status === "dismissed" || c.status === "resolved") return false;
    if (c.status === "snoozed" && c.snooze_until && new Date(c.snooze_until).getTime() > now) return false;
    return true;
  });
}
