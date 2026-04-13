import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Candidate } from "@/data/candidates";
import { toast } from "sonner";

export function usePipelineSession() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load session from URL param on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionParam = params.get("session");
    if (sessionParam) {
      loadSession(sessionParam);
    } else {
      setIsLoading(false);
    }
  }, []);

  const loadSession = async (id: string) => {
    setIsLoading(true);
    try {
      // Verify session exists
      const { data: session, error: sessionError } = await supabase
        .from("pipeline_sessions")
        .select("id, updated_at")
        .eq("id", id)
        .maybeSingle();

      if (sessionError || !session) {
        console.error("Session not found:", sessionError);
        toast.error("Session not found");
        setIsLoading(false);
        return;
      }

      // Load candidates for this session
      const { data: candidatesData, error: candidatesError } = await supabase
        .from("candidates")
        .select("*")
        .eq("session_id", id);

      if (candidatesError) {
        console.error("Error loading candidates:", candidatesError);
        toast.error("Failed to load candidates");
        setIsLoading(false);
        return;
      }

      const loadedCandidates: Candidate[] = (candidatesData || []).map((c: any) => ({
        company_name: c.company_name,
        job_title: c.job_title,
        job_id: c.id,
        candidate_name: c.candidate_name,
        candidate_id: c.id,
        pipeline_stage: c.pipeline_stage,
        decision_status: c.decision_status,
        stage_type: "",
        current_stage_index: c.current_stage_index,
        total_stages: c.total_stages,
        stage_progress: `${c.current_stage_index}/${c.total_stages}`,
        last_activity_at: c.last_activity_at || c.created_at,
        days_in_stage: 0,
        needs_scheduling: false,
        credited_to: c.credited_to,
        source: "",
        feedback_count: c.feedback_count || 0,
        latest_recommendation: c.latest_recommendation || undefined,
        latest_feedback_author: c.latest_feedback_author || undefined,
        latest_feedback_date: c.latest_feedback_date || undefined,
        interview_history_summary: c.interview_history_summary || undefined,
        current_stage_interviews: c.current_stage_interviews || undefined,
        current_stage_avg_score: c.current_stage_avg_score || undefined,
        current_stage_date: c.current_stage_date || undefined,
      }));

      setCandidates(loadedCandidates);
      setSessionId(id);
      setLastUpdated(session.updated_at);
      toast.success(`Loaded ${loadedCandidates.length} candidates`);
    } catch (error) {
      console.error("Error loading session:", error);
      toast.error("Failed to load session");
    } finally {
      setIsLoading(false);
    }
  };

  const saveSession = useCallback(async (newCandidates: Candidate[]) => {
    try {
      let targetSessionId = sessionId;

      if (!targetSessionId) {
        const { data: session, error: sessionError } = await supabase
          .from("pipeline_sessions")
          .insert({})
          .select("id")
          .single();

        if (sessionError || !session) {
          console.error("Error creating session:", sessionError);
          toast.error("Failed to save pipeline");
          return;
        }

        targetSessionId = session.id;
      } else {
        const { error: deleteError } = await supabase
          .from("candidates")
          .delete()
          .eq("session_id", targetSessionId);

        if (deleteError) {
          console.error("Error replacing candidates:", deleteError);
          toast.error("Failed to update pipeline");
          return;
        }

        const { error: touchError } = await supabase
          .from("pipeline_sessions")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", targetSessionId);

        if (touchError) {
          console.error("Error updating session timestamp:", touchError);
        }
      }

      // Insert all candidates
      const candidatesToInsert = newCandidates.map((c) => ({
        session_id: targetSessionId,
        candidate_name: c.candidate_name,
        company_name: c.company_name,
        job_title: c.job_title,
        pipeline_stage: c.pipeline_stage,
        decision_status: c.decision_status,
        credited_to: c.credited_to,
        current_stage_index: c.current_stage_index,
        total_stages: c.total_stages,
        feedback_count: c.feedback_count || 0,
        latest_recommendation: c.latest_recommendation ?? null,
        latest_feedback_author: c.latest_feedback_author || null,
        latest_feedback_date: c.latest_feedback_date || null,
        current_stage_avg_score: c.current_stage_avg_score ?? null,
        current_stage_date: c.current_stage_date || null,
        interview_history_summary: c.interview_history_summary || null,
        current_stage_interviews: c.current_stage_interviews || null,
        last_activity_at: c.last_activity_at || null,
      }));

      const { error: insertError } = await supabase
        .from("candidates")
        .insert(candidatesToInsert);

      if (insertError) {
        console.error("Error inserting candidates:", insertError);
        toast.error("Failed to save candidates");
        return;
      }

      setCandidates(newCandidates);
      setSessionId(targetSessionId);
      setLastUpdated(new Date().toISOString());
      
      // Update URL with session ID using native browser API
      const newUrl = `${window.location.pathname}?session=${targetSessionId}`;
      window.history.replaceState({}, "", newUrl);
      
      if (sessionId) {
        toast.success(`Updated ${newCandidates.length} candidates from Ashby enrichment.`);
      } else {
        toast.success(`Saved ${newCandidates.length} candidates. Share this URL to share your pipeline!`);
      }
    } catch (error) {
      console.error("Error saving session:", error);
      toast.error("Failed to save pipeline");
    }
  }, [sessionId]);

  const clearSession = useCallback(() => {
    setCandidates([]);
    setSessionId(null);
    window.history.replaceState({}, "", window.location.pathname);
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
