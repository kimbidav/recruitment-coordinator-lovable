// Ashby org reachability: renames, retirement, and blind-spot detection.
// Port of the desktop coordinator's ashby_org_health.py.
//
// WHY THIS EXISTS (incident 2026-09-11): the sweep derives its org list from
// the orgs the team seat can reach, and everything downstream keys off that
// list — trusted names gate archival inference, the live archive check can
// only verify applications in reachable orgs, the coverage badge is computed
// from it. Nothing compared that list against the companies that still had
// live rows on file, so when an org fell off the list its rows simply stopped
// refreshing: never updated, never verified, never archived, still rendering
// as a live pipeline. "80/80 orgs" kept logging healthy. Prometheus (161 live
// rows) went a month unnoticed; Forge had been renamed to Poetic; Klarity and
// Finch Legal were stale labels for orgs that WERE swept.
//
// THE RULES:
//  * Absence is SURFACED, never acted on. A company with live rows that is
//    not swept, not a known rename and not explicitly retired is a blind spot
//    on every refresh, with the measured age of its stalest row.
//  * Retirement is CONFIRMED BY A HUMAN, never inferred. Inferring it from
//    absence is the same shape as the 2026-07-28 incident.
//  * Renames are LEARNED where the data proves them: one org_id seen under
//    several names, exactly one of which is swept. Unprovable renames (rows
//    with no org_id, Forge -> Poetic) need a manual alias.
//
// Retired rows get org_status="retired", NOT decision_status="Archived".
// Archived means the client passed on the candidate; retired means we can no
// longer see the client's ATS. The dashboard must not conflate them.

import { DEFAULT_ORG_ALIASES } from "./companyMatch.ts";

export type Row = Record<string, unknown>;

export const DONE_DECISIONS: ReadonlySet<string> = new Set(["closed", "archived", "rejected", "hired"]);

export function norm(name: unknown): string {
  return String(name ?? "").trim().toLowerCase();
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** A real ATS row (stage_type set) whose decision is not already done. */
export function isLiveRealRow(row: Row): boolean {
  if (!row || typeof row !== "object") return false;
  if (!String(row.stage_type ?? "").trim()) return false;
  return !DONE_DECISIONS.has(norm(row.decision_status));
}

/**
 * How many days old this row's stage data is. The extractor writes
 * `days_in_stage` as the row's age AT FETCH TIME, so the gap between the
 * stored value and what today's clock would produce is exactly how long ago
 * the row was last genuinely fetched. `fetched_at` cannot be used for this:
 * it is stamped on every row the merge touches, including carried-forward
 * ones. Returns null when the row lacks the fields to measure.
 */
export function rowDataAgeDays(row: Row, now: Date = new Date()): number | null {
  const lastActivity = parseDate(row.last_activity_at);
  const days = row.days_in_stage;
  if (!lastActivity || typeof days !== "number" || !Number.isInteger(days)) return null;
  const elapsed = Math.floor((now.getTime() - lastActivity.getTime()) / 86_400_000);
  return Math.max(0, elapsed - days);
}

/**
 * Renames the data proves: one org_id under several company names, exactly
 * one of which is currently swept. Stale name -> current name.
 */
export function learnAliasesFromRows(rows: Iterable<Row>, sweptNames: Iterable<string>): Record<string, string> {
  const swept = new Set(Array.from(sweptNames, norm).filter(Boolean));
  const byOrg = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const orgId = String(row.org_id ?? "").trim();
    const company = String(row.company_name ?? "").trim();
    if (!orgId || !company) continue;
    if (!byOrg.has(orgId)) byOrg.set(orgId, new Set());
    byOrg.get(orgId)!.add(company);
  }
  const learned: Record<string, string> = {};
  for (const names of byOrg.values()) {
    if (names.size < 2) continue;
    const current = Array.from(names).filter((n) => swept.has(norm(n)));
    if (current.length !== 1) continue; // ambiguous or nothing swept — proves nothing
    for (const name of names) {
      if (norm(name) !== norm(current[0])) learned[norm(name)] = current[0];
    }
  }
  return learned;
}

/**
 * Full alias map: learned renames with the configured map layered on top
 * (config wins — it is the human-confirmed one). Chains collapse.
 */
export function resolveAliases(
  rows: Iterable<Row>,
  sweptNames: Iterable<string>,
  configured: Record<string, string> = DEFAULT_ORG_ALIASES,
): Record<string, string> {
  const merged: Record<string, string> = { ...learnAliasesFromRows(rows, sweptNames) };
  for (const [k, v] of Object.entries(configured)) {
    if (norm(k) && v.trim()) merged[norm(k)] = v.trim();
  }
  const resolved: Record<string, string> = {};
  for (const [stale, current] of Object.entries(merged)) {
    const seen = new Set([stale]);
    let target = current;
    while (merged[norm(target)] !== undefined && !seen.has(norm(target))) {
      seen.add(norm(target));
      target = merged[norm(target)];
    }
    if (norm(target) !== stale) resolved[stale] = target;
  }
  return resolved;
}

export function canonicalCompany(name: unknown, aliases: Record<string, string>): string {
  const raw = String(name ?? "").trim();
  return aliases[norm(raw)] ?? raw;
}

/**
 * Rewrite stale company names to the current org name, in place. The old
 * name is kept in `previous_company_names`. Returns the rows it changed.
 */
export function applyOrgAliases(rows: Row[], aliases: Record<string, string>): { renamed: Row[]; companies: Record<string, string> } {
  const renamed: Row[] = [];
  const companies: Record<string, string> = {};
  if (!Object.keys(aliases).length) return { renamed, companies };
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const current = String(row.company_name ?? "").trim();
    const target = aliases[norm(current)];
    if (!target || norm(target) === norm(current)) continue;
    const history = Array.isArray(row.previous_company_names) ? [...(row.previous_company_names as string[])] : [];
    if (current && !history.includes(current)) history.push(current);
    row.previous_company_names = history;
    row.company_name = target;
    companies[current] = target;
    renamed.push(row);
  }
  return { renamed, companies };
}

/**
 * Stamp org_status="retired" on rows whose org we no longer have access to,
 * and clear it on any row whose org is reachable again. Deliberately never
 * touches decision_status. Returns the rows it changed.
 */
export function markRetiredOrgs(rows: Row[], retired: Set<string>, now: Date = new Date()): { marked: Row[]; cleared: Row[] } {
  const marked: Row[] = [];
  const cleared: Row[] = [];
  const stampedAt = now.toISOString();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const company = norm(row.company_name);
    if (company && retired.has(company)) {
      if (row.org_status !== "retired") {
        row.org_status = "retired";
        row.org_retired_at = row.org_retired_at ?? stampedAt;
        marked.push(row);
      }
    } else if (row.org_status === "retired") {
      row.org_status = null;
      row.org_retired_at = null;
      cleared.push(row);
    }
  }
  return { marked, cleared };
}

export interface CoverageEntry {
  company: string;
  live_rows: number;
  stalest_data_age_days: number | null;
  /** Recruiter emails / credited_to names with live rows here. */
  recruiters: string[];
  current_name?: string;
}

export interface OrgAudit {
  checked_at: string;
  swept_orgs: number;
  companies_with_live_rows: number;
  healthy_companies: number;
  blind_spots: CoverageEntry[];
  retired: CoverageEntry[];
  renamed_pending: CoverageEntry[];
}

/**
 * Classify every company that still has live rows on file. `blind_spots` is
 * the finding that matters: live rows this sweep could not see and nobody has
 * explained, stalest first.
 */
export function auditOrgCoverage(
  rows: Iterable<Row>,
  sweptNames: Iterable<string>,
  aliases: Record<string, string> = {},
  retired: Set<string> = new Set(),
  now: Date = new Date(),
): OrgAudit {
  const swept = new Set(Array.from(sweptNames, norm).filter(Boolean));
  const liveByCompany = new Map<string, Row[]>();
  for (const row of rows) {
    if (!isLiveRealRow(row)) continue;
    const company = String(row.company_name ?? "").trim();
    if (!company) continue;
    if (!liveByCompany.has(company)) liveByCompany.set(company, []);
    liveByCompany.get(company)!.push(row);
  }
  const blind: CoverageEntry[] = [];
  const retiredReport: CoverageEntry[] = [];
  const renamedReport: CoverageEntry[] = [];
  let healthy = 0;
  for (const [company, group] of Array.from(liveByCompany.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const n = norm(company);
    const ages = group.map((r) => rowDataAgeDays(r, now)).filter((a): a is number => a !== null);
    const recruiters = Array.from(
      new Set(group.map((r) => String(r.credited_to_email ?? r.credited_to ?? "").trim()).filter(Boolean)),
    ).sort();
    const entry: CoverageEntry = {
      company,
      live_rows: group.length,
      stalest_data_age_days: ages.length ? Math.max(...ages) : null,
      recruiters,
    };
    if (retired.has(n)) retiredReport.push(entry);
    else if (swept.has(n)) healthy++;
    else if (aliases[n] !== undefined) {
      entry.current_name = aliases[n];
      renamedReport.push(entry);
    } else blind.push(entry);
  }
  blind.sort((a, b) => (b.stalest_data_age_days ?? 0) - (a.stalest_data_age_days ?? 0) || b.live_rows - a.live_rows);
  return {
    checked_at: now.toISOString(),
    swept_orgs: swept.size,
    companies_with_live_rows: liveByCompany.size,
    healthy_companies: healthy,
    blind_spots: blind,
    retired: retiredReport,
    renamed_pending: renamedReport,
  };
}

/** One line per blind spot so they are impossible to scroll past. */
export function formatAuditForLog(audit: OrgAudit): string[] {
  const spots = audit.blind_spots ?? [];
  if (!spots.length) {
    return [`[ashby-sync] Ashby org coverage OK: ${audit.healthy_companies} companies with live rows, all swept.`];
  }
  const lines = [
    `[ashby-sync] ⚠ Ashby ORG BLIND SPOTS: ${spots.length} company(ies) have live rows but were not swept and are not a known rename or retirement.`,
  ];
  for (const s of spots) {
    const age = s.stalest_data_age_days === null ? "age unknown" : `${s.stalest_data_age_days}d stale`;
    lines.push(
      `[ashby-sync]     ${s.company}: ${s.live_rows} live rows (${s.recruiters.length} recruiter(s)), ${age} — data cannot refresh until access returns. Retire it from the dashboard banner or restore access.`,
    );
  }
  return lines;
}
