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
// - R5 (narrowed): only a Slack-stub placeholder (stage_type="") is refused
//       as a downgrade. A real ATS row ALWAYS merges even without enrichment —
//       otherwise a bounded done-sweep row can never archive an enriched
//       candidate, and a restricted-summary live row can never revive an
//       archived one (the Charles Lin @ Reducto case). Per-field merge keeps
//       enrichment either way.
// - Auto-unarchive is complete: a live real row clears archived_* stamps.
// - Archive inference: a real row (stage_type set) from a successfully-swept
//   org that the fetch no longer returns has left the active pipeline; verify
//   WHY via the extractor's archive-status endpoint (Hired vs Archived), and
//   stamp. Reappearance auto-unarchives because decision_status always
//   overwrites.
//   CONFIRM-OR-SKIP, never confirm-or-stamp (post-incident rule, 2026-07-28):
//   a row that CAN be verified (has application_id + org_id) is stamped only
//   when the verdict is `found && is_archived`. "Couldn't check" (verification
//   errored, org switch failed, app not found) leaves the row frozen for the
//   next fetch. Only legacy rows with no application_id fall back to the bare
//   inference stamp. And a circuit breaker: when more than half the trusted-
//   org real rows go missing in one fetch, the sweep itself is suspect (a
//   half-dead session returning empty orgs as "swept" stamped 470 live
//   candidates as Archived) — skip inference entirely that fetch.

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

export const DONE_DECISIONS: ReadonlySet<string> = new Set(["closed", "archived", "rejected", "hired"]);

export function isDoneDecision(decision: unknown): boolean {
  return DONE_DECISIONS.has(String(decision ?? "").trim().toLowerCase());
}

/** A real ATS row (stage_type set) whose decision is not already done. */
export function isLiveRealRecord(rec: RawRecord): boolean {
  return isMeaningful(rec.stage_type) && !isDoneDecision(rec.decision_status);
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
    if (hasAtsDetail(prev) && !hasAtsDetail(inc) && !isMeaningful(inc.stage_type)) {
      // A placeholder that happens to share an identity must never stomp an
      // enriched record. (Real rows without enrichment fall through: the
      // per-field merge preserves enrichment and observed state must update.)
      map.set(k, { ...prev, fetched_at: stamp, fetch_source: "kept" });
      touchedKeys.add(k);
      downgradeSkipped++;
      continue;
    }
    const merged = mergeOneCandidate(prev, inc);
    if (isLiveRealRecord(inc)) {
      // Auto-unarchive must be complete: a live real row replacing a done
      // status takes the stale archive stamps with it, or the dashboard keeps
      // showing the old archive reason on a live process.
      merged.archived_reason = null;
      merged.archived_reason_type = null;
      delete merged.archived_inferred;
      delete merged.archived_detected_at;
      delete merged.archived_verified_live_at;
    }
    map.set(k, { ...merged, fetched_at: stamp, fetch_source: "merge" });
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
  /** Ashby's current application status for a live application ("Scheduled", …). */
  status_description?: string | null;
}

export interface ArchiveInferenceResult {
  /** Records stamped Archived/Hired by this pass — upsert these too. */
  stamped: RawRecord[];
  archived_inferred: number;
  hired_detected: number;
  /** Verifiable rows left frozen because no confirming verdict came back. */
  unverified_skipped: number;
  /** True when the >50% circuit breaker skipped inference this fetch. */
  guard_tripped: boolean;
  verification_failed: boolean;
}

export const ARCHIVE_STATUS_BATCH = 50; // the extractor caps each call

export function looksHired(verdict: ArchiveVerdict | undefined): boolean {
  const reasonType = (verdict?.archive_reason_type ?? "").toLowerCase();
  const reasonText = (verdict?.archive_reason_text ?? "").toLowerCase();
  return reasonType.includes("hire") || reasonText.includes("hire");
}

const EMPTY: ArchiveInferenceResult = {
  stamped: [],
  archived_inferred: 0,
  hired_detected: 0,
  unverified_skipped: 0,
  guard_tripped: false,
  verification_failed: false,
};

/**
 * Stamp stored records that vanished from a successfully-swept org.
 * `verify` resolves archiveReasons for verifiable applications; it is called
 * in batches of `ARCHIVE_STATUS_BATCH`. Any thrown error means "couldn't
 * check": verifiable rows stay untouched.
 */
export async function inferArchivedCandidates(
  outcome: MergeOutcome,
  trustedCompanyNames: Set<string>,
  verify: (apps: { application_id: string; org_id: string }[]) => Promise<ArchiveVerdict[]>,
  opts: { now?: Date; log?: (line: string) => void } = {},
): Promise<ArchiveInferenceResult> {
  const stamp = (opts.now ?? new Date()).toISOString();
  const log = opts.log ?? (() => {});
  if (trustedCompanyNames.size === 0) return { ...EMPTY };

  const inTrusted = (rec: RawRecord) => trustedCompanyNames.has(str(rec, "company_name").trim().toLowerCase());

  const missing: RawRecord[] = [];
  let trustedRealOnFile = 0;
  for (const rec of outcome.records) {
    if (!isMeaningful(rec.stage_type)) continue; // placeholder, not ATS state
    if (!inTrusted(rec)) continue; // org not swept this fetch
    trustedRealOnFile++;
    if (outcome.seenKeys.has(candidateIdentityKey(rec))) continue;
    if (isDoneDecision(rec.decision_status)) continue;
    missing.push(rec);
  }
  if (missing.length === 0) return { ...EMPTY };

  // Circuit breaker (the 2026-07-28 incident): a sweep that loses more than
  // half of the trusted-org real rows is partial or unhealthy, not informative.
  if (trustedRealOnFile > 0 && missing.length > trustedRealOnFile * 0.5) {
    log(
      `[ashby-merge] archival inference SKIPPED: ${missing.length}/${trustedRealOnFile} ` +
        "trusted-org candidates missing from this fetch — sweep looks partial/unhealthy.",
    );
    return { ...EMPTY, guard_tripped: true };
  }

  const verdicts = new Map<string, ArchiveVerdict>();
  const verifiable = missing
    .filter((r) => isMeaningful(r.application_id) && isMeaningful(r.org_id))
    .map((r) => ({ application_id: str(r, "application_id"), org_id: str(r, "org_id") }));
  let verificationFailed = false;
  for (let i = 0; i < verifiable.length; i += ARCHIVE_STATUS_BATCH) {
    const batch = verifiable.slice(i, i + ARCHIVE_STATUS_BATCH);
    try {
      for (const v of await verify(batch)) {
        if (v && typeof v.application_id === "string") verdicts.set(v.application_id, v);
      }
    } catch (err) {
      verificationFailed = true;
      log(`[ashby-merge] archive-status verification failed (batch ${i / ARCHIVE_STATUS_BATCH + 1}): ${String(err)}`);
    }
  }

  let archivedInferred = 0;
  let hiredDetected = 0;
  let unverifiedSkipped = 0;
  const stamped: RawRecord[] = [];
  for (const rec of missing) {
    const verifiableRow = isMeaningful(rec.application_id) && isMeaningful(rec.org_id);
    const verdict = verdicts.get(str(rec, "application_id"));
    if (verdict && verdict.found && !verdict.is_archived) {
      // Ashby says the application is still live — the sweep missed it for
      // some other reason (visibility, transfer). Don't stamp.
      continue;
    }
    const confirmed = !!(verdict && verdict.found && verdict.is_archived);
    if (verifiableRow && !confirmed) {
      // We could have verified but got no confirming answer. "Couldn't
      // check" is not evidence of archival — leave the row frozen.
      unverifiedSkipped++;
      continue;
    }
    // Legacy rows (no application_id) can never be verified; missing from a
    // trusted org is the best signal there is.
    const isHired = looksHired(verdict);
    rec.decision_status = isHired ? "Hired" : "Archived";
    rec.archived_reason = verdict?.archive_reason_text ?? null;
    rec.archived_reason_type = verdict?.archive_reason_type ?? null;
    rec.archived_inferred = !confirmed;
    rec.archived_detected_at = stamp;
    stamped.push(rec);
    if (isHired) hiredDetected++;
    else archivedInferred++;
  }
  if (unverifiedSkipped) {
    log(
      `[ashby-merge] archival inference: left ${unverifiedSkipped} candidate(s) unstamped ` +
        `(archive status unverifiable this fetch${verificationFailed ? ", verification errored" : ""}).`,
    );
  }
  return {
    stamped,
    archived_inferred: archivedInferred,
    hired_detected: hiredDetected,
    unverified_skipped: unverifiedSkipped,
    guard_tripped: false,
    verification_failed: verificationFailed,
  };
}
