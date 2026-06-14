// Unit tests for the Ashby-candidate parity logic ported from agent_runner.py.
// Run: deno test supabase/functions/agent-scan/ashby_parity_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ashbyIsScheduled,
  ashbyLastInterviewPrefix,
  ashbyLatestActivityMs,
  ashbyOnsiteMovementSignal,
  ashbyTrigger,
  type CandRow,
  fridayOfWeek,
  isArchivedAshby,
} from "./ashby_parity.ts";

const DAY = 86400000;
// Event times relative to the real "now" so the past/future split is deterministic.
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const base = (over: Partial<CandRow> = {}): CandRow => ({
  id: "c1",
  candidate_name: "Jane Doe",
  company_name: "Acme",
  decision_status: "Active",
  ...over,
});

// The scan loop's gate: card iff not archived, not scheduled, and a trigger fires.
const wouldCard = (r: CandRow, min = 3) =>
  !isArchivedAshby(r) && !ashbyIsScheduled(r) ? ashbyTrigger(r, min) : null;

// ── Scenario (a): archived/hired → suppressed ────────────────────────────────
Deno.test("archived/hired decision statuses are 'done'", () => {
  for (const s of ["Closed", "Archived", "Rejected", "Hired", "archived", "HIRED"]) {
    assert(isArchivedAshby(base({ decision_status: s })), `${s} should be archived`);
  }
  assert(!isArchivedAshby(base({ decision_status: "Active" })));
  assert(!isArchivedAshby(base({ decision_status: "Scheduled" })));
  // Even with a would-be trigger, the loop gate suppresses an archived row.
  assertEquals(wouldCard(base({ decision_status: "Hired", needs_scheduling: true })), null);
});

// ── Scenario (b): already scheduled in Ashby → suppressed ─────────────────────
Deno.test("future interview event ⇒ scheduled ⇒ no card", () => {
  const r = base({ interview_events: [{ id: "e", start_time: iso(2 * DAY) }] });
  assert(ashbyIsScheduled(r));
  assertEquals(wouldCard(r), null);
});

Deno.test("decision=Scheduled with no events trusts current_stage_date", () => {
  assert(ashbyIsScheduled(base({ decision_status: "Scheduled", current_stage_date: iso(3 * DAY) })));
  assert(!ashbyIsScheduled(base({ decision_status: "Scheduled", current_stage_date: iso(-3 * DAY) })));
  // No events, no stage date → trust the Scheduled label.
  assert(ashbyIsScheduled(base({ decision_status: "Scheduled" })));
});

Deno.test("stale Scheduled (all events past): inferred pre-onsite gate vs surfacing", () => {
  // At a recognized pre-onsite gate ("Assessment") → still treated as scheduled.
  const atGate = base({
    decision_status: "Scheduled",
    pipeline_stage: "Assessment",
    current_stage_index: 1,
    total_stages: 5,
    interview_events: [{ start_time: iso(-5 * DAY) }],
  });
  assert(ashbyIsScheduled(atGate));
  // At an UNrecognized stage → "Scheduled" is stale, so it surfaces (the
  // Evan-Shrestha case): missing feedback because the past round has no scores.
  const stale = base({
    decision_status: "Scheduled",
    pipeline_stage: "Recruiter Screen",
    current_stage_index: 1,
    total_stages: 5,
    interview_events: [{ start_time: iso(-5 * DAY) }],
    feedback_count: 0,
  });
  assert(!ashbyIsScheduled(stale));
  assertEquals(wouldCard(stale), "ashby_missing_feedback");
});

// ── Scenario (c): needs scheduling ───────────────────────────────────────────
Deno.test("in-stage ≥ minDays with no upcoming event ⇒ needs scheduling", () => {
  assertEquals(wouldCard(base({ days_in_stage: 6 }), 3), "ashby_needs_scheduling");
  // Fresh, no past events, no flag → nothing.
  assertEquals(wouldCard(base({ days_in_stage: 1 }), 3), null);
});

Deno.test("needs_scheduling flag fires regardless of days", () => {
  assertEquals(wouldCard(base({ needs_scheduling: true, days_in_stage: 0 }), 3), "ashby_needs_scheduling");
});

Deno.test("onsite-movement signal in interviewer feedback ⇒ needs scheduling", () => {
  const move = base({
    days_in_stage: 0,
    pipeline_stage: "Technical Screen",
    feedback_count: 1, // not missing feedback
    interview_events: [{
      start_time: iso(-2 * DAY),
      interviewers: [{ name: "Alec", feedback_text: "Strong — let's move them to onsite" }],
    }],
  });
  assert(ashbyOnsiteMovementSignal(move));
  assertEquals(wouldCard(move, 3), "ashby_needs_scheduling");
  // ...but a future event means it's already scheduled → suppressed.
  const upcoming = base({ ...move, interview_events: [{ start_time: iso(2 * DAY) }] });
  assertEquals(wouldCard(upcoming, 3), null);
});

// ── Scenario (d): missing feedback ───────────────────────────────────────────
Deno.test("past interview with no scorecards ⇒ missing feedback", () => {
  assertEquals(
    wouldCard(base({ interview_events: [{ start_time: iso(-2 * DAY) }], feedback_count: 0 }), 3),
    "ashby_missing_feedback",
  );
  // "No score" in the history summary also flags missing feedback.
  assertEquals(
    wouldCard(
      base({
        interview_events: [{ start_time: iso(-2 * DAY) }],
        feedback_count: 3,
        interview_history_summary: "Round 1 — No score yet",
      }),
      3,
    ),
    "ashby_missing_feedback",
  );
  // Past interview WITH feedback and fresh stage → nothing.
  assertEquals(
    wouldCard(base({ interview_events: [{ start_time: iso(-2 * DAY) }], feedback_count: 2, days_in_stage: 1 }), 3),
    null,
  );
});

// ── Friday-EOW rule (parity with _friday_of_week) ────────────────────────────
Deno.test("fridayOfWeek snaps to the right Friday", () => {
  const fri = (input: string) => fridayOfWeek(new Date(input)).toISOString().slice(0, 10);
  // Week of 2026-06-15 (Mon) … 2026-06-21 (Sun); Friday = 2026-06-19.
  assertEquals(fri("2026-06-15T12:00:00Z"), "2026-06-19"); // Mon → this Fri
  assertEquals(fri("2026-06-17T12:00:00Z"), "2026-06-19"); // Wed → this Fri
  assertEquals(fri("2026-06-18T12:00:00Z"), "2026-06-19"); // Thu → this Fri
  assertEquals(fri("2026-06-19T12:00:00Z"), "2026-06-26"); // Fri → NEXT Fri
  assertEquals(fri("2026-06-20T12:00:00Z"), "2026-06-26"); // Sat → NEXT Fri
  assertEquals(fri("2026-06-14T12:00:00Z"), "2026-06-19"); // Sun → this week's Fri
});

// ── Misc helpers ─────────────────────────────────────────────────────────────
Deno.test("ashbyLastInterviewPrefix date-anchors from the latest past event", () => {
  const r = base({
    interview_events: [
      { start_time: "2026-05-07T17:00:00Z" },
      { start_time: "2026-05-01T17:00:00Z" },
    ],
  });
  assertEquals(ashbyLastInterviewPrefix(r), "Last interview on May 7. ");
  assertEquals(ashbyLastInterviewPrefix(base({})), "");
});

Deno.test("ashbyLatestActivityMs picks the max of the three timestamps", () => {
  assertEquals(
    ashbyLatestActivityMs(base({
      last_activity_at: "2026-06-01T00:00:00Z",
      current_stage_date: "2026-06-10T00:00:00Z",
      latest_feedback_date: "2026-05-20T00:00:00Z",
    })),
    new Date("2026-06-10T00:00:00Z").getTime(),
  );
  assertEquals(ashbyLatestActivityMs(base({})), null);
});
