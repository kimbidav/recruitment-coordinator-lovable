// Agent rules that encode business judgment, ported from the desktop
// coordinator's agent_runner.py so the edge function and vitest share them.

import { companiesMatch } from "./companyMatch.ts";

// ── Email signals must be about THIS client ─────────────────────────────
//
// A multi-loop candidate's emails about client B surface while reasoning
// about client A (Akshaya Dinesh's "completed the Nooks onsite" email became
// a check-in card on her Listenlabs process). The model reports
// about_this_client + mentioned_company; a result explicitly about another
// company is no signal for this process, and when the retrieval was not
// scoped to the client, "unclear" is not good enough either.

export interface EmailSignalInput {
  outcome: string;
  about_this_client?: string | boolean | null;
  mentioned_company?: string | null;
  scheduled_time?: string | null;
  evidence?: string;
  client_email_domain?: string | null;
  confidence?: string | null;
}

export interface EmailSignalVerdict {
  outcome: string;
  suppressed: boolean;
  reason: string | null;
  mentioned_company: string;
}

export function emailSignalForClient(
  result: EmailSignalInput,
  opts: { clientName: string; scoped: boolean; now?: Date },
): EmailSignalVerdict {
  const about = String(result.about_this_client ?? "").trim().toLowerCase();
  const mentioned = (result.mentioned_company ?? "").trim();
  const otherCompany = !!mentioned && !!opts.clientName && !companiesMatch(mentioned, opts.clientName);
  if (about === "false" || about === "no" || otherCompany || (!opts.scoped && about !== "true")) {
    return {
      outcome: "not_scheduled",
      suppressed: true,
      reason: `emails concern ${mentioned || "another company"}, not ${opts.clientName}`,
      mentioned_company: mentioned,
    };
  }
  if (result.outcome === "scheduled") {
    // A scheduled verdict must carry a current-or-future date; an old or
    // unparseable one does not establish a scheduled interview.
    const t = Date.parse(result.scheduled_time ?? "");
    const today = (opts.now ?? new Date()).getTime() - 86_400_000;
    if (!Number.isFinite(t) || t < today) {
      return { outcome: "not_scheduled", suppressed: false, reason: "scheduled verdict without a current or future date", mentioned_company: mentioned };
    }
  }
  return { outcome: result.outcome, suppressed: false, reason: null, mentioned_company: mentioned };
}

/** A client domain may be learned only from emails confirmed to be about this client at high confidence. */
export function mayLearnDomain(result: EmailSignalInput, domain: string | null | undefined): boolean {
  const d = (domain ?? "").trim().toLowerCase();
  if (!d || d.includes("@") || d.includes(" ")) return false;
  if (["candidatelabs.com", "gmail.com"].includes(d)) return false;
  return String(result.about_this_client ?? "").trim().toLowerCase() === "true" && String(result.confidence ?? "").toLowerCase() === "high";
}

// ── Calendar tier 3 runs on the ambiguous candidate set only ────────────
//
// Exact and fuzzy matching need both a name token and a company signal.
// The model is asked only about events that carry SOME signal (a company
// token, or a first-name initial/prefix) — never the last N arbitrary
// events — and may only pick indices from the list it was shown.

export interface CalendarEventLike { summary: string; attendees: string[] }

export function ambiguousCalendarCandidates<T extends CalendarEventLike>(
  events: T[],
  candidateName: string,
  company: string,
  limit = 15,
): T[] {
  const fn = (candidateName.trim().split(/\s+/)[0] || "").toLowerCase();
  const tokens = company.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const out: T[] = [];
  for (const e of events) {
    const t = (e.summary || "").toLowerCase();
    const blob = `${t} ${e.attendees.join(" ").toLowerCase()}`;
    const companySignal = tokens.some((tok) => blob.includes(tok));
    const nameSignal = !!fn && (new RegExp(`\\b${fn.slice(0, 3)}`).test(t) || new RegExp(`\\b${fn[0]}\\b`).test(t) || new RegExp(`\\b${fn[0]}[.\\s]`).test(t));
    if (companySignal || nameSignal) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** Map the model's chosen indices back onto the list it was shown; anything else is ignored. */
export function pickShownEvents<T>(shown: T[], indices: unknown): T[] {
  if (!Array.isArray(indices)) return [];
  const out: T[] = [];
  for (const i of indices) {
    if (Number.isInteger(i) && i >= 0 && i < shown.length) out.push(shown[i as number]);
  }
  return out;
}

// ── Unscheduled follow-ups: one card per candidate ──────────────────────
//
// Only ✅-accepted intros get individual stale nudges; unresponded intros are
// lower priority and only surface, per candidate, when a client has 2+ stale
// unscheduled candidates — that pattern usually means the CLIENT has gone
// quiet. Replaces the old single "N candidates" batch card.

export interface UnscheduledRow {
  id: string;
  client_name: string;
  candidate_name: string;
  status: string;
  submitted_at: string;
  last_activity_at?: string | null;
}

export function unscheduledFollowupGroups(
  rows: UnscheduledRow[],
  opts: { threshold?: number; stallDays?: number; quietDays?: number; now?: Date; isSuppressed?: (r: UnscheduledRow) => boolean },
): Map<string, UnscheduledRow[]> {
  const now = (opts.now ?? new Date()).getTime();
  const threshold = Math.max(2, opts.threshold ?? 2);
  const stallMs = (opts.stallDays ?? 3) * 86_400_000;
  const quietMs = (opts.quietDays ?? 3) * 86_400_000;
  const groups = new Map<string, UnscheduledRow[]>();
  for (const r of rows) {
    if (r.status !== "submitted") continue; // accepted intros already have stale-intro cards
    if (!r.candidate_name || !r.client_name) continue;
    if (now - Date.parse(r.submitted_at) < stallMs) continue;
    const act = Date.parse(r.last_activity_at ?? r.submitted_at);
    if (Number.isFinite(act) && now - act < quietMs) continue; // a live thread means a human is on it
    if (opts.isSuppressed?.(r)) continue;
    const existingKey = Array.from(groups.keys()).find((k) => companiesMatch(k, r.client_name)) ?? r.client_name;
    if (!groups.has(existingKey)) groups.set(existingKey, []);
    groups.get(existingKey)!.push(r);
  }
  for (const [k, list] of groups) if (list.length < threshold) groups.delete(k);
  return groups;
}

export type QueueSection = "slack" | "ashby";

/** Which review queue a card belongs in — computed once at enqueue time. */
export function queueSectionFor(isAshbyClient: boolean): QueueSection {
  return isAshbyClient ? "ashby" : "slack";
}
