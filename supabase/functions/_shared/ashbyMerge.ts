// Server-side accumulate-and-merge for Ashby snapshots (Deno port).
//
// Canonical implementation of the accumulate-and-merge rules
// (PRD: "Fix Ashby Fetch Data Loss") plus the archived/hired inference from
// the local desktop app's _save_ashby_candidates_preserving_detail. Operates
// on raw extractor records (Record<string, unknown>) so application_id /
// org_id and any future extractor fields survive untouched.
//
// Rules:
// - R1: never delete a stored candidate because this fetch didn't return them
// - R2: identity = ashby candidate_id (+job_id); rows without one are skipped
// - R3: per-field merge — meaningful incoming values win; stage/decision
//       fields ALWAYS overwrite (they must reflect the latest fetch)
// - R4: interview_events merge by event id; stored rounds never drop
// - R5: an enriched row is never downgraded by a thin re-fetch
// - Archive inference: a real row (stage_type set) from a successfully-swept
//   org that the fetch no longer returns has left the active pipeline; verify
//   WHY via the extractor's archive-status endpoint (Hired vs Archived), and
//   stamp. Reappearance auto-unarchives because decision_status always
//   overwrites.

export type RawRecord = Record<string, unknown>;

const ALWAYS_OVERWRITE: ReadonlySet<string> = new Set([
  "decision_status",
  "pipeline_stage",
  "current_stage_index",
  "total_stages",
  "stage_progress",
  "stage_type",
  "last_activity_at",
  "needs_scheduling",
]);

export function isMeaningful(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (typeof v === "number") return v !== 0 && Number.isFinite(v);
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function str(rec: RawRecord, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

/** Identity key. Extractor rows always carry an Ashby candidate_id; the
 * name+company fallback only exists for legacy rows. */
export function candidateIdentityKey(rec: RawRecord): string {
  const id = str(rec, "candidate_id").trim();
  const job = str(rec, "job_id").trim();
  if (id && !id.startsWith("slack:")) {
    return job && !job.startsWith("slack:") ? `id:${id}::${job}` : `id:${id}`;
  }
  return `nc:${str(rec, "candidate_name").toLowerCase().trim()}|${str(rec, "company_name").toLowerCase().trim()}`;
}

export function hasAtsDetail(rec: RawRecord): boolean {
  const events = rec.interview_events;
  if (Array.isArray(events) && events.length > 0) return true;
  if (
    isMeaningful(rec.current_stage_interviews) ||
    isMeaningful(rec.current_stage_date) ||
    isMeaningful(rec.interview_history_summary) ||
    isMeaningful(rec.current_stage_avg_score) ||
    isMeaningful(rec.latest_feedback_author) ||
    isMeaningful(rec.latest_feedback_date) ||
    isMeaningful(rec.latest_recommendation)
  ) {
    return true;
  }
  if (typeof rec.feedback_count === "number" && rec.feedback_count > 0) return true;
  if (
    (typeof rec.total_stages === "number" && rec.total_stages > 0) ||
    (typeof rec.current_stage_index === "number" && rec.current_stage_index > 0)
  ) {
    return true;
  }
  return false;
}

type RawEvent = Record<string, unknown>;

export function mergeInterviewEvents(existing: RawEvent[], incoming: RawEvent[]): RawEvent[] {
  const order: string[] = [];
  const map = new Map<string, RawEvent>();
  existing.forEach((ev, i) => {
    const k = (typeof ev.id === "string" && ev.id) || `_legacy_${i}`;
    if (!map.has(k)) order.push(k);
    map.set(k, ev);
  });
  incoming.forEach((ev, i) => {
    const k = (typeof ev.id === "string" && ev.id) || `_new_${i}`;
    const prev = map.get(k);
    if (!prev) {
      order.push(k);
      map.set(k, ev);
      return;
    }
    const merged: RawEvent = { ...prev };
    for (const key of Object.keys(ev)) {
      const v = ev[key];
      if (!isMeaningful(v)) continue;
      if (key === "interviewers" && Array.isArray(prev.interviewers) && (prev.interviewers as unknown[]).length > 0) {
        const byName = new Map<string, RawRecord>();
        for (const iv of prev.interviewers as RawRecord[]) {
          byName.set((str(iv, "name") || str(iv, "email")).toLowerCase(), iv);
        }
        for (const iv of (ev.interviewers as RawRecord[]) ?? []) {
          const k2 = (str(iv, "name") || str(iv, "email")).toLowerCase();
          const p = byName.get(k2);
          if (!p) {
            byName.set(k2, iv);
          } else {
            const m: RawRecord = { ...p };
            for (const f of Object.keys(iv)) {
              if (isMeaningful(iv[f])) m[f] = iv[f];
            }
            byName.set(k2, m);
          }
        }
        merged.interviewers = Array.from(byName.values());
      } else {
        merged[key] = v;
      }
    }
    map.set(k, merged);
  });
  return order.map((k) => map.get(k)!).filter(Boolean);
}

function mergeOneCandidate(existing: RawRecord, incoming: RawRecord): RawRecord {
  const out: RawRecord = { ...existing };
  for (const key of Object.keys(incoming)) {
    if (key === "interview_events") continue;
    const v = incoming[key];
    if (ALWAYS_OVERWRITE.has(key)) {
      out[key] = v;
    } else if (isMeaningful(v)) {
      out[key] = v;
    }
  }
  out.interview_events = mergeInterviewEvents(
    (existing.interview_events as RawEvent[]) ?? [],
    (incoming.interview_events as RawEvent[]) ?? [],
  );
  return out;
}

export interface MergeOutcome {
  records: RawRecord[];
  /** Identity keys present in THIS fetch (for archive inference). */
  seenKeys: Set<string>;
  /** Records created or changed by this merge — the only rows worth upserting. */
  touched: RawRecord[];
  stats: {
    added: number;
    updated: number;
    kept: number;
    downgrade_skipped: number;
    skipped_no_id: number;
    total: number;
  };
}

export function mergeCandidateRecords(existing: RawRecord[], incoming: RawRecord[]): MergeOutcome {
  const stamp = new Date().toISOString();
  const order: string[] = [];
  const map = new Map<string, RawRecord>();
  for (const rec of existing) {
    const k = candidateIdentityKey(rec);
    if (!map.has(k)) order.push(k);
    map.set(k, rec);
  }

  const seenKeys = new Set<string>();
  const touchedKeys = new Set<string>();
  let added = 0;
  let updated = 0;
  let downgradeSkipped = 0;
  let skippedNoId = 0;

  for (const inc of incoming) {
    const id = str(inc, "candidate_id").trim();
    if (!id || id.startsWith("slack:")) {
      // The snapshot is ATS truth — Slack-only/synthetic rows never enter it.
      skippedNoId++;
      continue;
    }
    const k = candidateIdentityKey(inc);
    seenKeys.add(k);
    const prev = map.get(k);
    if (!prev) {
      order.push(k);
      map.set(k, { ...inc, fetched_at: stamp, fetch_source: "new" });
      touchedKeys.add(k);
      added++;
      continue;
    }
    if (hasAtsDetail(prev) && !hasAtsDetail(inc)) {
      map.set(k, { ...prev, fetched_at: stamp, fetch_source: "kept" });
      touchedKeys.add(k);
      downgradeSkipped++;
      continue;
    }
    map.set(k, { ...mergeOneCandidate(prev, inc), fetched_at: stamp, fetch_source: "merge" });
    touchedKeys.add(k);
    updated++;
  }

  const records = order.map((k) => map.get(k)!).filter(Boolean);
  return {
    records,
    seenKeys,
    touched: Array.from(touchedKeys).map((k) => map.get(k)!).filter(Boolean),
    stats: {
      added,
      updated,
      kept: Math.max(0, existing.length - updated - downgradeSkipped),
      downgrade_skipped: downgradeSkipped,
      skipped_no_id: skippedNoId,
      total: records.length,
    },
  };
}

export interface ArchiveVerdict {
  application_id?: string;
  found?: boolean;
  is_archived?: boolean;
  archive_reason_text?: string | null;
  archive_reason_type?: string | null;
}

export interface ArchiveInferenceResult {
  /** Records stamped Archived/Hired by this pass — upsert these too. */
  stamped: RawRecord[];
  archived_inferred: number;
  hired_detected: number;
}

const ALREADY_DONE = new Set(["closed", "archived", "rejected", "hired"]);

/**
 * Stamp stored records that vanished from a successfully-swept org.
 * `verify` resolves archiveReasons for verifiable applications (best-effort);
 * pass an empty implementation to fall back to bare inference stamps.
 */
export async function inferArchivedCandidates(
  outcome: MergeOutcome,
  trustedCompanyNames: Set<string>,
  verify: (apps: { application_id: string; org_id: string }[]) => Promise<ArchiveVerdict[]>,
): Promise<ArchiveInferenceResult> {
  const stamp = new Date().toISOString();
  if (trustedCompanyNames.size === 0) {
    return { stamped: [], archived_inferred: 0, hired_detected: 0 };
  }

  const missing: RawRecord[] = [];
  for (const rec of outcome.records) {
    if (outcome.seenKeys.has(candidateIdentityKey(rec))) continue;
    if (!isMeaningful(rec.stage_type)) continue; // placeholder, not ATS state
    const company = str(rec, "company_name").trim().toLowerCase();
    if (!trustedCompanyNames.has(company)) continue; // org not swept this fetch
    if (ALREADY_DONE.has(str(rec, "decision_status").trim().toLowerCase())) continue;
    missing.push(rec);
  }
  if (missing.length === 0) {
    return { stamped: [], archived_inferred: 0, hired_detected: 0 };
  }

  const verdicts = new Map<string, ArchiveVerdict>();
  const verifiable = missing
    .filter((r) => isMeaningful(r.application_id) && isMeaningful(r.org_id))
    .slice(0, 50)
    .map((r) => ({ application_id: str(r, "application_id"), org_id: str(r, "org_id") }));
  if (verifiable.length > 0) {
    try {
      for (const v of await verify(verifiable)) {
        if (v && typeof v.application_id === "string") verdicts.set(v.application_id, v);
      }
    } catch (err) {
      console.error("[ashby-merge] archive-status verification failed (using bare inference):", err);
    }
  }

  let archivedInferred = 0;
  let hiredDetected = 0;
  const stamped: RawRecord[] = [];
  for (const rec of missing) {
    const verdict = verdicts.get(str(rec, "application_id"));
    if (verdict && verdict.found && !verdict.is_archived) {
      // Ashby says the application is still live — the sweep missed it for
      // some other reason (visibility, transfer). Don't stamp.
      continue;
    }
    const reasonText = verdict?.archive_reason_text ?? null;
    const reasonType = (verdict?.archive_reason_type ?? "").toLowerCase();
    const isHired = reasonType.includes("hire") || (reasonText ?? "").toLowerCase().includes("hire");
    rec.decision_status = isHired ? "Hired" : "Archived";
    rec.archived_reason = reasonText;
    rec.archived_inferred = !(verdict && verdict.is_archived);
    rec.archived_detected_at = stamp;
    stamped.push(rec);
    if (isHired) hiredDetected++;
    else archivedInferred++;
  }

  return { stamped, archived_inferred: archivedInferred, hired_detected: hiredDetected };
}
