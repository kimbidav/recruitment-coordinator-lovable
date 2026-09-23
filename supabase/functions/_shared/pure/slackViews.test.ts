import { describe, expect, it } from "vitest";
import { duplicateView, errorView, isClean, parseReview, resultDm, resultView, reviewView, sidFrom, REVIEW_CALLBACK, type Prefill } from "./slackViews";

const JOBS = [{ id: "job-be", title: "Backend Engineer", location: "NYC" }, { id: "job-fe", title: "Frontend Engineer", location: null }];
const prefill = (over: Partial<Prefill> = {}): Prefill => ({
  org_name: "Prelim", jobs: JOBS,
  candidate: { name: "Sophia Abolore", linkedin_url: "https://www.linkedin.com/in/sophia-abolore" },
  note_parts: ["Intro", "Experience Highlights"], note_text: "Intro\n\nExperience Highlights",
  resume: { filename: "cv.pdf", size: 20480 }, resume_status: "found",
  suggested_job: { job_id: "job-be", confidence: "high", reasoning: "Backend intro." },
  source_title: "Sourced: Candidate Labs", org_check: { status: "unconfirmed" },
  email_lookup: { email: null, confidence: "none", evidence: [], candidates: [] },
  ...over,
});
const block = (view: Record<string, unknown>, id: string) => (view.blocks as Array<Record<string, unknown>>).find((b) => b.block_id === id);
const text = (view: Record<string, unknown>) => JSON.stringify(view);
const OK = { success: true, candidate_id: "cand-1", candidate_url: "https://app.ashbyhq.com/x", steps: { candidate: "created", publish: "published", resume: "uploaded", application: "created", note: "created" }, warnings: [] };

describe("review view", () => {
  it("preselects the suggestion, labels it a draft, and carries only the session id", () => {
    const { view } = reviewView("s1", prefill(), { recruiterName: "DK" });
    expect((block(view, "job")!.element as { initial_option: { value: string } }).initial_option.value).toBe("job-be");
    expect(text(view)).toContain("Suggested by Claude (high confidence)");
    expect(text(view)).toContain("Credited to: DK");
    expect(view.callback_id).toBe(REVIEW_CALLBACK);
    expect(sidFrom(view as { private_metadata: string })).toBe("s1");
  });
  it("holds Slack's limits with many long jobs and keeps the suggestion", () => {
    const jobs = Array.from({ length: 140 }, (_, i) => ({ id: `j${i}`, title: "Senior Staff Principal Distinguished Engineer, Platform ".repeat(3), location: "Remote" }));
    const { view } = reviewView("s1", prefill({ jobs, suggested_job: { job_id: "j139", confidence: "low", reasoning: "" } }));
    const options = (block(view, "job")!.element as { options: Array<{ text: { text: string }; value: string }> }).options;
    expect(options).toHaveLength(100);
    expect(options.every((o) => o.text.text.length <= 75)).toBe(true);
    expect(options[0].value).toBe("j139");
    expect((view.blocks as unknown[]).length).toBeLessThanOrEqual(100);
    expect((view.title as { text: string }).text.length).toBeLessThanOrEqual(24);
  });
  it("splits a long write-up into editable chunks, and sends an enormous one whole", () => {
    const long = reviewView("s1", prefill({ note_parts: ["Intro", "y ".repeat(4000)] }));
    expect(long.locked).toBe(false);
    const noteBlocks = (long.view.blocks as Array<{ block_id?: string; element?: { initial_value?: string } }>).filter((b) => b.block_id?.startsWith("note_"));
    expect(noteBlocks.length).toBe(long.joiners.length);
    expect(noteBlocks.length).toBeGreaterThan(2);
    expect(noteBlocks.every((b) => (b.element!.initial_value || "").length <= 3000)).toBe(true);
    const huge = reviewView("s1", prefill({ note_parts: ["z ".repeat(20000)] }));
    expect(huge.locked).toBe(true);
    expect(block(huge.view, "note_full")).toBeDefined();
    expect(block(huge.view, "note_0")).toBeUndefined();
  });
  it("email is prefilled only when the caller passes a value; medium is a button; low is chips; pending says so", () => {
    const high = reviewView("s1", prefill({ email_lookup: { email: "s@x.com", confidence: "high", evidence: [{ kind: "you_emailed", subject: "Chat recap", date: "2026-07-20" }] } }), { emailValue: "s@x.com", emailVersion: 2 });
    expect(block(high.view, "email_v1")).toBeUndefined();
    expect((block(high.view, "email_v2")!.element as { initial_value: string }).initial_value).toBe("s@x.com");
    expect(text(high.view)).toContain("You emailed them · ‘Chat recap’ · Jul 20");
    const medium = reviewView("s1", prefill({ email_lookup: { email: "maybe@x.com", confidence: "medium" } }));
    expect(block(medium.view, "email_v1")!.element).not.toHaveProperty("initial_value");
    expect((block(medium.view, "email_actions")!.elements as Array<{ value: string }>)[0].value).toBe("maybe@x.com");
    const low = reviewView("s1", prefill({ email_lookup: { email: null, confidence: "low", candidates: [{ email: "a@x.com" }, { email: "b@x.com" }] } }));
    expect((block(low.view, "email_actions")!.elements as Array<{ value: string }>).map((e) => e.value)).toEqual(["a@x.com", "b@x.com"]);
    const pending = reviewView("s1", prefill({ resume: null, resume_status: "pending", suggested_job: null, email_lookup: { confidence: "pending" } }));
    expect(text(pending.view)).toContain("Looking their email up");
    expect(text(pending.view)).toContain("Working out which role fits");
    expect(block(pending.view, "resume_pending")).toBeDefined();
  });
  it("parseReview reads what the recruiter changed", () => {
    const form = parseReview({
      job: { v: { selected_option: { value: "job-fe", text: { text: "Frontend Engineer" } } } },
      name: { v: { value: " Sophia " } }, email_v2: { v: { value: "s@x.com" } }, linkedin: { v: { value: "" } },
      resume_pending: { v: { selected_options: [] } }, note_0: { v: { value: "Intro" } }, note_1: { v: { value: "" } },
    }, 2);
    expect(form).toMatchObject({ job_id: "job-fe", name: "Sophia", email: "s@x.com", include_resume: false, resume_pending: false, note_values: ["Intro", ""] });
  });
});

describe("error views", () => {
  it("unknown org points at Reconnect and lists the orgs", () => {
    const v = errorView("s1", { error: "unknown_org", org_name: "Prelim", available: ["Reducto", "anterior"] }, { reconnectUrl: "https://compass/connect-ashby" });
    expect(text(v)).toContain("Reconnect Ashby");
    const elements = block(v, "org_actions")!.elements as Array<{ action_id: string; options?: Array<{ value: string }>; url?: string }>;
    expect(elements[0].action_id).toBe("retry_prefill");
    expect(elements[1].url).toBe("https://compass/connect-ashby");
    expect(elements[2].options!.map((o) => o.value)).toEqual(["anterior", "Reducto"]);
  });
  it("every pre-write failure says nothing was written; a dead login offers Reconnect", () => {
    for (const kind of ["extractor_busy", "user_session_missing", "user_session_expired", "ashby_session_dead", "extractor_unreachable", "org_mismatch_suspected", "job_org_mismatch", "ashby_slow"]) {
      expect(text(errorView("s1", { error: kind }, { reconnectUrl: "u" }))).toContain("Nothing was written");
    }
    expect(text(errorView("s1", { error: "user_session_expired" }, { reconnectUrl: "https://compass/connect-ashby" }))).toContain("reconnect_ashby");
  });
  it("a wrong org after the draft names it and offers no retry", () => {
    const v = errorView("s1", { error: "wrong_org_context", nothing_written: false, draft_candidate_id: "cand-9" });
    expect(text(v)).toContain("cand-9");
    expect(block(v, "err_actions")).toBeUndefined();
    expect(block(errorView("s1", { error: "wrong_org_context", nothing_written: true }), "err_actions")).toBeDefined();
  });
});

describe("duplicate + result", () => {
  it("tells LinkedIn matches from name-only matches", () => {
    const v = duplicateView("s1", [{ id: "a", name: "S", linkedin_url: null }, { id: "b", name: "S", linkedin_url: "https://linkedin.com/in/sophia-abolore/" }], "Prelim", "https://www.linkedin.com/in/sophia-abolore");
    expect(text(v)).toContain("Name match only");
    expect(text(v)).toContain("LinkedIn match");
    expect(text(v)).toContain("Nothing was written");
  });
  it("clean vs partial results, DM includes the link and org hint", () => {
    expect(isClean(OK)).toBe(true);
    const partial = { ...OK, success: false, steps: { ...OK.steps, application: "failed" } };
    expect(text(resultView("s1", partial, "Sophia", "Prelim"))).toContain("retry_failed");
    expect(text(resultView("s1", OK, "Sophia", "Prelim"))).not.toContain("retry_failed");
    const dm = resultDm(OK, "Sophia", "Prelim");
    expect(dm).toContain("app.ashbyhq.com/x");
    expect(dm).toContain("only opens if your browser is in *Prelim*");
  });
});
