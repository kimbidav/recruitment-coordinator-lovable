import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Candidate, InterviewEvent } from "@/data/candidates";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

const PAGE_SIZE = 1000;
const INSERT_CHUNK = 500;

const cleanRequiredText = (value: string | null | undefined, fallback: string) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
};

const cleanOptionalText = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const cleanInteger = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const cleanNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const cleanTimestamp = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

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
        closed_locally: (c.closed_locally as boolean) ?? false,
        closed_at: (c.closed_at as string) ?? undefined,
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
      const t0 = performance.now();
      try {
        await supabase
          .from("pipeline_sessions")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", sessionId);

        // Build payload. Note: ashby_candidate_id and ashby_job_id are part of the
        // unique key (session_id, ashby_candidate_id, ashby_job_id) — ensure non-null.
        const candidatesToUpsert = newCandidates
          .filter((c) => c.candidate_id && c.job_id)
          .map((c) => ({
            user_id: user.id,
            session_id: sessionId,
            ashby_candidate_id: c.candidate_id,
            ashby_job_id: c.job_id,
            // NOT NULL columns — coerce empty/missing upstream values to safe defaults
            // so a single sparse row from Ashby cannot fail the whole batch.
            candidate_name: cleanRequiredText(c.candidate_name, "(no name)"),
            company_name: cleanRequiredText(c.company_name, "(unknown company)"),
            job_title: cleanRequiredText(c.job_title, "—"),
            pipeline_stage: cleanRequiredText(c.pipeline_stage, "Unknown"),
            decision_status: cleanRequiredText(c.decision_status, "Active"),
            credited_to: cleanRequiredText(c.credited_to, "(unknown)"),
            current_stage_index: cleanInteger(c.current_stage_index, 0),
            total_stages: cleanInteger(c.total_stages, 0),
            days_in_stage: cleanInteger(c.days_in_stage, 0),
            needs_scheduling: typeof c.needs_scheduling === "boolean" ? c.needs_scheduling : false,
            feedback_count: cleanInteger(c.feedback_count, 0),
            latest_recommendation: cleanOptionalText(c.latest_recommendation),
            latest_feedback_author: cleanOptionalText(c.latest_feedback_author),
            latest_feedback_date: cleanTimestamp(c.latest_feedback_date),
            current_stage_avg_score: cleanNumber(c.current_stage_avg_score),
            current_stage_date: cleanTimestamp(c.current_stage_date),
            interview_history_summary: cleanOptionalText(c.interview_history_summary),
            current_stage_interviews: cleanOptionalText(c.current_stage_interviews),
            last_activity_at: cleanTimestamp(c.last_activity_at),
          }));

        const incoming = candidatesToUpsert.length;
        const incomingKeys = new Set(
          candidatesToUpsert.map((c) => candidateKey(c.ashby_candidate_id, c.ashby_job_id)),
        );

        // Idempotent bulk upsert with row-by-row fallback. PostgreSQL's INSERT
        // ... ON CONFLICT fails the ENTIRE batch on any single-row error
        // (e.g. NOT NULL violation, check constraint, oversized payload). Before
        // the fallback was added, a single bad row from upstream would silently
        // drop every other row in the same chunk — exactly the bug behind the
        // "Reducto candidates never showing up in Ashby" report.
        const upsertFailures: Array<{ chunkStart: number; size: number; error: string }> = [];
        for (let i = 0; i < candidatesToUpsert.length; i += INSERT_CHUNK) {
          const chunk = candidatesToUpsert.slice(i, i + INSERT_CHUNK);
          const { error } = await supabase
            .from("candidates")
            .upsert(chunk, { onConflict: "session_id,ashby_candidate_id,ashby_job_id" });
          if (error) {
            console.error(`Bulk upsert chunk ${i}-${i + chunk.length} failed, retrying row-by-row:`, error.message);
            // Fall back: insert rows individually so good rows still persist
            // and only the offending row(s) get logged + reported as missing.
            for (let j = 0; j < chunk.length; j++) {
              const row = chunk[j];
              const { error: rowErr } = await supabase
                .from("candidates")
                .upsert([row], { onConflict: "session_id,ashby_candidate_id,ashby_job_id" });
              if (rowErr) {
                console.error(
                  `Row upsert failed for ${row.candidate_name} @ ${row.company_name}:`,
                  {
                    message: rowErr.message,
                    details: rowErr.details,
                    hint: rowErr.hint,
                    code: rowErr.code,
                    row,
                  },
                );
                upsertFailures.push({ chunkStart: i + j, size: 1, error: rowErr.message });
              }
            }
          }
        }


        // Read back what's in the DB after upsert to know real saved IDs and reconcile.
        const savedRows = await selectAll<{
          id: string;
          ashby_candidate_id: string | null;
          ashby_job_id: string | null;
        }>((from, to) =>
          supabase
            .from("candidates")
            .select("id, ashby_candidate_id, ashby_job_id")
            .eq("session_id", sessionId)
            .range(from, to) as unknown as PromiseLike<{
            data: { id: string; ashby_candidate_id: string | null; ashby_job_id: string | null }[] | null;
            error: unknown;
          }>,
        );

        // Sync semantics: delete rows that are no longer in the incoming payload.
        const idsToDelete = savedRows
          .filter((r) => {
            if (!r.ashby_candidate_id || !r.ashby_job_id) return true;
            return !incomingKeys.has(candidateKey(r.ashby_candidate_id, r.ashby_job_id));
          })
          .map((r) => r.id);

        if (idsToDelete.length > 0) {
          for (let i = 0; i < idsToDelete.length; i += INSERT_CHUNK) {
            const chunk = idsToDelete.slice(i, i + INSERT_CHUNK);
            const { error: delErr } = await supabase
              .from("candidates")
              .delete()
              .in("id", chunk);
            if (delErr) console.error("Stale delete chunk failed:", delErr.message);
          }
        }

        // Build id-by-key from the freshly-read saved rows (excludes deleted stale ones).
        const idByKey = new Map<string, string>();
        const savedKeys = new Set<string>();
        for (const row of savedRows) {
          if (row.ashby_candidate_id && row.ashby_job_id) {
            const key = candidateKey(row.ashby_candidate_id, row.ashby_job_id);
            if (incomingKeys.has(key)) {
              idByKey.set(key, row.id);
              savedKeys.add(key);
            }
          }
        }

        // Events: also idempotent upsert by (candidate_row_id, ashby_event_id).
        const eventsToUpsert: Array<{
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
            if (!ev.start_time || !ev.id) continue; // need ashby_event_id for conflict target
            eventsToUpsert.push({
              user_id: user.id,
              candidate_row_id: rowId,
              ashby_event_id: ev.id,
              interview_title: ev.interview_title ?? "Interview",
              start_time: ev.start_time,
              end_time: ev.end_time ?? null,
              interviewers: ev.interviewers ?? [],
            });
          }
        }

        for (let i = 0; i < eventsToUpsert.length; i += INSERT_CHUNK) {
          const chunk = eventsToUpsert.slice(i, i + INSERT_CHUNK);
          const { error: evErr } = await supabase
            .from("interview_events")
            .upsert(chunk as unknown as never, {
              onConflict: "candidate_row_id,ashby_event_id",
            });
          if (evErr) console.error(`Event upsert chunk ${i} failed:`, evErr.message);
        }

        setCandidates(newCandidates);
        setLastUpdated(new Date().toISOString());

        // Reconciliation: list missing candidates by name and persist a save report.
        const missing = candidatesToUpsert
          .filter((c) => !savedKeys.has(candidateKey(c.ashby_candidate_id, c.ashby_job_id)))
          .map((c) => ({
            candidate_name: c.candidate_name,
            company_name: c.company_name,
            ashby_candidate_id: c.ashby_candidate_id,
            ashby_job_id: c.ashby_job_id,
          }));

        const saved = incoming - missing.length;
        const elapsedMs = Math.round(performance.now() - t0);

        // Persist auditable report (best-effort; don't block UX on failure).
        void supabase
          .from("pipeline_save_reports")
          .insert({
            user_id: user.id,
            session_id: sessionId,
            expected_count: incoming,
            saved_count: saved,
            missing,
          })
          .then(({ error }) => {
            if (error) console.warn("save report insert failed:", error.message);
          });

        if (missing.length === 0 && upsertFailures.length === 0) {
          toast.success(`Saved ${saved} candidates in ${(elapsedMs / 1000).toFixed(1)}s`);
        } else {
          const sample = missing
            .slice(0, 3)
            .map((d) => `${d.candidate_name} (${d.company_name})`)
            .join(", ");
          toast.warning(
            `Saved ${saved}/${incoming} candidates. ${missing.length} missing${
              sample ? `: ${sample}${missing.length > 3 ? "…" : ""}` : ""
            }. Full report stored.`,
            { duration: 15000 },
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

  /**
   * Mark a single candidate as closed locally. Updates the row in Supabase by
   * (session_id, ashby_candidate_id, ashby_job_id) and reflects it in local state.
   * Slack-only candidates (no Ashby IDs) just update local state — they have no DB row.
   */
  const markCandidateClosed = useCallback(
    async (candidateId: string, jobId: string, closed: boolean) => {
      if (!sessionId || !user) return;

      // Optimistic local update
      setCandidates((prev) =>
        prev.map((c) =>
          c.candidate_id === candidateId && c.job_id === jobId
            ? {
                ...c,
                closed_locally: closed,
                closed_at: closed ? new Date().toISOString() : undefined,
              }
            : c,
        ),
      );

      // Persist if it's an Ashby-backed row (Slack-only IDs use "slack:..." prefix)
      if (candidateId.startsWith("slack:") || jobId.startsWith("slack:")) return;
      try {
        const { error } = await supabase
          .from("candidates")
          .update({
            closed_locally: closed,
            closed_at: closed ? new Date().toISOString() : null,
          })
          .eq("session_id", sessionId)
          .eq("ashby_candidate_id", candidateId)
          .eq("ashby_job_id", jobId);
        if (error) {
          console.error("Failed to persist close state:", error);
          toast.error("Couldn't save close state");
        }
      } catch (e) {
        console.error("Failed to persist close state:", e);
      }
    },
    [sessionId, user],
  );

  return {
    candidates,
    sessionId,
    lastUpdated,
    isLoading,
    saveSession,
    clearSession,
    markCandidateClosed,
  };
}
