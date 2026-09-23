import { describe, expect, it } from "vitest";
import { buildUploadPayload, jobOrgCheck, retryExtra, stripLandedSteps, uniqueOrgByPrefix } from "./addToAshbyRules";

const SNAP = [
  { stage_type: "Active", company_name: "Prelim", ashby_job_id: "job-be" },
  { stage_type: "Active", company_name: "Reducto", ashby_job_id: "job-reducto" },
  { stage_type: "", company_name: "Reducto", ashby_job_id: "job-placeholder" },
];

describe("jobOrgCheck", () => {
  it("confirmed when the snapshot files the job under this org", () => {
    expect(jobOrgCheck(["job-be"], "Prelim", SNAP).status).toBe("confirmed");
  });
  it("mismatch when a job is on file under another client", () => {
    expect(jobOrgCheck(["job-be", "job-reducto"], "Prelim", SNAP)).toEqual({ status: "mismatch", conflicts: [{ job_id: "job-reducto", known_under: "Reducto" }] });
  });
  it("a new client is unconfirmed, and placeholder rows are not evidence", () => {
    expect(jobOrgCheck(["job-new"], "Prelim", SNAP).status).toBe("unconfirmed");
    expect(jobOrgCheck(["job-placeholder"], "Prelim", SNAP).status).toBe("unconfirmed");
  });
});

describe("uniqueOrgByPrefix", () => {
  const ORGS = ["Valon Tech", "Reducto", "Titan", "Titan", "Owner.com", "Boon Technologies, Inc.", "Ent"];
  it("resolves channel words to the only org with that prefix", () => {
    expect(uniqueOrgByPrefix("Valon Eng Ds", ORGS)).toBe("Valon Tech");
    expect(uniqueOrgByPrefix("Owner", ORGS)).toBe("Owner.com");
    expect(uniqueOrgByPrefix("Boon Technologies", ORGS)).toBe("Boon Technologies, Inc.");
  });
  it("ambiguous, short or partial-word prefixes match nothing", () => {
    for (const c of ["Titan", "Ent", "Val", "Redu", "Prelim"]) expect(uniqueOrgByPrefix(c, ORGS)).toBeNull();
  });
});

describe("retries never resend what landed", () => {
  it("drops a resume/note that already succeeded or was skipped", () => {
    const extra = retryExtra({ candidate_id: "c1", steps: { resume: "uploaded", note: "failed", application: "failed" } });
    expect(extra.resume).toBeNull();
    expect(extra).not.toHaveProperty("note_text");
    expect(extra.existing_candidate_id).toBe("c1");
    expect(retryExtra({ candidate_id: "c1", steps: { resume: "skipped", note: "created" } })).toMatchObject({ resume: null, note_text: null });
  });
  it("stripLandedSteps is the server-side twin and ignores first uploads", () => {
    const first = stripLandedSteps({ resume: { filename: "x" }, note_text: "n", previous_steps: { resume: "uploaded", note: "created" } });
    expect(first.resume).toEqual({ filename: "x" });
    const retry = stripLandedSteps({ existing_candidate_id: "c1", resume: { filename: "x" }, note_text: "n", previous_steps: { resume: "uploaded", note: "failed" } });
    expect(retry.resume).toBeNull();
    expect(retry.note_text).toBe("n");
  });
});

describe("buildUploadPayload", () => {
  const prefill = { org_name: "Prelim", jobs: [{ id: "j1", title: "Backend Engineer" }], note_text: "full", resume: { filename: "cv.pdf" }, source_id: "s", channel_name: "candidatelabs-prelim-eng" };
  const form = { job_id: "j1", job_label: "", name: "Sophia", email: "", linkedin_url: "https://linkedin.com/in/s", include_resume: true, resume_pending: false, send_full_note: false, note_values: ["Intro", "More"] };
  it("joins the edited chunks, attaches the resume, and never sends credited-to", () => {
    const p = buildUploadPayload(prefill, form, ["\n\n", ""], false, "C1");
    expect(p).toMatchObject({ org_name: "Prelim", job_title: "Backend Engineer", note_text: "Intro\n\nMore", channel_id: "C1", added_via: "slack_shortcut" });
    expect(p.resume).toEqual({ filename: "cv.pdf" });
    expect(p).not.toHaveProperty("credited_to_user_id");
    expect((p.candidate as { email: string | null }).email).toBeNull();
  });
  it("a locked note is sent whole only when ticked; an unticked resume is left out", () => {
    expect(buildUploadPayload(prefill, { ...form, send_full_note: true, include_resume: false }, [], true, "C1")).toMatchObject({ note_text: "full", resume: null });
    expect(buildUploadPayload(prefill, { ...form, send_full_note: false }, [], true, "C1").note_text).toBeNull();
  });
});
