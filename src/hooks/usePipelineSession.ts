import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Candidate, InterviewEvent } from "@/data/candidates";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

const PAGE_SIZE = 1000;
// Keep chunks SMALL. PostgREST + supabase-js have payload + timeout limits, and
// a single oversized bulk upsert is the historical reason hundreds of candidates
// silently fail to persist. 50 rows ≈ a few KB so even big interview summaries fit.
const INSERT_CHUNK = 50;
// Bounded concurrency for row-by-row fallback. Fully sequential is too slow
// (300+ roundtrips), fully parallel triggers Supabase rate limiting.
const ROW_CONCURRENCY = 4;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// Coerce any unknown value to a string before trimming. Ashby occasionally returns
// numeric/boolean/object values where we expect text (e.g. latest_recommendation as
// a number, or a nested object). A naive `.trim()` would throw and abort the entire
// save — the bug behind "fetch finishes, no candidates persisted, no save report".
const toStringSafe = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
};

const cleanRequiredText = (value: unknown, fallback: string) => {
  const trimmed = toStringSafe(value).trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const cleanOptionalText = (value: unknown) => {
  const trimmed = toStringSafe(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

const cleanInteger = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const cleanNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const cleanTimestamp = (value: unknown) => {
  const trimmed = toStringSafe(value).trim();
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
      console.log(
        `[saveSession] starting with ${newCandidates.length} candidates from ${
          new Set(newCandidates.map((c) => c.company_name)).size
        } companies`,
      );
      try {
        await supabase
          .from("pipeline_sessions")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", sessionId);

        // Build payload. Note: ashby_candidate_id and ashby_job_id are part of the
        // unique key (session_id, ashby_candidate_id, ashby_job_id) — ensure non-null.
        const droppedNoIds: Array<{ candidate_name: string; company_name: string }> = [];
        const candidatesToUpsert = newCandidates
          .filter((c) => {
            const ok = !!c.candidate_id && !!c.job_id;
            if (!ok) {
              droppedNoIds.push({
                candidate_name: c.candidate_name ?? "(no name)",
                company_name: c.company_name ?? "(unknown)",
              });
            }
            return ok;
          })
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

        if (droppedNoIds.length > 0) {
          console.warn(
            `[saveSession] dropped ${droppedNoIds.length} candidates missing candidate_id or job_id:`,
            droppedNoIds.slice(0, 20),
          );
        }
        console.log(
          `[saveSession] payload ready: ${candidatesToUpsert.length} rows after id filter`,
        );


        
        const incomingKeys = new Set(
          candidatesToUpsert.map((c) => candidateKey(c.ashby_candidate_id, c.ashby_job_id)),
        );

        // Idempotent upsert with row-by-row fallback. PostgreSQL's INSERT
        // ... ON CONFLICT fails the ENTIRE batch on any single-row error
        // (NOT NULL, oversized payload, duplicate keys in the same VALUES
        // list, request timeout). Before small chunks + bounded fallback,
        // a single bad row would silently drop every other row in the same
        // chunk — the bug behind "only 38 of 373 candidates persisted"
        // across Reducto / Luminai / Trajectory / Factory / etc.
        const upsertFailures: Array<{
          candidate_name: string;
          company_name: string;
          ashby_candidate_id: string;
          ashby_job_id: string;
          reason: string;
        }> = [];

        // Pre-dedupe by key. Duplicates in a single bulk VALUES list cause
        // "ON CONFLICT DO UPDATE command cannot affect row a second time"
        // and fail the whole chunk. Keep the LAST occurrence (latest state).
        const byKey = new Map<string, (typeof candidatesToUpsert)[number]>();
        for (const row of candidatesToUpsert) {
          byKey.set(candidateKey(row.ashby_candidate_id, row.ashby_job_id), row);
        }
        const dedupedRows = Array.from(byKey.values());

        const upsertSingle = async (row: (typeof candidatesToUpsert)[number]) => {
          let lastErr: { message?: string; details?: string; hint?: string; code?: string } | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const { error: rowErr } = await supabase
                .from("candidates")
                .upsert([row], { onConflict: "session_id,ashby_candidate_id,ashby_job_id" });
              if (!rowErr) return;
              lastErr = rowErr;
              // Don't retry deterministic schema errors (NOT NULL, CHECK, FK).
              if (rowErr.code && /^23/.test(rowErr.code)) break;
            } catch (e) {
              lastErr = { message: (e as Error)?.message ?? "thrown" };
            }
            await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
          }
          console.error(
            `Row upsert failed for ${row.candidate_name} @ ${row.company_name}:`,
            { ...lastErr, row },
          );
          upsertFailures.push({
            candidate_name: row.candidate_name,
            company_name: row.company_name,
            ashby_candidate_id: row.ashby_candidate_id,
            ashby_job_id: row.ashby_job_id,
            reason: lastErr?.message ?? "unknown",
          });
        };

        // First pass: small bulk chunks with `.select()` so PostgREST RETURNS
        // the persisted rows. We then RECONCILE the chunk: any input row whose
        // key is missing from the response goes through row-by-row fallback.
        // This is the fix for the silent-drop bug — previously the chunk
        // upsert returned `error: null` even when some/all rows weren't
        // persisted (no error thrown, no rows in DB), and we trusted that
        // success was global.
        let totalBulkOk = 0;
        let totalFallback = 0;
        for (let i = 0; i < dedupedRows.length; i += INSERT_CHUNK) {
          const chunk = dedupedRows.slice(i, i + INSERT_CHUNK);
          let bulkErr: { message?: string } | null = null;
          let returned: { ashby_candidate_id: string | null; ashby_job_id: string | null }[] = [];
          try {
            const { data, error } = await supabase
              .from("candidates")
              .upsert(chunk, { onConflict: "session_id,ashby_candidate_id,ashby_job_id" })
              .select("ashby_candidate_id, ashby_job_id");
            bulkErr = error as { message?: string } | null;
            returned = data ?? [];
          } catch (e) {
            bulkErr = { message: (e as Error)?.message ?? "thrown" };
          }
          if (bulkErr) {
            console.warn(
              `[saveSession] bulk chunk ${i}-${i + chunk.length} errored: ${bulkErr.message}; falling back row-by-row.`,
            );
            const before = upsertFailures.length;
            await runWithConcurrency(chunk, ROW_CONCURRENCY, upsertSingle);
            totalFallback += chunk.length - (upsertFailures.length - before);
            continue;
          }
          const returnedKeys = new Set(
            returned
              .filter((r) => r.ashby_candidate_id && r.ashby_job_id)
              .map((r) => candidateKey(r.ashby_candidate_id!, r.ashby_job_id!)),
          );
          const dropped = chunk.filter(
            (row) => !returnedKeys.has(candidateKey(row.ashby_candidate_id, row.ashby_job_id)),
          );
          totalBulkOk += chunk.length - dropped.length;
          if (dropped.length > 0) {
            console.warn(
              `[saveSession] bulk chunk ${i}-${i + chunk.length} silently dropped ${dropped.length}/${chunk.length} rows; falling back row-by-row.`,
            );
            const before = upsertFailures.length;
            await runWithConcurrency(dropped, ROW_CONCURRENCY, upsertSingle);
            totalFallback += dropped.length - (upsertFailures.length - before);
          }
        }
        console.log(
          `[saveSession] upsert pass complete: bulk_ok=${totalBulkOk} fallback_ok=${totalFallback} failures=${upsertFailures.length}`,
        );




        // Read back what's in the DB after upsert to know real saved IDs and reconcile.
        let savedRows: { id: string; ashby_candidate_id: string | null; ashby_job_id: string | null }[] = [];
        try {
          savedRows = await selectAll<{
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
        } catch (e) {
          console.error("Reading back saved rows failed:", e);
        }

        // Build id-by-key from the freshly-read saved rows.
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

        // Sync semantics: delete rows that are no longer in the incoming
        // payload. Only delete stale rows — never delete rows whose upsert
        // just failed (they'd vanish from the DB until the next successful
        // fetch, which is exactly the bug we're trying to prevent).
        const failedKeys = new Set(
          upsertFailures.map((f) => candidateKey(f.ashby_candidate_id, f.ashby_job_id)),
        );
        const idsToDelete = savedRows
          .filter((r) => {
            if (!r.ashby_candidate_id || !r.ashby_job_id) return true;
            const key = candidateKey(r.ashby_candidate_id, r.ashby_job_id);
            return !incomingKeys.has(key) && !failedKeys.has(key);
          })
          .map((r) => r.id);

        if (idsToDelete.length > 0) {
          for (let i = 0; i < idsToDelete.length; i += INSERT_CHUNK) {
            const chunk = idsToDelete.slice(i, i + INSERT_CHUNK);
            try {
              const { error: delErr } = await supabase
                .from("candidates")
                .delete()
                .in("id", chunk);
              if (delErr) console.error("Stale delete chunk failed:", delErr.message);
            } catch (e) {
              console.error("Stale delete threw:", e);
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
            if (!ev.start_time || !ev.id) continue;
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
          try {
            const { error: evErr } = await supabase
              .from("interview_events")
              .upsert(chunk as unknown as never, {
                onConflict: "candidate_row_id,ashby_event_id",
              });
            if (evErr) console.error(`Event upsert chunk ${i} failed:`, evErr.message);
          } catch (e) {
            console.error(`Event upsert chunk ${i} threw:`, e);
          }
        }

        setCandidates(newCandidates);
        setLastUpdated(new Date().toISOString());

        // Reconciliation: anything in the incoming payload that's not in the
        // DB readback is missing. Merge with explicit per-row failures so we
        // can surface the actual error reason in the saved report.
        const failureByKey = new Map(
          upsertFailures.map((f) => [candidateKey(f.ashby_candidate_id, f.ashby_job_id), f.reason]),
        );
        const missing = dedupedRows
          .filter((c) => !savedKeys.has(candidateKey(c.ashby_candidate_id, c.ashby_job_id)))
          .map((c) => ({
            candidate_name: c.candidate_name,
            company_name: c.company_name,
            ashby_candidate_id: c.ashby_candidate_id,
            ashby_job_id: c.ashby_job_id,
            reason:
              failureByKey.get(candidateKey(c.ashby_candidate_id, c.ashby_job_id)) ??
              "not in DB readback",
          }));

        const saved = dedupedRows.length - missing.length;
        const elapsedMs = Math.round(performance.now() - t0);

        // Persist auditable report (best-effort; don't block UX on failure).
        try {
          const { error } = await supabase.from("pipeline_save_reports").insert({
            user_id: user.id,
            session_id: sessionId,
            expected_count: dedupedRows.length,
            saved_count: saved,
            missing,
          });
          if (error) console.warn("save report insert failed:", error.message);
        } catch (e) {
          console.warn("save report insert threw:", e);
        }

        if (missing.length === 0) {
          toast.success(`Saved ${saved} candidates in ${(elapsedMs / 1000).toFixed(1)}s`);
        } else {
          // Group missing by company for a more useful toast.
          const byCompany = new Map<string, number>();
          for (const m of missing) {
            byCompany.set(m.company_name, (byCompany.get(m.company_name) ?? 0) + 1);
          }
          const summary = Array.from(byCompany.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([co, n]) => `${co} (${n})`)
            .join(", ");
          toast.warning(
            `Saved ${saved}/${dedupedRows.length}. ${missing.length} missing — ${summary}${
              byCompany.size > 3 ? "…" : ""
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
