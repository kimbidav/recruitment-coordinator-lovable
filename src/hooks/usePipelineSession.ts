import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Candidate, InterviewEvent } from "@/data/candidates";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

const PAGE_SIZE = 1000;
const INSERT_CHUNK = 500;

// Fetch ALL rows for a query, page by page, so we never silently hit Supabase's 1000-row cap.
async function selectAll<T>(
  builder: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await builder(from, to);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

// Stable key for matching a Candidate to its inserted DB row.
// Same person on multiple jobs must NOT collapse — include job_id.
const candidateKey = (candidateId: string, jobId: string) => `${candidateId}::${jobId}`;

export function usePipelineSession() {
  const { user } = useAuth();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setCandidates([]);
      setSessionId(null);
      setLastUpdated(null);
      setIsLoading(false);
      return;
    }
    void loadOrCreateSession(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const loadOrCreateSession = async (userId: string) => {
    setIsLoading(true);
    try {
      let { data: session } = await supabase
        .from("pipeline_sessions")
        .select("id, updated_at")
        .eq("user_id", userId)
        .maybeSingle();

      if (!session) {
        const { data: created, error: createErr } = await supabase
          .from("pipeline_sessions")
          .insert({ user_id: userId })
          .select("id, updated_at")
          .single();
        if (createErr) {
          console.error("Error creating session:", createErr);
          setIsLoading(false);
          return;
        }
        session = created;
      }

      setSessionId(session.id);
      setLastUpdated(session.updated_at ?? null);

      // Paginate candidates so we never silently cap at 1000.
      const rows = await selectAll<Record<string, unknown>>((from, to) =>
        supabase
          .from("candidates")
          .select("*")
          .eq("session_id", session!.id)
          .range(from, to) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
      );

      const ids = rows.map((r) => r.id as string);

      // Paginate interview events too — easy to exceed 1000 with multi-interview pipelines.
      const eventsByCandidate = new Map<string, InterviewEvent[]>();
      if (ids.length > 0) {
        // Supabase .in() with very large arrays can also be slow; chunk the IN list at 500 ids.
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          const events = await selectAll<Record<string, unknown>>((from, to) =>
            supabase
              .from("interview_events")
              .select("*")
              .in("candidate_row_id", chunk)
              .order("start_time", { ascending: false })
              .range(from, to) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
          );
          for (const ev of events) {
            const key = ev.candidate_row_id as string;
            const list = eventsByCandidate.get(key) ?? [];
            list.push({
              id: ev.id as string,
              interview_title: ev.interview_title as string,
              start_time: ev.start_time as string,
              end_time: (ev.end_time as string) ?? undefined,
              interviewers: Array.isArray(ev.interviewers)
                ? (ev.interviewers as unknown as InterviewEvent["interviewers"])
                : [],
            });
            eventsByCandidate.set(key, list);
          }
        }
      }

      const loaded: Candidate[] = rows.map((c) => ({
        company_name: c.company_name as string,
        job_title: c.job_title as string,
        job_id: (c.ashby_job_id as string) ?? (c.id as string),
        candidate_name: c.candidate_name as string,
        candidate_id: (c.ashby_candidate_id as string) ?? (c.id as string),
        pipeline_stage: c.pipeline_stage as string,
        decision_status: c.decision_status as string,
        stage_type: "",
        current_stage_index: c.current_stage_index as number,
        total_stages: c.total_stages as number,
        stage_progress: `${c.current_stage_index}/${c.total_stages}`,
        last_activity_at: (c.last_activity_at as string) ?? (c.created_at as string),
        days_in_stage: (c.days_in_stage as number) ?? 0,
        needs_scheduling: (c.needs_scheduling as boolean) ?? false,
        credited_to: c.credited_to as string,
        source: "",
        feedback_count: (c.feedback_count as number) ?? 0,
        latest_recommendation: (c.latest_recommendation as string) ?? undefined,
        latest_feedback_author: (c.latest_feedback_author as string) ?? undefined,
        latest_feedback_date: (c.latest_feedback_date as string) ?? undefined,
        interview_history_summary: (c.interview_history_summary as string) ?? undefined,
        current_stage_interviews: (c.current_stage_interviews as string) ?? undefined,
        current_stage_avg_score: (c.current_stage_avg_score as number) ?? undefined,
        current_stage_date: (c.current_stage_date as string) ?? undefined,
        interview_events: eventsByCandidate.get(c.id as string) ?? [],
      }));

      setCandidates(loaded);
    } catch (error) {
      console.error("Error loading session:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const saveSession = useCallback(
    async (newCandidates: Candidate[]) => {
      if (!user || !sessionId) {
        toast.error("Not signed in");
        return;
      }
      try {
        await supabase
          .from("pipeline_sessions")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", sessionId);

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
          user_id: user.id,
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

        // Chunked inserts: if a single chunk fails, try rows one-by-one and report what dropped.
        const insertedRows: Array<{ id: string; ashby_candidate_id: string | null; ashby_job_id: string | null }> = [];
        const droppedRows: Array<{ candidate_name: string; company_name: string; reason: string }> = [];

        for (let i = 0; i < candidatesToInsert.length; i += INSERT_CHUNK) {
          const chunk = candidatesToInsert.slice(i, i + INSERT_CHUNK);
          const { data, error } = await supabase
            .from("candidates")
            .insert(chunk)
            .select("id, ashby_candidate_id, ashby_job_id");

          if (error) {
            console.warn(`Chunk insert ${i}-${i + chunk.length} failed (${error.message}); retrying row-by-row`);
            for (const row of chunk) {
              const { data: one, error: oneErr } = await supabase
                .from("candidates")
                .insert(row)
                .select("id, ashby_candidate_id, ashby_job_id")
                .single();
              if (oneErr || !one) {
                droppedRows.push({
                  candidate_name: row.candidate_name,
                  company_name: row.company_name,
                  reason: oneErr?.message ?? "unknown",
                });
                console.error(`Dropped: ${row.candidate_name} @ ${row.company_name} — ${oneErr?.message}`);
              } else {
                insertedRows.push(one);
              }
            }
          } else if (data) {
            insertedRows.push(...data);
          }
        }

        // Composite key (candidate_id + job_id) so the same person on two jobs doesn't collapse.
        const idByKey = new Map<string, string>();
        for (const row of insertedRows) {
          if (row.ashby_candidate_id && row.ashby_job_id) {
            idByKey.set(candidateKey(row.ashby_candidate_id, row.ashby_job_id), row.id);
          }
        }

        const eventsToInsert: Array<{
          user_id: string;
          candidate_row_id: string;
          ashby_event_id: string | null;
          interview_title: string;
          start_time: string;
          end_time: string | null;
          interviewers: unknown[] | Record<string, unknown>;
        }> = [];

        for (const c of newCandidates) {
          const rowId = idByKey.get(candidateKey(c.candidate_id, c.job_id));
          if (!rowId || !c.interview_events) continue;
          for (const ev of c.interview_events) {
            if (!ev.start_time) continue;
            eventsToInsert.push({
              user_id: user.id,
              candidate_row_id: rowId,
              ashby_event_id: ev.id ?? null,
              interview_title: ev.interview_title ?? "Interview",
              start_time: ev.start_time,
              end_time: ev.end_time ?? null,
              interviewers: ev.interviewers ?? [],
            });
          }
        }

        // Chunk event inserts too.
        for (let i = 0; i < eventsToInsert.length; i += INSERT_CHUNK) {
          const chunk = eventsToInsert.slice(i, i + INSERT_CHUNK);
          const { error: evErr } = await supabase
            .from("interview_events")
            .insert(chunk as unknown as never);
          if (evErr) console.error(`Event chunk ${i} failed:`, evErr.message);
        }

        setCandidates(newCandidates);
        setLastUpdated(new Date().toISOString());

        // Reconciliation toast — make drops impossible to miss.
        const saved = insertedRows.length;
        const incoming = newCandidates.length;
        if (saved === incoming && droppedRows.length === 0) {
          toast.success(`Saved ${saved} candidates`);
        } else {
          const sample = droppedRows
            .slice(0, 3)
            .map((d) => `${d.candidate_name} (${d.company_name})`)
            .join(", ");
          toast.warning(
            `Saved ${saved}/${incoming} candidates. ${droppedRows.length} dropped${
              sample ? `: ${sample}${droppedRows.length > 3 ? "…" : ""}` : ""
            }. Check console for details.`,
            { duration: 10000 },
          );
        }
      } catch (error) {
        console.error("Error saving session:", error);
        toast.error("Failed to save pipeline");
      }
    },
    [sessionId, user]
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
