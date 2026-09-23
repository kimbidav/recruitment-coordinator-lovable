import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Candidate, InterviewEvent } from "@/data/candidates";
import { getAshbyPipelineWarnings } from "@/lib/pipelineWarnings";
import type { Tables } from "@/integrations/supabase/types";
import type { OrgAudit } from "@shared/pure/orgHealth";

type SnapshotRow = Tables<"ashby_snapshot_candidates">;
export type OrgAliasRow = Tables<"ashby_org_aliases">;

const PAGE_SIZE = 1000;

// Processes Ashby has decided are over. They keep their badge (Hired vs
// Archived + reason tooltip) but live behind the archive toggle — no
// follow-up needed, so they don't crowd the active table or the stats.
const DONE_DECISIONS = new Set(["archived", "hired", "closed", "rejected"]);

function rowToCandidate(row: SnapshotRow): Candidate {
  const candidate: Candidate = {
    company_name: row.company_name,
    job_title: row.job_title ?? "—",
    job_id: row.ashby_job_id,
    candidate_name: row.candidate_name,
    candidate_id: row.ashby_candidate_id,
    pipeline_stage: row.pipeline_stage ?? "",
    decision_status: row.decision_status ?? "",
    stage_type: row.stage_type,
    current_stage_index: row.current_stage_index,
    total_stages: row.total_stages,
    stage_progress: row.stage_progress ?? "",
    last_activity_at: row.last_activity_at ?? "",
    days_in_stage: row.days_in_stage,
    needs_scheduling: row.needs_scheduling,
    credited_to: row.credited_to ?? "(unknown)",
    source: "ashby",
    feedback_count: row.feedback_count,
    latest_recommendation: row.latest_recommendation ?? undefined,
    latest_feedback_author: row.latest_feedback_author ?? undefined,
    latest_feedback_date: row.latest_feedback_date ?? undefined,
    current_stage_interviews: row.current_stage_interviews ?? undefined,
    current_stage_avg_score: row.current_stage_avg_score ?? undefined,
    current_stage_date: row.current_stage_date ?? undefined,
    interview_history_summary: row.interview_history_summary ?? undefined,
    interview_events: Array.isArray(row.interview_events)
      ? (row.interview_events as unknown as InterviewEvent[])
      : undefined,
    pipeline_data_source: "ashby",
    archived_reason: row.archived_reason,
    archived_inferred: row.archived_inferred ?? undefined,
    archived_reason_type: row.archived_reason_type,
    linkedin_url: row.linkedin_url,
    credited_to_email: row.credited_to_email,
    access_restricted: row.access_restricted ?? false,
    org_status: row.org_status,
  };
  const warnings = getAshbyPipelineWarnings(candidate);
  if (warnings.length > 0) candidate.data_quality_warnings = warnings;
  return candidate;
}

/**
 * The org-shared Ashby snapshot — the cloud equivalent of the desktop app's
 * data/ashby_candidates.json, written server-side by ashby-sync. This is the
 * pipeline's source of truth for Ashby rows; per-user `candidates` rows are
 * only a fallback (CSV uploads / pre-snapshot data).
 */
export function useAshbySnapshot() {
  const { user } = useAuth();
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [orgNames, setOrgNames] = useState<string[]>([]);
  const [orgAliases, setOrgAliases] = useState<Record<string, string>>({});
  const [retiredOrgs, setRetiredOrgs] = useState<string[]>([]);
  const [orgHealth, setOrgHealth] = useState<OrgAudit | null>(null);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);

  const refreshSnapshot = useCallback(async () => {
    if (!user) return;
    try {
      const all: SnapshotRow[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("ashby_snapshot_candidates")
          .select("*")
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        all.push(...((data ?? []) as SnapshotRow[]));
        if ((data ?? []).length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      setRows(all);

      const { data: orgs, error: orgErr } = await supabase.from("ashby_orgs").select("org_name");
      if (orgErr) throw orgErr;
      setOrgNames((orgs ?? []).map((o) => o.org_name).filter(Boolean));
      setSnapshotLoaded(true);

      // Org reachability (Package 4). Missing tables just mean the migration
      // is pending — the snapshot itself is already usable.
      try {
        const [{ data: aliasRows }, { data: retiredRows }, { data: healthRow }] = await Promise.all([
          supabase.from("ashby_org_aliases").select("stale_name,current_name,source"),
          supabase.from("ashby_retired_orgs").select("org_name"),
          supabase.from("ashby_org_health").select("audit").eq("id", 1).maybeSingle(),
        ]);
        const aliases: Record<string, string> = {};
        for (const r of [...(aliasRows ?? [])].sort((a, b) => (a.source === "manual" ? 1 : 0) - (b.source === "manual" ? 1 : 0))) {
          aliases[r.stale_name.trim().toLowerCase()] = r.current_name;
        }
        setOrgAliases(aliases);
        setRetiredOrgs((retiredRows ?? []).map((r) => r.org_name));
        setOrgHealth(((healthRow?.audit ?? null) as unknown as OrgAudit | null) ?? null);
      } catch (err) {
        console.warn("[snapshot] org health tables unavailable:", err);
      }
    } catch (err) {
      // Tables may not exist yet (migration pending) — the dashboard falls
      // back to the per-user candidates path.
      console.warn("[snapshot] load failed (falling back to per-user candidates):", err);
      setSnapshotLoaded(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  const { activeSnapshot, archivedSnapshot } = useMemo(() => {
    const active: Candidate[] = [];
    const archived: Candidate[] = [];
    for (const row of rows) {
      const candidate = rowToCandidate(row);
      const decision = (row.decision_status ?? "").trim().toLowerCase();
      if (DONE_DECISIONS.has(decision) || row.org_status === "retired") {
        // Retired = the team can no longer see this client's ATS. The row
        // leaves the active table like a done one, but its decision_status
        // is untouched — nothing is claimed about the candidate.
        candidate.is_historical = true;
        archived.push(candidate);
      } else {
        active.push(candidate);
      }
    }
    return { activeSnapshot: active, archivedSnapshot: archived };
  }, [rows]);

  return { activeSnapshot, archivedSnapshot, orgNames, orgAliases, retiredOrgs, orgHealth, snapshotLoaded, refreshSnapshot };
}
