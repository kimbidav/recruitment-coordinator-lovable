// ── Ashby-candidate parity helpers ────────────────────────────────────────────
// Ported from the local desktop app's agent_runner.py so the cloud agent runner
// reasons about Ashby ATS state the same way: archived/hired done-ness, "already
// scheduled" suppression, and the Step-5b scheduling/feedback-gap triggers.
//
// Pure functions only (no DB / no closures) so they're unit-testable in
// isolation — see ashby_parity_test.ts. Imported by index.ts.

export interface AshbyInterviewer {
  name?: string;
  email?: string;
  score?: string | null;
  feedback_submitted?: boolean;
  feedback_text?: string | null;
}
export interface AshbyEvent {
  id?: string;
  interview_title?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  interviewers?: AshbyInterviewer[] | null;
}
export interface CandRow {
  id: string;
  candidate_name: string;
  company_name: string;
  decision_status?: string | null;
  pipeline_stage?: string | null;
  days_in_stage?: number | null;
  current_stage_date?: string | null;
  current_stage_index?: number | null;
  total_stages?: number | null;
  needs_scheduling?: boolean | null;
  feedback_count?: number | null;
  interview_history_summary?: string | null;
  current_stage_interviews?: string | null;
  latest_recommendation?: string | null;
  latest_feedback_author?: string | null;
  latest_feedback_date?: string | null;
  current_stage_avg_score?: number | null;
  last_activity_at?: string | null;
  credited_to?: string | null;
  ashby_candidate_id?: string | null;
  interview_events?: AshbyEvent[] | null;
}

// Friday of ref's week; if ref falls Fri/Sat/Sun, the NEXT Friday (≥1 day
// buffer). Mirrors agent_runner._friday_of_week. UTC-based, anchored to 17:00.
export function fridayOfWeek(ref: Date): Date {
  const d = new Date(ref.getTime());
  const day = d.getUTCDay(); // Sun=0 .. Sat=6
  let delta: number;
  if (day >= 1 && day <= 4) delta = 5 - day; // Mon–Thu → this Friday
  else if (day === 5) delta = 7; // Fri → next Friday
  else if (day === 6) delta = 6; // Sat → next Friday
  else delta = 5; // Sun → Friday
  d.setUTCDate(d.getUTCDate() + delta);
  d.setUTCHours(17, 0, 0, 0);
  return d;
}

export function ashbyEventMs(e: AshbyEvent): number {
  return e.start_time ? new Date(e.start_time).getTime() : NaN;
}
export function ashbyFutureEvents(r: CandRow): AshbyEvent[] {
  const now = Date.now();
  return (r.interview_events ?? []).filter((e) => {
    const t = ashbyEventMs(e);
    return !isNaN(t) && t > now;
  });
}
export function ashbyPastEvents(r: CandRow): AshbyEvent[] {
  const now = Date.now();
  return (r.interview_events ?? []).filter((e) => {
    const t = ashbyEventMs(e);
    return !isNaN(t) && t < now;
  });
}
export function ashbyHasOnlyPastEvents(r: CandRow): boolean {
  const ev = r.interview_events ?? [];
  if (!ev.length) return false;
  const now = Date.now();
  return ev.every((e) => {
    const t = ashbyEventMs(e);
    return isNaN(t) ? false : t < now;
  });
}
// Done in Ashby — closed/rejected/archived, or Hired (a placement). No nudges.
export function isArchivedAshby(r: CandRow): boolean {
  return ["closed", "archived", "rejected", "hired"].includes((r.decision_status ?? "").trim().toLowerCase());
}

const ASHBY_ONSITE_RE = /\bon[-\s]?site\b/;
const ASHBY_MOVE_RES = [
  /\bmove\s+(?:him|her|them|the candidate|candidate)?\s*(?:forward\s+)?(?:to|into)?\s*on[-\s]?site\b/,
  /\bproceed\s+(?:to|with)?\s*on[-\s]?site\b/,
  /\badvance\s+(?:him|her|them|the candidate|candidate)?\s*(?:to|into)?\s*on[-\s]?site\b/,
  /\bworth moving\s+(?:him|her|them|the candidate|candidate)?\s*(?:forward\s+)?(?:to|into)?\s*an?\s*on[-\s]?site\b/,
  /\bon[-\s]?site invitation\b/,
];
// Feedback / stage text says the candidate should advance to onsite.
export function ashbyOnsiteMovementSignal(r: CandRow): boolean {
  const parts: string[] = [
    r.pipeline_stage ?? "",
    r.decision_status ?? "",
    r.current_stage_interviews ?? "",
    r.interview_history_summary ?? "",
  ];
  for (const e of r.interview_events ?? []) {
    parts.push(e.interview_title ?? "");
    for (const iv of e.interviewers ?? []) parts.push(iv.feedback_text ?? "");
  }
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  if (!ASHBY_ONSITE_RE.test(text)) return false;
  return ASHBY_MOVE_RES.some((re) => re.test(text));
}
// A stale decision_status="Scheduled" at a pre-onsite gate (all events past).
export function ashbyInferredNextStageFromStaleSchedule(r: CandRow): boolean {
  const stage = (r.pipeline_stage ?? "").trim().toLowerCase();
  const decision = (r.decision_status ?? "").trim().toLowerCase();
  if (
    !decision.includes("scheduled") ||
    stage.includes("onsite") ||
    ashbyFutureEvents(r).length ||
    !ashbyHasOnlyPastEvents(r)
  ) {
    return false;
  }
  const cur = Number(r.current_stage_index ?? 0);
  const tot = Number(r.total_stages ?? 0);
  if (tot > 0 && cur >= tot) return false;
  return ["virtual coding interview 2", "technical interview 2", "coding interview 2", "assessment"].some((m) =>
    stage.includes(m),
  );
}
// True when Ashby says the next round is on the calendar — used to suppress
// follow-up nudges. Mirrors agent_runner._ashby_is_scheduled.
export function ashbyIsScheduled(r: CandRow): boolean {
  if (ashbyFutureEvents(r).length) return true;
  if ((r.decision_status ?? "").trim().toLowerCase() !== "scheduled") return false;
  // Saved events all in the past → "Scheduled" is stale unless we can infer the
  // next pre-onsite gate; otherwise trust current_stage_date.
  if ((r.interview_events ?? []).length) return ashbyInferredNextStageFromStaleSchedule(r);
  const sd = r.current_stage_date ? new Date(r.current_stage_date).getTime() : NaN;
  if (!isNaN(sd)) return sd >= Date.now();
  return true;
}
// Ashby scheduling/feedback-gap trigger. Mirrors _ashby_candidate_trigger.
export function ashbyTrigger(r: CandRow, minDays: number): "ashby_missing_feedback" | "ashby_needs_scheduling" | null {
  if (ashbyIsScheduled(r)) return null;
  const hasPast = ashbyPastEvents(r).length > 0;
  const fb = r.feedback_count ?? 0;
  const history = r.interview_history_summary ?? "";
  if (hasPast && (fb === 0 || history.includes("No score"))) return "ashby_missing_feedback";
  const hasUpcoming = ashbyFutureEvents(r).length > 0;
  if (r.needs_scheduling) return "ashby_needs_scheduling";
  if (ashbyOnsiteMovementSignal(r) && !hasUpcoming) return "ashby_needs_scheduling";
  if (!hasUpcoming && (r.days_in_stage ?? 0) >= minDays) return "ashby_needs_scheduling";
  return null;
}
// Most recent activity timestamp for the Ashby staleness flags.
export function ashbyLatestActivityMs(r: CandRow): number | null {
  const ts = [r.last_activity_at, r.current_stage_date, r.latest_feedback_date]
    .map((s) => (s ? new Date(s).getTime() : NaN))
    .filter((n) => !isNaN(n));
  return ts.length ? Math.max(...ts) : null;
}
// "Last interview on May 7. " prefix to date-anchor the trigger summary.
export function ashbyLastInterviewPrefix(r: CandRow): string {
  const past = ashbyPastEvents(r).map(ashbyEventMs).filter((t) => !isNaN(t));
  if (!past.length) return "";
  const d = new Date(Math.max(...past)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Last interview on ${d}. `;
}
