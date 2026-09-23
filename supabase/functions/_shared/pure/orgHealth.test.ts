import { describe, expect, it } from "vitest";
import * as h from "./orgHealth";

const NOW = new Date("2026-09-11T14:00:00Z");
const row = (name: string, company: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  candidate_name: name, company_name: company, org_id: "", decision_status: "Needs Decision",
  stage_type: "Active", credited_to: "David Kimball", ...extra,
});

describe("rowDataAgeDays", () => {
  it("fresh row has zero age", () => {
    expect(h.rowDataAgeDays(row("A", "Cleric", { last_activity_at: "2026-05-13T00:00:00Z", days_in_stage: 121 }), NOW)).toBe(0);
  });
  it("stale row reports days behind", () => {
    expect(h.rowDataAgeDays(row("A", "Prometheus", { last_activity_at: "2026-07-11T00:00:00Z", days_in_stage: 28 }), NOW)).toBe(34);
  });
  it("missing fields / booleans return null", () => {
    expect(h.rowDataAgeDays(row("A", "X"), NOW)).toBeNull();
    expect(h.rowDataAgeDays(row("A", "X", { last_activity_at: "2026-07-11T00:00:00Z" }), NOW)).toBeNull();
    expect(h.rowDataAgeDays(row("A", "X", { last_activity_at: "2026-07-11T00:00:00Z", days_in_stage: true }), NOW)).toBeNull();
  });
});

describe("learnAliasesFromRows / resolveAliases", () => {
  it("shared org_id with one swept name is a rename", () => {
    const rows = [row("A", "Klarity", { org_id: "o1" }), row("B", "Within", { org_id: "o1" })];
    expect(h.learnAliasesFromRows(rows, ["Within"])).toEqual({ klarity: "Within" });
  });
  it("no swept name / two swept names prove nothing", () => {
    const rows = [row("A", "Klarity", { org_id: "o1" }), row("B", "Within", { org_id: "o1" })];
    expect(h.learnAliasesFromRows(rows, [])).toEqual({});
    expect(h.learnAliasesFromRows(rows, ["Within", "Klarity"])).toEqual({});
  });
  it("rows without org_id cannot be learned; a configured alias covers it", () => {
    const rows = [row("A", "Forge"), row("B", "Poetic")];
    expect(h.learnAliasesFromRows(rows, ["Poetic"])).toEqual({});
    expect(h.resolveAliases(rows, ["Poetic"], { forge: "Poetic" })).toEqual({ forge: "Poetic" });
  });
  it("alias chains collapse", () => {
    expect(h.resolveAliases([], [], { a: "B", b: "C" })).toEqual({ a: "C", b: "C" });
  });
});

describe("applyOrgAliases", () => {
  it("rewrites the company and keeps history, idempotently", () => {
    const rows = [row("A", "Forge"), row("B", "Cleric")];
    const first = h.applyOrgAliases(rows, { forge: "Poetic" });
    expect(first.renamed.length).toBe(1);
    expect(rows[0].company_name).toBe("Poetic");
    expect(rows[0].previous_company_names).toEqual(["Forge"]);
    expect(h.applyOrgAliases(rows, { forge: "Poetic" }).renamed.length).toBe(0);
    expect(rows[1].company_name).toBe("Cleric");
  });
});

describe("markRetiredOrgs", () => {
  it("marks retired rows without claiming an outcome, clears when access returns", () => {
    const rows = [row("A", "Prometheus"), row("B", "Cleric")];
    const m = h.markRetiredOrgs(rows, new Set(["prometheus"]), NOW);
    expect(m.marked.length).toBe(1);
    expect(rows[0].org_status).toBe("retired");
    expect(rows[0].decision_status).toBe("Needs Decision");
    expect(h.markRetiredOrgs(rows, new Set(["prometheus"]), NOW).marked.length).toBe(0);
    const c = h.markRetiredOrgs(rows, new Set(), NOW);
    expect(c.cleared.length).toBe(1);
    expect(rows[0].org_status).toBeNull();
  });
});

describe("auditOrgCoverage", () => {
  it("unswept company with live rows is a blind spot with its stalest age", () => {
    const rows = [row("A", "Ghost Co", { last_activity_at: "2026-07-11T00:00:00Z", days_in_stage: 28 }), row("B", "Cleric")];
    const a = h.auditOrgCoverage(rows, ["Cleric"], {}, new Set(), NOW);
    expect(a.blind_spots.map((s) => s.company)).toEqual(["Ghost Co"]);
    expect(a.blind_spots[0].stalest_data_age_days).toBe(34);
    expect(a.healthy_companies).toBe(1);
  });
  it("retired and renamed are reported separately", () => {
    const a = h.auditOrgCoverage([row("A", "Prometheus")], ["Cleric"], {}, new Set(["prometheus"]), NOW);
    expect(a.blind_spots).toEqual([]);
    expect(a.retired[0].company).toBe("Prometheus");
    const b = h.auditOrgCoverage([row("A", "Forge")], ["Poetic"], { forge: "Poetic" }, new Set(), NOW);
    expect(b.blind_spots).toEqual([]);
    expect(b.renamed_pending[0].current_name).toBe("Poetic");
  });
  it("done rows and placeholders never raise a blind spot", () => {
    expect(h.auditOrgCoverage([row("A", "Ghost", { decision_status: "Archived" })], ["Cleric"], {}, new Set(), NOW).blind_spots).toEqual([]);
    expect(h.auditOrgCoverage([row("A", "Ghost", { stage_type: "" })], ["Cleric"], {}, new Set(), NOW).blind_spots).toEqual([]);
  });
  it("sorts stalest first and an empty swept set flags everything", () => {
    const rows = [
      row("A", "Newer", { last_activity_at: "2026-09-01T00:00:00Z", days_in_stage: 5 }),
      row("B", "Older", { last_activity_at: "2026-07-11T00:00:00Z", days_in_stage: 28 }),
    ];
    const a = h.auditOrgCoverage(rows, [], {}, new Set(), NOW);
    expect(a.blind_spots.map((s) => s.company)).toEqual(["Older", "Newer"]);
  });
  it("log format names every blind spot", () => {
    const lines = h.formatAuditForLog(h.auditOrgCoverage([row("A", "Ghost Co", { last_activity_at: "2026-07-11T00:00:00Z", days_in_stage: 28 })], [], {}, new Set(), NOW));
    expect(lines[0]).toContain("BLIND SPOTS");
    expect(lines.slice(1).some((l) => l.includes("Ghost Co") && l.includes("34d stale"))).toBe(true);
    expect(h.formatAuditForLog(h.auditOrgCoverage([row("A", "Cleric")], ["Cleric"], {}, new Set(), NOW))[0]).toContain("coverage OK");
  });
});
