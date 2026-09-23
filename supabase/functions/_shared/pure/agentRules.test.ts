import { describe, expect, it } from "vitest";
import * as r from "./agentRules";

const NOW = new Date("2026-08-21T18:00:00Z");

describe("emailSignalForClient", () => {
  it("unscoped retrieval requires explicit attribution", () => {
    const v = r.emailSignalForClient({ outcome: "interview_completed", about_this_client: "unclear" }, { clientName: "Listenlabs", scoped: false, now: NOW });
    expect(v.suppressed).toBe(true);
    expect(v.outcome).toBe("not_scheduled");
  });
  it("a conflicting company beats the model's claim (the Akshaya case)", () => {
    const v = r.emailSignalForClient({ outcome: "interview_completed", about_this_client: true, mentioned_company: "Nooks" }, { clientName: "Listenlabs", scoped: true, now: NOW });
    expect(v.suppressed).toBe(true);
    expect(v.reason).toContain("Nooks");
    const ok = r.emailSignalForClient({ outcome: "interview_completed", about_this_client: true, mentioned_company: "Listen Labs" }, { clientName: "Listenlabs", scoped: true, now: NOW });
    expect(ok.suppressed).toBe(false);
  });
  it("scheduled without a current or future date is not a signal", () => {
    for (const d of [null, "not-a-date", "2000-01-01"]) {
      const v = r.emailSignalForClient({ outcome: "scheduled", about_this_client: true, scheduled_time: d }, { clientName: "X", scoped: true, now: NOW });
      expect(v.outcome).toBe("not_scheduled");
    }
    const v = r.emailSignalForClient({ outcome: "scheduled", about_this_client: true, scheduled_time: "2026-08-25T10:00:00Z" }, { clientName: "X", scoped: true, now: NOW });
    expect(v.outcome).toBe("scheduled");
  });
  it("domains are learned only at high confidence about this client", () => {
    expect(r.mayLearnDomain({ outcome: "x", about_this_client: "true", confidence: "high" }, "luminai.com")).toBe(true);
    expect(r.mayLearnDomain({ outcome: "x", about_this_client: "true", confidence: "medium" }, "luminai.com")).toBe(false);
    expect(r.mayLearnDomain({ outcome: "x", about_this_client: "unclear", confidence: "high" }, "luminai.com")).toBe(false);
    expect(r.mayLearnDomain({ outcome: "x", about_this_client: "true", confidence: "high" }, "gmail.com")).toBe(false);
  });
});

describe("calendar tier 3 candidate set", () => {
  const ev = (summary: string, attendees: string[] = []) => ({ summary, attendees });
  it("first-name substring does not count; company or initial signal does", () => {
    const events = [ev("Vishu x Auctor"), ev("Dentist"), ev("A. Gupta / Phonic"), ev("Team sync", ["bob@phonic.com"]), ev("Yi x Altara")];
    const picked = r.ambiguousCalendarCandidates(events, "Aayush Gupta", "Phonic");
    expect(picked.map((e) => e.summary)).toEqual(["A. Gupta / Phonic", "Team sync"]);
  });
  it("the model can only pick events it was shown", () => {
    const shown = [ev("a"), ev("b")];
    expect(r.pickShownEvents(shown, [1, 5, -1, "0"]).map((e) => e.summary)).toEqual(["b"]);
    expect(r.pickShownEvents(shown, null)).toEqual([]);
  });
});

describe("unscheduled follow-up groups", () => {
  const iso = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  const row = (id: string, client: string, o: Partial<r.UnscheduledRow> = {}): r.UnscheduledRow => ({ id, client_name: client, candidate_name: `C${id}`, status: "submitted", submitted_at: iso(10), ...o });
  it("2+ quiet unaccepted intros at one client surface per candidate; accepted, fresh and active rows do not", () => {
    const rows = [
      row("1", "Cleric"), row("2", "Cleric AI"),
      row("3", "Cleric", { status: "accepted" }),
      row("4", "Cleric", { submitted_at: iso(1) }),
      row("5", "Cleric", { last_activity_at: iso(1) }),
      row("6", "Solo"),
    ];
    const g = r.unscheduledFollowupGroups(rows, { now: NOW });
    expect(Array.from(g.keys())).toEqual(["Cleric"]);
    expect(g.get("Cleric")!.map((x) => x.id)).toEqual(["1", "2"]);
  });
  it("threshold never drops below 2 and suppression hook applies", () => {
    const rows = [row("1", "Cleric"), row("2", "Cleric")];
    expect(r.unscheduledFollowupGroups(rows, { now: NOW, threshold: 1 }).get("Cleric")!.length).toBe(2);
    expect(r.unscheduledFollowupGroups(rows, { now: NOW, isSuppressed: (x) => x.id === "2" }).size).toBe(0);
  });
});
