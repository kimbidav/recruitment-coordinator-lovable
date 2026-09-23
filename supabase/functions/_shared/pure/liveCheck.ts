// Live Ashby archive check — verify the snapshot against Ashby before the
// agent trusts it. Port of the desktop coordinator's ashby_live_check.py.
//
// The snapshot only changes when a sweep PERSISTS, and a sweep can be lost
// (timeout, verification error, a blip mid-sweep). Two days of drift was
// enough for archived candidates to keep surfacing as "Stale Intro" follow-ups
// and as live rows on the dashboard (2026-09-10). An Ashby follow-up card
// should only exist when there is a real follow-up to do, and Ashby is the
// authority on that. The extractor's archive-status endpoint answers "is this
// application archived, and why" for up to 50 applications per call.
//
// Confirm-or-skip, same rule as the merge: a row is stamped only on
// `found && is_archived`. "Couldn't check" leaves the row exactly as it was.

import { type ArchiveVerdict, looksHired } from "./ashbyMerge.ts";
import { isLiveRealRow, type Row } from "./orgHealth.ts";

export type { Row };

export const BATCH_SIZE = 50;
/** How long a live-verified "Scheduled" outranks stale saved interview events. */
export const LIVE_STATUS_TRUST_DAYS = 3;

export interface AppRef {
  application_id: string;
  org_id: string;
}

/**
 * Pick the applications worth asking Ashby about: every live real row that
 * `isMine` accepts, plus any live row whose application id is in `extra`
 * (records behind pending cards, whatever they are credited to). Placeholder
 * rows, done rows, retired orgs and rows without ids are skipped. Output is
 * de-duplicated and grouped by org so a batch switches org as rarely as
 * possible.
 */
export function selectApplications(
  rows: Iterable<Row>,
  isMine: (row: Row) => boolean,
  opts: { extraApplicationIds?: Iterable<string>; maxApps?: number } = {},
): AppRef[] {
  const extra = new Set(Array.from(opts.extraApplicationIds ?? []).filter(Boolean));
  const picked = new Map<string, AppRef>();
  for (const row of rows) {
    if (!isLiveRealRow(row)) continue;
    if (row.org_status === "retired") continue; // can never be switched into
    const appId = String(row.application_id ?? "").trim();
    const orgId = String(row.org_id ?? "").trim();
    if (!appId || !orgId || picked.has(appId)) continue;
    if (!isMine(row) && !extra.has(appId)) continue;
    picked.set(appId, { application_id: appId, org_id: orgId });
  }
  const ordered = Array.from(picked.values()).sort((a, b) => a.org_id.localeCompare(b.org_id));
  return ordered.slice(0, Math.max(0, opts.maxApps ?? 200));
}

export interface LiveCheckSummary {
  archived: string[];
  hired: string[];
  still_live: number;
  unverifiable: number;
  unverifiable_rows: string[];
  status_synced: string[];
  status_verified: number;
  /** Rows changed by this pass — persist these. */
  changed: Row[];
}

/**
 * Stamp every row whose application Ashby reports archived; for rows still
 * live, sync `decision_status` from Ashby's current application status and
 * stamp `status_verified_live(_at)` so a fresh "Scheduled" can be trusted
 * over stale saved interview events. Rows sharing an application id (a
 * merged Ashby profile) are all stamped.
 */
export function applyVerdicts(rows: Row[], verdicts: Map<string, ArchiveVerdict>, now: Date = new Date()): LiveCheckSummary {
  const stampAt = now.toISOString();
  const summary: LiveCheckSummary = {
    archived: [], hired: [], still_live: 0, unverifiable: 0, unverifiable_rows: [],
    status_synced: [], status_verified: 0, changed: [],
  };
  const seenLive = new Set<string>();
  const seenUnverifiable = new Set<string>();
  const label = (row: Row) => `${row.candidate_name || "?"} @ ${row.company_name || "?"}`;
  for (const row of rows) {
    const appId = String(row.application_id ?? "").trim();
    const verdict = appId ? verdicts.get(appId) : undefined;
    if (!verdict || !isLiveRealRow(row)) continue;
    if (!verdict.found) {
      if (!seenUnverifiable.has(appId)) summary.unverifiable_rows.push(label(row));
      seenUnverifiable.add(appId);
      continue;
    }
    if (!verdict.is_archived) {
      const liveStatus = (verdict.status_description ?? "").trim();
      if (liveStatus) {
        const prior = String(row.decision_status ?? "").trim();
        if (prior.toLowerCase() !== liveStatus.toLowerCase()) {
          summary.status_synced.push(`${label(row)}: ${prior || "-"} → ${liveStatus}`);
        }
        row.decision_status = liveStatus;
        row.status_verified_live = liveStatus;
        row.status_verified_live_at = stampAt;
        summary.status_verified++;
        summary.changed.push(row);
      }
      seenLive.add(appId);
      continue;
    }
    const hired = looksHired(verdict);
    row.decision_status = hired ? "Hired" : "Archived";
    row.archived_reason = verdict.archive_reason_text ?? null;
    row.archived_reason_type = verdict.archive_reason_type ?? null;
    row.archived_inferred = false;
    row.archived_detected_at = stampAt;
    row.archived_verified_live_at = stampAt;
    (hired ? summary.hired : summary.archived).push(label(row));
    summary.changed.push(row);
  }
  summary.still_live = seenLive.size;
  summary.unverifiable = seenUnverifiable.size;
  return summary;
}

/**
 * True when a live verification within `trustDays` saw Ashby report
 * "Scheduled" and nothing has changed the row's decision since. Ashby only
 * says Scheduled while an interview is on the calendar, so this outranks
 * saved interview events that are all in the past (Srirag Tatavarti @
 * Phonic, 2026-09-10).
 */
export function liveStatusTrustedScheduled(row: Row, now: Date = new Date(), trustDays = LIVE_STATUS_TRUST_DAYS): boolean {
  if (!row || typeof row !== "object") return false;
  if (String(row.decision_status ?? "").trim().toLowerCase() !== "scheduled") return false;
  if (String(row.status_verified_live ?? "").trim().toLowerCase() !== "scheduled") return false;
  const t = Date.parse(String(row.status_verified_live_at ?? ""));
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  return age >= 0 && age <= trustDays * 86_400_000;
}

/**
 * Is this real row scheduled per Ashby? A future interview event, or a
 * "Scheduled" decision that is either freshly verified live or not
 * contradicted by past-only saved events.
 */
export function ashbyIsScheduled(row: Row, now: Date = new Date()): boolean {
  if (!row || typeof row !== "object") return false;
  const events = Array.isArray(row.interview_events) ? (row.interview_events as Row[]) : [];
  const times = events.map((e) => Date.parse(String(e?.start_time ?? ""))).filter(Number.isFinite);
  if (times.some((t) => t > now.getTime())) return true;
  if (String(row.decision_status ?? "").trim().toLowerCase() !== "scheduled") return false;
  if (liveStatusTrustedScheduled(row, now)) return true;
  // "Scheduled" with saved events that are all in the past is a contradiction
  // (stale enrichment) unless the live check vouched for it above.
  return times.length === 0;
}

export type Verifier = (batch: AppRef[]) => Promise<ArchiveVerdict[]>;

export interface LiveCheckResult extends LiveCheckSummary {
  requested: number;
  orgs: number;
  answered: number;
  errors: string[];
}

/** Verify `applications` in batches and stamp `rows` in place. A batch that errors is skipped. */
export async function runLiveArchiveCheck(
  rows: Row[],
  applications: AppRef[],
  verifier: Verifier,
  opts: { now?: Date; batchSize?: number } = {},
): Promise<LiveCheckResult> {
  const now = opts.now ?? new Date();
  const batchSize = Math.max(1, opts.batchSize ?? BATCH_SIZE);
  const verdicts = new Map<string, ArchiveVerdict>();
  const errors: string[] = [];
  for (let start = 0; start < applications.length; start += batchSize) {
    const batch = applications.slice(start, start + batchSize);
    const requested = new Set(batch.map((a) => a.application_id));
    try {
      for (const v of await verifier(batch)) {
        if (v && typeof v.application_id === "string" && requested.has(v.application_id)) verdicts.set(v.application_id, v);
      }
    } catch (err) {
      errors.push(`batch ${start / batchSize + 1}: ${String((err as Error)?.message ?? err)}`);
    }
  }
  const summary = applyVerdicts(rows, verdicts, now);
  return {
    ...summary,
    requested: applications.length,
    orgs: new Set(applications.map((a) => a.org_id)).size,
    answered: verdicts.size,
    errors,
  };
}
