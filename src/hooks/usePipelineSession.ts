import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Candidate, InterviewEvent } from "@/data/candidates";
import { toast } from "sonner";

// Singleton session id — there's one shared dashboard for this single-tenant app.
// We keep this stable so the dashboard auto-loads on mount with no URL param.
const DEFAULT_SESSION_ID = "00000000-0000-0000-0000-000000000001";

export function usePipelineSession() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [sessionId] = useState<string>(DEFAULT_SESSION_ID);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Auto-load on mount.
  useEffect(() => {
    void loadSession(DEFAULT_SESSION_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSession = async (id: string) => {
    setIsLoading(true);
    try {
      const { data: session } = await supabase
        .from("pipeline_sessions")
        .select("id, updated_at")
        .eq("id", id)
        .maybeSingle();

      const { data: candidatesData, error: candidatesError } = await supabase
        .from("candidates")
        .select("*")
        .eq("session_id", id);

      if (candidatesError) {
        console.error("Error loading candidates:", candidatesError);
        setIsLoading(false);
        return;
      }

      const rows = candidatesData ?? [];
      const ids = rows.map((r) => r.id);

      // Fetch all interview events for these candidates in one go.
      const eventsByCandidate = new Map<string, InterviewEvent[]>();
      if (ids.length > 0) {
        const { data: events } = await supabase
          .from("interview_events")
          .select("*")
          .in("candidate_row_id", ids)
          .order("start_time", { ascending: false });
        for (const ev of events ?? []) {
          const list = eventsByCandidate.get(ev.candidate_row_id) ?? [];
          list.push({
            id: ev.id,
            interview_title: ev.interview_title,
            start_time: ev.start_time,
            end_time: ev.end_time ?? undefined,
            interviewers: Array.isArray(ev.interviewers)
              ? (ev.interviewers as InterviewEvent["interviewers"])
              : [],
          });
          eventsByCandidate.set(ev.candidate_row_id, list);
        }
      }

      const loaded: Candidate[] = rows.map((c) => ({
        company_name: c.company_name,
        job_title: c.job_title,
        job_id: c.ashby_job_id ?? c.id,
        candidate_name: c.candidate_name,
        candidate_id: c.ashby_candidate_id ?? c.id,
        pipeline_stage: c.pipeline_stage,
        decision_status: c.decision_status,
        stage_type: "",
        current_stage_index: c.current_stage_index,
        total_stages: c.total_stages,
        stage_progress: `${c.current_stage_index}/${c.total_stages}`,
        last_activity_at: c.last_activity_at ?? c.created_at,
        days_in_stage: c.days_in_stage ?? 0,
        needs_scheduling: c.needs_scheduling ?? false,
        credited_to: c.credited_to,
        source: "",
        feedback_count: c.feedback_count ?? 0,
        latest_recommendation: c.latest_recommendation ?? undefined,
        latest_feedback_author: c.latest_feedback_author ?? undefined,
        latest_feedback_date: c.latest_feedback_date ?? undefined,
        interview_history_summary: c.interview_history_summary ?? undefined,
        current_stage_interviews: c.current_stage_interviews ?? undefined,
        current_stage_avg_score: c.current_stage_avg_score ?? undefined,
        current_stage_date: c.current_stage_date ?? undefined,
        interview_events: eventsByCandidate.get(c.id) ?? [],
      }));

      setCandidates(loaded);
      if (session?.updated_at) setLastUpdated(session.updated_at);
    } catch (error) {
      console.error("Error loading session:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const saveSession = useCallback(
    async (newCandidates: Candidate[]) => {
      try {
        // Make sure the singleton session row exists.
        await supabase
          .from("pipeline_sessions")
          .upsert({ id: sessionId, updated_at: new Date().toISOString() });

        // Replace candidates for this session.
        const { error: deleteError } = await supabase
          .from("candidates")
          .delete()
          .eq("session_id", sessionId);
        if (deleteError) {
          console.error("Error clearing candidates:", deleteError);
          toast.error("Failed to update pipeline");
          return;
        }

        const candidatesToInsert = newCandidates.map((c) => ({
          session_id: sessionId,
          ashby_candidate_id: c.candidate_id,
          ashby_job_id: c.job_id,
          candidate_name: c.candidate_name,
          company_name: c.company_name,
          job_title: c.job_title,
          pipeline_stage: c.pipeline_stage,
          decision_status: c.decision_status,
          credited_to: c.credited_to,
          current_stage_index: c.current_stage_index,
          total_stages: c.total_stages,
          days_in_stage: c.days_in_stage ?? 0,
          needs_scheduling: c.needs_scheduling ?? false,
          feedback_count: c.feedback_count ?? 0,
          latest_recommendation: c.latest_recommendation ?? null,
          latest_feedback_author: c.latest_feedback_author ?? null,
          latest_feedback_date: c.latest_feedback_date ?? null,
          current_stage_avg_score: c.current_stage_avg_score ?? null,
          current_stage_date: c.current_stage_date ?? null,
          interview_history_summary: c.interview_history_summary ?? null,
          current_stage_interviews: c.current_stage_interviews ?? null,
          last_activity_at: c.last_activity_at ?? null,
        }));

        const { data: inserted, error: insertError } = await supabase
          .from("candidates")
          .insert(candidatesToInsert)
          .select("id, ashby_candidate_id");

        if (insertError) {
          console.error("Error inserting candidates:", insertError);
          toast.error("Failed to save candidates");
          return;
        }

        // Map ashby_candidate_id -> new row id, then bulk-insert interview events.
        const idByAshby = new Map<string, string>();
        for (const row of inserted ?? []) {
          if (row.ashby_candidate_id) idByAshby.set(row.ashby_candidate_id, row.id);
        }

        const eventsToInsert: Array<{
          candidate_row_id: string;
          ashby_event_id: string | null;
          interview_title: string;
          start_time: string;
          end_time: string | null;
          interviewers: unknown;
        }> = [];

        for (const c of newCandidates) {
          const rowId = idByAshby.get(c.candidate_id);
          if (!rowId || !c.interview_events) continue;
          for (const ev of c.interview_events) {
            if (!ev.start_time) continue;
            eventsToInsert.push({
              candidate_row_id: rowId,
              ashby_event_id: ev.id ?? null,
              interview_title: ev.interview_title ?? "Interview",
              start_time: ev.start_time,
              end_time: ev.end_time ?? null,
              interviewers: ev.interviewers ?? [],
            });
          }
        }

        if (eventsToInsert.length > 0) {
          const { error: evErr } = await supabase
            .from("interview_events")
            .insert(eventsToInsert);
          if (evErr) console.error("Error inserting interview events:", evErr);
        }

        setCandidates(newCandidates);
        setLastUpdated(new Date().toISOString());
        toast.success(`Saved ${newCandidates.length} candidates`);
      } catch (error) {
        console.error("Error saving session:", error);
        toast.error("Failed to save pipeline");
      }
    },
    [sessionId]
  );

  const clearSession = useCallback(() => {
    setCandidates([]);
  }, []);

  return {
    candidates,
    sessionId,
    lastUpdated,
    isLoading,
    saveSession,
    clearSession,
  };
}
