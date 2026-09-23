import { describe, expect, it } from "vitest";
import { inferArchivedCandidates, mergeCandidateRecords, type RawRecord } from "./ashbyMerge";

const real = (id: string, company: string, extra: RawRecord = {}): RawRecord => ({
  candidate_id: id, job_id: `job-${id}`, candidate_name: `Cand ${id}`, company_name: company,
  stage_type: "Active", decision_status: "Needs Decision", application_id: `app-${id}`, org_id: `org-${company}`,
  ...extra,
});
const enriched = (id: string, company: string, extra: RawRecord = {}) =>
  real(id, company, { interview_events: [{ id: "ev1", start_time: "2026-09-01T10:00:00Z" }], feedback_count: 2, ...extra });

const noVerify = async () => [];

describe("mergeCandidateRecords — downgrade guard", () => {
  it("a thin real row still merges into an enriched one (done-sweep can archive)", () => {
    const existing = [enriched("a", "Reducto")];
    const incoming = [real("a", "Reducto", { decision_status: "Archived", archived_reason: "Lacks skills" })];
    const out = mergeCandidateRecords(existing, incoming);
    expect(out.stats.downgrade_skipped).toBe(0);
    expect(out.records[0].decision_status).toBe("Archived");
    expect((out.records[0].interview_events as unknown[]).length).toBe(1); // enrichment kept
    expect(out.records[0].feedback_count).toBe(2);
  });
  it("a placeholder (stage_type='') never stomps an enriched record", () => {
    const existing = [enriched("a", "Reducto")];
    const incoming = [real("a", "Reducto", { stage_type: "", decision_status: "Closed" })];
    const out = mergeCandidateRecords(existing, incoming);
    expect(out.stats.downgrade_skipped).toBe(1);
    expect(out.records[0].decision_status).toBe("Needs Decision");
  });
  it("a live real row clears stale archive stamps (auto-unarchive is complete)", () => {
    const existing = [real("a", "Reducto", {
      decision_status: "Archived", archived_reason: "Did not respond", archived_reason_type: "x",
      archived_inferred: true, archived_detected_at: "2026-08-01T00:00:00Z",
    })];
    const out = mergeCandidateRecords(existing, [real("a", "Reducto", { decision_status: "In Process" })]);
    const r = out.records[0];
    expect(r.decision_status).toBe("In Process");
    expect(r.archived_reason).toBeNull();
    expect(r.archived_inferred).toBeUndefined();
    expect(r.archived_detected_at).toBeUndefined();
  });
});

describe("inferArchivedCandidates — confirm-or-skip", () => {
  it("stamps only on found && is_archived; unverifiable rows stay frozen", async () => {
    const existing = [real("a", "Cleric"), real("b", "Cleric"), real("c", "Cleric"), real("d", "Cleric"), real("e", "Cleric")];
    const out = mergeCandidateRecords(existing, [real("c", "Cleric"), real("d", "Cleric"), real("e", "Cleric")]);
    const res = await inferArchivedCandidates(out, new Set(["cleric"]), async (apps) =>
      apps.map((a) =>
        a.application_id === "app-a"
          ? { application_id: a.application_id, found: true, is_archived: true, archive_reason_text: "Lacks skills", archive_reason_type: "other" }
          : { application_id: a.application_id, found: false, is_archived: false },
      ));
    expect(res.archived_inferred).toBe(1);
    expect(res.unverified_skipped).toBe(1);
    expect(out.records.find((r) => r.candidate_id === "a")!.decision_status).toBe("Archived");
    expect(out.records.find((r) => r.candidate_id === "a")!.archived_inferred).toBe(false);
    expect(out.records.find((r) => r.candidate_id === "b")!.decision_status).toBe("Needs Decision");
  });
  it("verification error leaves verifiable rows frozen (never confirm-or-stamp)", async () => {
    const existing = [real("a", "Cleric"), real("b", "Cleric"), real("c", "Cleric")];
    const out = mergeCandidateRecords(existing, [real("b", "Cleric"), real("c", "Cleric")]);
    const res = await inferArchivedCandidates(out, new Set(["cleric"]), async () => { throw new Error("org switch 401"); });
    expect(res.verification_failed).toBe(true);
    expect(res.stamped).toEqual([]);
    expect(out.records[0].decision_status).toBe("Needs Decision");
  });
  it("legacy rows without application_id fall back to the bare inference stamp", async () => {
    const legacy = real("a", "Cleric", { application_id: undefined, org_id: undefined });
    const out = mergeCandidateRecords([legacy, real("b", "Cleric"), real("c", "Cleric")], [real("b", "Cleric"), real("c", "Cleric")]);
    const res = await inferArchivedCandidates(out, new Set(["cleric"]), noVerify);
    expect(res.archived_inferred).toBe(1);
    expect(out.records[0].archived_inferred).toBe(true);
  });
  it("hired is detected from the reason", async () => {
    const out = mergeCandidateRecords([real("a", "Cleric"), real("b", "Cleric"), real("c", "Cleric")], [real("b", "Cleric"), real("c", "Cleric")]);
    const res = await inferArchivedCandidates(out, new Set(["cleric"]), async (apps) =>
      apps.map((a) => ({ application_id: a.application_id, found: true, is_archived: true, archive_reason_text: "Hired!", archive_reason_type: "Hired" })));
    expect(res.hired_detected).toBe(1);
    expect(out.records[0].decision_status).toBe("Hired");
  });
  it("a still-live verdict is never stamped", async () => {
    const out = mergeCandidateRecords([real("a", "Cleric"), real("b", "Cleric"), real("c", "Cleric")], [real("b", "Cleric"), real("c", "Cleric")]);
    const res = await inferArchivedCandidates(out, new Set(["cleric"]), async (apps) =>
      apps.map((a) => ({ application_id: a.application_id, found: true, is_archived: false, status_description: "Scheduled" })));
    expect(res.stamped).toEqual([]);
  });
  it("the >50% circuit breaker skips inference when a sweep looks partial (the 470-candidate case)", async () => {
    const existing = Array.from({ length: 10 }, (_, i) => real(`c${i}`, "Cleric"));
    const out = mergeCandidateRecords(existing, [real("c0", "Cleric")]); // 9/10 missing
    let called = false;
    const res = await inferArchivedCandidates(out, new Set(["cleric"]), async () => { called = true; return []; });
    expect(res.guard_tripped).toBe(true);
    expect(called).toBe(false);
    expect(out.records.every((r) => r.decision_status === "Needs Decision")).toBe(true);
  });
  it("batches verification in 50s", async () => {
    const existing = Array.from({ length: 200 }, (_, i) => real(`c${i}`, "Cleric"));
    const present = existing.slice(0, 120);
    const out = mergeCandidateRecords(existing, present);
    const sizes: number[] = [];
    await inferArchivedCandidates(out, new Set(["cleric"]), async (apps) => { sizes.push(apps.length); return []; });
    expect(sizes).toEqual([50, 30]);
  });
  it("orgs not in the trusted set are never inferred", async () => {
    const out = mergeCandidateRecords([real("a", "Ghost")], []);
    const res = await inferArchivedCandidates(out, new Set(["cleric"]), noVerify);
    expect(res.stamped).toEqual([]);
  });
});
