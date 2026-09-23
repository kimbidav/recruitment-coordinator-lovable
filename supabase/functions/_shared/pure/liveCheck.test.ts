import { describe, expect, it } from "vitest";
import * as lc from "./liveCheck";

const NOW = new Date("2026-09-11T14:00:00Z");
const row = (name: string, company: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  candidate_name: name, company_name: company, stage_type: "Active", decision_status: "Needs Decision",
  credited_to_email: "dk@candidatelabs.com", application_id: `app-${name}`, org_id: `org-${company}`, ...extra,
});
const mine = (r: Record<string, unknown>) => r.credited_to_email === "dk@candidatelabs.com";

describe("selectApplications", () => {
  it("picks only live real rows of mine with ids; extras whatever the credit; retired skipped", () => {
    const rows = [
      row("A", "Cleric"),
      row("B", "Cleric", { credited_to_email: "other@candidatelabs.com" }),
      row("C", "Cleric", { credited_to_email: "other@candidatelabs.com" }),
      row("D", "Cleric", { stage_type: "" }),
      row("E", "Cleric", { decision_status: "Archived" }),
      row("F", "Cleric", { application_id: "" }),
      row("G", "Prometheus", { org_status: "retired" }),
    ];
    const apps = lc.selectApplications(rows, mine, { extraApplicationIds: ["app-C"] });
    expect(apps.map((a) => a.application_id).sort()).toEqual(["app-A", "app-C"]);
  });
  it("groups by org and caps", () => {
    const rows = [row("A", "Zeta"), row("B", "Alpha"), row("C", "Alpha")];
    const apps = lc.selectApplications(rows, mine, { maxApps: 2 });
    expect(apps.map((a) => a.org_id)).toEqual(["org-Alpha", "org-Alpha"]);
  });
});

describe("applyVerdicts", () => {
  it("archived verdict stamps every row sharing the application", () => {
    const rows = [row("A", "Cleric"), row("A", "Cleric", { candidate_name: "A (merged)" })];
    const s = lc.applyVerdicts(rows, new Map([["app-A", { application_id: "app-A", found: true, is_archived: true, archive_reason_text: "Lacks skills", archive_reason_type: "other" }]]), NOW);
    expect(s.archived.length).toBe(2);
    expect(rows.every((r) => r.decision_status === "Archived" && r.archived_inferred === false && r.archived_verified_live_at)).toBe(true);
  });
  it("hired detected from reason", () => {
    const rows = [row("A", "Cleric")];
    const s = lc.applyVerdicts(rows, new Map([["app-A", { application_id: "app-A", found: true, is_archived: true, archive_reason_type: "Hired" }]]), NOW);
    expect(s.hired).toEqual(["A @ Cleric"]);
    expect(rows[0].decision_status).toBe("Hired");
  });
  it("live, not-found and unanswered rows are untouched (apart from status sync)", () => {
    const rows = [row("A", "Cleric"), row("B", "Cleric"), row("C", "Cleric")];
    const s = lc.applyVerdicts(rows, new Map([
      ["app-A", { application_id: "app-A", found: true, is_archived: false }],
      ["app-B", { application_id: "app-B", found: false, is_archived: false }],
    ]), NOW);
    expect(s.still_live).toBe(1);
    expect(s.unverifiable).toBe(1);
    expect(rows.every((r) => r.decision_status === "Needs Decision")).toBe(true);
    expect(s.changed).toEqual([]);
  });
  it("a live row takes Ashby's status and gets a verified stamp", () => {
    const rows = [row("A", "Phonic")];
    const s = lc.applyVerdicts(rows, new Map([["app-A", { application_id: "app-A", found: true, is_archived: false, status_description: "Scheduled" }]]), NOW);
    expect(rows[0].decision_status).toBe("Scheduled");
    expect(rows[0].status_verified_live).toBe("Scheduled");
    expect(rows[0].status_verified_live_at).toBe(NOW.toISOString());
    expect(s.status_synced).toEqual(["A @ Phonic: Needs Decision → Scheduled"]);
  });
});

describe("liveStatusTrustedScheduled / ashbyIsScheduled", () => {
  it("requires a fresh, matching verification", () => {
    const fresh = row("A", "Phonic", { decision_status: "Scheduled", status_verified_live: "Scheduled", status_verified_live_at: "2026-09-10T00:00:00Z" });
    expect(lc.liveStatusTrustedScheduled(fresh, NOW)).toBe(true);
    const old = { ...fresh, status_verified_live_at: "2026-09-01T00:00:00Z" };
    expect(lc.liveStatusTrustedScheduled(old, NOW)).toBe(false);
    const changed = { ...fresh, decision_status: "Needs Decision" };
    expect(lc.liveStatusTrustedScheduled(changed, NOW)).toBe(false);
  });
  it("past-only events contradict Scheduled unless verified live (Srirag @ Phonic)", () => {
    const past = [{ start_time: "2026-09-02T10:00:00Z" }];
    expect(lc.ashbyIsScheduled(row("A", "Phonic", { decision_status: "Scheduled", interview_events: past }), NOW)).toBe(false);
    expect(lc.ashbyIsScheduled(row("A", "Phonic", { decision_status: "Scheduled", interview_events: past, status_verified_live: "Scheduled", status_verified_live_at: "2026-09-11T00:00:00Z" }), NOW)).toBe(true);
    expect(lc.ashbyIsScheduled(row("A", "Phonic", { interview_events: [{ start_time: "2026-09-12T10:00:00Z" }] }), NOW)).toBe(true);
    expect(lc.ashbyIsScheduled(row("A", "Phonic", { decision_status: "Scheduled" }), NOW)).toBe(true);
  });
});

describe("runLiveArchiveCheck", () => {
  it("batches of fifty; a failed batch skips only its rows", async () => {
    const rows = Array.from({ length: 70 }, (_, i) => row(`c${String(i).padStart(2, "0")}`, "Cleric"));
    const apps = lc.selectApplications(rows, mine);
    let n = 0;
    const res = await lc.runLiveArchiveCheck(rows, apps, async (batch) => {
      n++;
      if (n === 2) throw new Error("timeout");
      return batch.map((a) => ({ application_id: a.application_id, found: true, is_archived: true, archive_reason_text: "x" }));
    }, { now: NOW });
    expect(res.requested).toBe(70);
    expect(res.answered).toBe(50);
    expect(res.errors.length).toBe(1);
    expect(res.archived.length).toBe(50);
    expect(rows.filter((r) => r.decision_status === "Needs Decision").length).toBe(20);
  });
});
