// Accumulate-and-merge logic for Ashby candidate fetches.
// See PRD: "Fix Ashby Fetch Data Loss (Accumulate-and-Merge)".
//
// Each Ashby fetch is frequently partial. The merge here protects stored data:
// - never delete a candidate just because this fetch didn't return them
// - never let a thin row blank out an enriched row
// - merge interview_events by event id so rounds accumulate across fetches
import { Candidate, InterviewEvent } from "@/data/candidates";

const ALWAYS_OVERWRITE: ReadonlySet<keyof Candidate> = new Set([
  "decision_status",
  "pipeline_stage",
  "current_stage_index",
  "total_stages",
  "stage_progress",
  "stage_type",
  "last_activity_at",
  "needs_scheduling",
]);

/** R3: "meaningful" = not null/undefined, not empty string, not empty array/object,
 *  and NOT numeric zero (protects a real `days_in_stage=7` from a partial fetch's 0). */
function isMeaningful(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (typeof v === "number") return v !== 0 && Number.isFinite(v);
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** R2: stable identity key. Prefer Ashby candidate_id; fall back to name+company. */
export function candidateIdentityKey(
  c: Pick<Candidate, "candidate_id" | "candidate_name" | "company_name" | "job_id">,
): string {
  const id = (c.candidate_id || "").trim();
  const job = (c.job_id || "").trim();
  // Slack-only rows use synthetic ids and should never match Ashby rows by id.
  if (id && !id.startsWith("slack:")) {
    // Same person across multiple jobs must NOT collapse — include job_id when present.
    return job && !job.startsWith("slack:") ? `id:${id}::${job}` : `id:${id}`;
  }
  const name = (c.candidate_name || "").toLowerCase().trim();
  const company = (c.company_name || "").toLowerCase().trim();
  return `nc:${name}|${company}`;
}

/** R5: does this row carry real ATS-side detail (rounds, feedback, stage data)? */
export function hasAtsDetail(c: Candidate): boolean {
  if (Array.isArray(c.interview_events) && c.interview_events.length > 0) return true;
  if (
    isMeaningful(c.current_stage_interviews) ||
    isMeaningful(c.current_stage_date) ||
    isMeaningful(c.interview_history_summary) ||
    isMeaningful(c.current_stage_avg_score) ||
    isMeaningful(c.latest_feedback_author) ||
    isMeaningful(c.latest_feedback_date) ||
    isMeaningful(c.latest_recommendation)
  ) {
    return true;
  }
  if ((c.feedback_count ?? 0) > 0) return true;
  if ((c.total_stages ?? 0) > 0 || (c.current_stage_index ?? 0) > 0) return true;
  return false;
}

/** R4: merge interview_events by event id; never drop a stored round. */
export function mergeInterviewEvents(
  existing: InterviewEvent[] = [],
  incoming: InterviewEvent[] = [],
): InterviewEvent[] {
  const order: string[] = [];
  const map = new Map<string, InterviewEvent>();
  existing.forEach((ev, i) => {
    const k = ev.id || `_legacy_${i}`;
    if (!map.has(k)) order.push(k);
    map.set(k, ev);
  });
  incoming.forEach((ev, i) => {
    const k = ev.id || `_new_${i}`;
    const prev = map.get(k);
    if (prev) {
      const merged: InterviewEvent = { ...prev };
      for (const key of Object.keys(ev) as (keyof InterviewEvent)[]) {
        const v = ev[key];
        if (isMeaningful(v)) {
          // Special case interviewers: prefer merge-by-name when both sides have entries.
          if (key === "interviewers" && Array.isArray(prev.interviewers) && prev.interviewers.length > 0) {
            const byName = new Map<string, NonNullable<InterviewEvent["interviewers"]>[number]>();
            for (const iv of prev.interviewers) byName.set((iv.name || iv.email || "").toLowerCase(), iv);
            for (const iv of ev.interviewers ?? []) {
              const k2 = (iv.name || iv.email || "").toLowerCase();
              const p = byName.get(k2);
              if (!p) {
                byName.set(k2, iv);
              } else {
                const m = { ...p };
                for (const f of Object.keys(iv) as (keyof typeof iv)[]) {
                  const vv = iv[f];
                  if (isMeaningful(vv)) (m as Record<string, unknown>)[f] = vv;
                }
                byName.set(k2, m);
              }
            }
            merged.interviewers = Array.from(byName.values());
          } else {
            (merged as unknown as Record<string, unknown>)[key as string] = v;
          }
        }
      }
      map.set(k, merged);
    } else {
      order.push(k);
      map.set(k, ev);
    }
  });
  return order.map((k) => map.get(k)!).filter(Boolean);
}

/** R3 + R5: merge a single incoming candidate into an existing stored one. */
function mergeOneCandidate(existing: Candidate, incoming: Candidate): Candidate {
  // R5 downgrade protection: keep enriched existing entirely if incoming is thin.
  if (hasAtsDetail(existing) && !hasAtsDetail(incoming)) {
    return existing;
  }
  const out: Candidate = { ...existing };
  for (const key of Object.keys(incoming) as (keyof Candidate)[]) {
    if (key === "interview_events") continue;
    const v = incoming[key];
    if (ALWAYS_OVERWRITE.has(key)) {
      (out as unknown as Record<string, unknown>)[key as string] = v as unknown;
    } else if (isMeaningful(v)) {
      (out as unknown as Record<string, unknown>)[key as string] = v as unknown;
    }
  }
  out.interview_events = mergeInterviewEvents(existing.interview_events, incoming.interview_events);
  return out;
}

export interface MergeStats {
  added: number;
  updated: number;
  kept: number;
  downgradeSkipped: number;
  total: number;
}

/** R1: produce a merged candidate set; existing rows are never deleted. */
export function mergeCandidates(
  existing: Candidate[],
  incoming: Candidate[],
): { merged: Candidate[]; stats: MergeStats } {
  const stamp = new Date().toISOString();
  const order: string[] = [];
  const map = new Map<string, Candidate>();
  for (const c of existing) {
    const k = candidateIdentityKey(c);
    if (!map.has(k)) order.push(k);
    map.set(k, c);
  }

  const touched = new Set<string>();
  let added = 0;
  let updated = 0;
  let downgradeSkipped = 0;

  for (const inc of incoming) {
    const k = candidateIdentityKey(inc);
    const prev = map.get(k);
    if (!prev) {
      order.push(k);
      map.set(k, stamp_(inc, stamp, "new"));
      touched.add(k);
      added++;
      continue;
    }
    if (hasAtsDetail(prev) && !hasAtsDetail(inc)) {
      // R9: stamp as "kept" — we observed a thin re-fetch but refused to merge.
      map.set(k, stamp_(prev, stamp, "kept"));
      touched.add(k);
      downgradeSkipped++;
      continue;
    }
    const merged = mergeOneCandidate(prev, inc);
    map.set(k, stamp_(merged, stamp, "merge"));
    touched.add(k);
    updated++;
  }

  const merged = order.map((k) => map.get(k)!).filter(Boolean);
  const kept = existing.length - updated - downgradeSkipped;
  return {
    merged,
    stats: { added, updated, kept, downgradeSkipped, total: merged.length },
  };
}

/** R9: stamp bookkeeping fields without polluting the public Candidate type. */
function stamp_(c: Candidate, at: string, source: "new" | "merge" | "kept"): Candidate {
  const o = c as Candidate & { _fetched_at?: string; _fetch_source?: string };
  o._fetched_at = at;
  o._fetch_source = source;
  return o;
}

/** R7: was this extraction partial (some orgs failed / extractor self-declared partial)? */
export function isPartialExtraction(stats: unknown): boolean {
  if (!stats || typeof stats !== "object") return false;
  const s = stats as Record<string, unknown>;
  if (s.partial === true) return true;
  const failed = typeof s.orgs_failed === "number" ? s.orgs_failed : 0;
  return failed > 0;
}
