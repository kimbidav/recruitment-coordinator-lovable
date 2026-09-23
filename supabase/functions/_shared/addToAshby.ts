// "Add to Ashby" orchestration for the Slack shortcut: read the clicked
// submission, build the review form's prefill, fetch the slow extras, and
// hand the reviewed upload to the extractor under the recruiter's own Ashby
// login. Port of the desktop coordinator's from-message / enrich / confirm
// handlers; the rules with no I/O live in pure/addToAshbyRules.ts.
//
// Nothing here writes to Slack. Reads use the recruiter's user token.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { assembleWriteup, channelToClientName, extractCandidateName, extractLinkedinUrl, noteParts, normalizeLinkedin } from "./pure/slackText.ts";
import { companiesMatch } from "./pure/companyMatch.ts";
import { sameCandidateName } from "./pure/nameMatch.ts";
import { jobOrgCheck, stripLandedSteps, uniqueOrgByPrefix } from "./pure/addToAshbyRules.ts";
import { slackDownload, slackGet } from "./slackApi.ts";
import { callExtractor } from "./extractor.ts";
import { matchJob } from "./llm.ts";
import { googleAccessToken, hasScope } from "./google.ts";
import { resolveCandidateEmail } from "./emailResolver.ts";

export interface Ctx {
  admin: SupabaseClient;
  userId: string;
  userEmail: string;
  slackUserId: string;
  userToken: string;
}

export type Outcome<T> = { status: number; data: T };

const OPEN_JOBS_TTL_MS = 48 * 3600 * 1000;
const RESUME_MAX_BYTES = 10 * 1024 * 1024;
export const RESUME_BUCKET = "shortcut-resumes";

interface ThreadMsg { user?: string; ts?: string; thread_ts?: string; text?: string; files?: Array<{ mimetype?: string; name?: string; url_private?: string }> }

// ── prefill (stage 1) ────────────────────────────────────────────────────

export interface Prefill {
  ok: true;
  org_name: string;
  client_name: string;
  channel_id: string;
  channel_name: string;
  thread_ts: string;
  candidate: { name: string; linkedin_url: string | null };
  note_text: string;
  note_parts: string[];
  jobs: Array<{ id: string; title: string; location: string | null }>;
  jobs_error: Record<string, unknown> | null;
  jobs_cached_at: number | null;
  source_id: string | null;
  source_title: string | null;
  org_check: ReturnType<typeof jobOrgCheck>;
  org_guessed_from?: string;
  already_in_ashby: boolean;
  thread_warning: string | null;
  // Stage 1 leaves these pending; enrich() fills them in.
  resume: { filename: string; size: number } | null;
  resume_status: "pending" | "found" | "not_found" | "scope_missing" | "download_failed";
  email_lookup: { email?: string | null; confidence: string; evidence?: unknown[]; candidates?: unknown[] };
  suggested_job: { job_id: string; job_title: string | null; confidence: string; reasoning: string } | null;
}

type JobsOk = { ok: true; org_name: string; jobs: Prefill["jobs"]; source_id: string | null; source_title: string | null; cached_at: number | null };
type JobsErr = { ok: false; error: Record<string, unknown> & { status: number; error?: string; available?: string[] } };

async function loadJobs(ctx: Ctx, orgName: string, refresh: boolean): Promise<JobsOk | JobsErr> {
  const key = orgName.trim().toLowerCase();
  if (!refresh) {
    const { data } = await ctx.admin.from("ashby_open_jobs_cache").select("*").eq("org_key", key).maybeSingle();
    if (data && Array.isArray(data.jobs) && data.jobs.length && Date.now() - new Date(data.fetched_at).getTime() < OPEN_JOBS_TTL_MS) {
      return { ok: true, org_name: data.org_name as string, jobs: data.jobs as Prefill["jobs"], source_id: (data.source_id as string | null) ?? null, source_title: (data.source_title as string | null) ?? null, cached_at: Math.floor(new Date(data.fetched_at).getTime() / 1000) };
    }
  }
  // The recruiter's own session: what THEIR seat can see.
  const res = await callExtractor<{ org_name: string; jobs: Prefill["jobs"]; source_id: string | null; source_title: string | null }>(
    "/api/applications/open-jobs", { org_name: orgName }, { userEmail: ctx.userEmail, timeoutMs: 100_000 },
  );
  if (res.error) return { ok: false, error: { ...res.error.body, status: res.error.status } as JobsErr["error"] };
  const d = res.data;
  if (d.jobs?.length) {
    const rows = [key, d.org_name.trim().toLowerCase()].filter((k, i, a) => a.indexOf(k) === i).map((org_key) => ({
      org_key, org_name: d.org_name, jobs: d.jobs, source_id: d.source_id ?? null, source_title: d.source_title ?? null, fetched_at: new Date().toISOString(),
    }));
    await ctx.admin.from("ashby_open_jobs_cache").upsert(rows, { onConflict: "org_key" });
  }
  return { ok: true, org_name: d.org_name, jobs: d.jobs ?? [], source_id: d.source_id ?? null, source_title: d.source_title ?? null, cached_at: null };
}

async function snapshotRowsForJobs(ctx: Ctx, jobIds: string[]) {
  if (!jobIds.length) return [];
  const { data } = await ctx.admin.from("ashby_snapshot_candidates").select("stage_type, company_name, ashby_job_id").in("ashby_job_id", jobIds).limit(2000);
  return (data ?? []) as Array<{ stage_type: string | null; company_name: string | null; ashby_job_id: string | null }>;
}

async function alreadyInAshby(ctx: Ctx, name: string, linkedin: string | null, org: string): Promise<boolean> {
  const { data } = await ctx.admin.from("ashby_snapshot_candidates").select("candidate_name, company_name, stage_type, linkedin_url").neq("stage_type", "").limit(5000);
  const want = normalizeLinkedin(linkedin);
  for (const r of (data ?? []) as Array<{ candidate_name: string; company_name: string; linkedin_url?: string | null }>) {
    if (!companiesMatch(r.company_name || "", org)) continue;
    if (want && r.linkedin_url && normalizeLinkedin(r.linkedin_url) === want) return true;
    if (name && sameCandidateName(name, r.candidate_name || "")) return true;
  }
  return false;
}

export async function fromMessage(
  ctx: Ctx,
  args: { channelId: string; messageTs: string; threadTs?: string; orgOverride?: string; refreshJobs?: boolean },
): Promise<Outcome<Prefill | Record<string, unknown>>> {
  let threadTs = args.threadTs || args.messageTs;
  let replies = await slackGet("conversations.replies", ctx.userToken, { channel: args.channelId, ts: threadTs, limit: "200" }, 15000);
  if (!replies.ok) return { status: 502, data: { error: "slack_error", detail: `Could not read the Slack thread: ${replies.error}` } };
  let messages = (replies.messages as ThreadMsg[]) || [];
  // The shortcut can be used on a reply; the submission is the parent.
  const parentTs = messages[0]?.thread_ts || messages[0]?.ts;
  if (messages.length && parentTs && parentTs !== messages[0].ts) {
    threadTs = parentTs;
    replies = await slackGet("conversations.replies", ctx.userToken, { channel: args.channelId, ts: threadTs, limit: "200" }, 15000);
    if (!replies.ok) return { status: 502, data: { error: "slack_error", detail: `Could not read the Slack thread: ${replies.error}` } };
    messages = (replies.messages as ThreadMsg[]) || [];
  }
  if (!messages.length) return { status: 404, data: { error: "message_not_found", detail: "Slack returned no messages for that thread." } };

  // Shared channels carry teammates' and clients' posts. Only the clicker's
  // own submissions are theirs to upload.
  const parent = messages[0];
  if (parent.user !== ctx.slackUserId) return { status: 403, data: { error: "not_your_message", detail: "That thread wasn't started by you, so it isn't one of your submissions." } };
  const parentText = parent.text || "";
  const linkedin = extractLinkedinUrl(parentText);
  if (!linkedin) return { status: 422, data: { error: "no_linkedin_url", detail: "No LinkedIn link in that message, so it doesn't look like a candidate submission." } };
  const candidateName = extractCandidateName(parentText);

  let channelName = "";
  const info = await slackGet("conversations.info", ctx.userToken, { channel: args.channelId });
  if (info.ok) channelName = ((info.channel as { name?: string })?.name) || "";
  const clientName = channelName ? channelToClientName(channelName) : "";
  const { data: mapped } = await ctx.admin.from("ashby_channel_org_map").select("org_name").eq("channel_id", args.channelId).maybeSingle();
  let orgName = (args.orgOverride || "").trim() || (mapped?.org_name as string | undefined) || clientName;
  if (!orgName) return { status: 422, data: { error: "unknown_channel", detail: "Could not work out which client this channel belongs to." } };

  let jobsRes = await loadJobs(ctx, orgName, !!args.refreshJobs);
  let orgGuessedFrom: string | undefined;
  // A channel-derived name rarely equals the Ashby org name exactly
  // ("candidatelabs-valon-eng-ds" -> "Valon Eng Ds", org "Valon Tech").
  // When exactly ONE reachable org starts with the channel's leading words,
  // use it instead of making the recruiter pick.
  if (!jobsRes.ok && jobsRes.error.error === "unknown_org" && !args.orgOverride && !mapped) {
    const guess = uniqueOrgByPrefix(clientName, jobsRes.error.available || []);
    if (guess) {
      orgGuessedFrom = clientName;
      orgName = guess;
      jobsRes = await loadJobs(ctx, guess, !!args.refreshJobs);
    }
  }
  const jobs: Prefill["jobs"] = jobsRes.ok ? jobsRes.jobs : [];
  const resolvedOrg = jobsRes.ok ? jobsRes.org_name : orgName;
  const jobIds = jobs.map((j) => j.id);
  const orgCheck = jobOrgCheck(jobIds, resolvedOrg, await snapshotRowsForJobs(ctx, jobIds));
  let jobsError: Record<string, unknown> | null = jobsRes.ok ? null : jobsRes.error;
  let shownJobs = jobs;
  if (orgCheck.status === "mismatch") {
    // Don't offer a job list we have evidence belongs to another client.
    shownJobs = [];
    jobsError = {
      error: "org_mismatch_suspected", status: 409,
      detail: `Ashby returned jobs on file under ${[...new Set(orgCheck.conflicts.map((c) => c.known_under))].sort().join(", ")}, not ${resolvedOrg}. Nothing was written.`,
      instructions: "Make sure you aren't switching orgs in Ashby in your browser, then retry.",
    };
  }
  if (jobsRes.ok && orgGuessedFrom && jobs.length) {
    // So the next click skips the failed lookup under the channel name.
    await ctx.admin.from("ashby_open_jobs_cache").upsert({ org_key: orgGuessedFrom.toLowerCase(), org_name: resolvedOrg, jobs, source_id: jobsRes.source_id, source_title: jobsRes.source_title, fetched_at: new Date().toISOString() }, { onConflict: "org_key" });
  }

  const prefill: Prefill = {
    ok: true,
    org_name: resolvedOrg,
    client_name: clientName,
    channel_id: args.channelId,
    channel_name: channelName,
    thread_ts: threadTs,
    candidate: { name: candidateName, linkedin_url: linkedin },
    note_text: assembleWriteup(messages),
    note_parts: noteParts(messages),
    jobs: shownJobs,
    jobs_error: jobsError,
    jobs_cached_at: jobsRes.ok ? jobsRes.cached_at : null,
    source_id: jobsRes.ok ? jobsRes.source_id : null,
    source_title: jobsRes.ok ? jobsRes.source_title : null,
    org_check: orgCheck,
    already_in_ashby: await alreadyInAshby(ctx, candidateName, linkedin, resolvedOrg),
    thread_warning: null,
    resume: null,
    resume_status: "pending",
    email_lookup: { confidence: "pending" },
    suggested_job: null,
  };
  if (orgGuessedFrom) prefill.org_guessed_from = orgGuessedFrom;
  return { status: 200, data: prefill };
}

// ── enrich (stage 2) ─────────────────────────────────────────────────────

export interface Enrichment {
  resume: { filename: string; size: number } | null;
  resume_path: string | null;
  resume_status: "found" | "not_found" | "scope_missing" | "download_failed";
  email_lookup: { email: string | null; confidence: string; evidence: unknown[]; candidates: unknown[]; reason?: string };
  suggested_job: { job_id: string; job_title: string | null; confidence: string; reasoning: string } | null;
}

async function fetchResume(ctx: Ctx, sid: string, channelId: string, threadTs: string): Promise<Pick<Enrichment, "resume" | "resume_path" | "resume_status">> {
  const none = { resume: null, resume_path: null };
  const replies = await slackGet("conversations.replies", ctx.userToken, { channel: channelId, ts: threadTs, limit: "200" }, 15000);
  if (!replies.ok) return { ...none, resume_status: "download_failed" };
  const file = ((replies.messages as ThreadMsg[]) || []).flatMap((m) => m.files || []).find((f) => f.mimetype === "application/pdf" && f.url_private);
  if (!file) return { ...none, resume_status: "not_found" };
  const dl = await slackDownload(file.url_private!, ctx.userToken, RESUME_MAX_BYTES);
  if (!dl) return { ...none, resume_status: "download_failed" };
  // A token without files:read gets a login page (200 + HTML) or 401/403.
  if (dl.status === 401 || dl.status === 403) return { ...none, resume_status: "scope_missing" };
  const head = new TextDecoder().decode(dl.bytes.slice(0, 5));
  if (head !== "%PDF-") return { ...none, resume_status: dl.contentType.includes("html") ? "scope_missing" : "download_failed" };
  if (dl.bytes.length > RESUME_MAX_BYTES) return { ...none, resume_status: "download_failed" };
  const filename = (file.name || "resume.pdf").replace(/[^\w.\-() ]+/g, "_");
  const path = `${sid}/${filename}`;
  const { error } = await ctx.admin.storage.from(RESUME_BUCKET).upload(path, dl.bytes, { contentType: "application/pdf", upsert: true });
  if (error) return { ...none, resume_status: "download_failed" };
  return { resume: { filename, size: dl.bytes.length }, resume_path: path, resume_status: "found" };
}

/** The recruiter's Gmail-backed resolver. Any failure (Google not connected,
 * scope missing, Gmail error) yields "none" — blank is the safe direction,
 * since this address becomes the candidate's primary email in the client's ATS. */
async function lookupEmail(ctx: Ctx, candidateName: string): Promise<Enrichment["email_lookup"]> {
  const none = { email: null, confidence: "none", evidence: [], candidates: [] };
  try {
    const token = await googleAccessToken(ctx.admin, ctx.userId);
    if (!hasScope(token, "gmail.readonly")) return { ...none, reason: "gmail_scope_missing" };
    const r = await resolveCandidateEmail(token.access_token, token.google_email ?? ctx.userEmail, candidateName);
    return { email: r.email, confidence: r.confidence, evidence: r.evidence, candidates: r.candidates };
  } catch (e) {
    return { ...none, reason: (e as { code?: string })?.code ?? "lookup_failed" };
  }
}

export async function enrich(ctx: Ctx, sid: string, prefill: Prefill): Promise<Enrichment> {
  const [resume, suggestion, email] = await Promise.allSettled([
    fetchResume(ctx, sid, prefill.channel_id, prefill.thread_ts),
    prefill.jobs.length && prefill.note_text ? matchJob(prefill.note_text, prefill.jobs) : Promise.resolve(null),
    lookupEmail(ctx, prefill.candidate.name),
  ]);
  const r = resume.status === "fulfilled" ? resume.value : { resume: null, resume_path: null, resume_status: "download_failed" as const };
  const m = suggestion.status === "fulfilled" ? suggestion.value : null;
  return {
    ...r,
    // Prefilled in the modal only at HIGH confidence; medium is a "Use" button,
    // low is a chip list (slackViews.emailBlocks enforces the gating).
    email_lookup: email.status === "fulfilled" ? email.value : { email: null, confidence: "none", evidence: [], candidates: [] },
    suggested_job: m?.job_id ? { job_id: m.job_id, job_title: m.job_title, confidence: m.confidence, reasoning: m.reasoning } : null,
  };
}

// ── upload ───────────────────────────────────────────────────────────────

export async function resumeBase64(ctx: Ctx, path: string): Promise<string | null> {
  const { data, error } = await ctx.admin.storage.from(RESUME_BUCKET).download(path);
  if (error || !data) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Hand the reviewed upload to the extractor as a job. Returns the job id, or an error body. */
export async function startUpload(
  ctx: Ctx,
  payload: Record<string, unknown>,
  callback: { url: string; ref: string },
): Promise<Outcome<{ job_id: string } | Record<string, unknown>>> {
  const body = stripLandedSteps(payload);
  // Same cross-check as the prefill, at the last moment before a write.
  const check = jobOrgCheck([String(body.job_id)], String(body.org_name), await snapshotRowsForJobs(ctx, [String(body.job_id)]));
  if (check.status === "mismatch") {
    return { status: 409, data: { error: "job_org_mismatch", nothing_written: true, detail: `That job is on file under ${check.conflicts[0].known_under}, not ${body.org_name}. Nothing was written.` } };
  }
  // Credited-to is never sent: the extractor uses the recruiter's own identity.
  delete body.credited_to_user_id;
  const res = await callExtractor<{ job_id: string }>("/api/applications/add-candidate/start", { ...body, callback_url: callback.url, callback_ref: callback.ref }, { userEmail: ctx.userEmail, timeoutMs: 30_000 });
  if (res.error) return { status: res.error.status, data: res.error.body };
  return { status: 202, data: { job_id: res.data.job_id } };
}

/** After a successful upload: a minimal snapshot row so the dashboard shows the candidate at once, and the channel -> org memory. */
export async function recordSuccess(ctx: Ctx, payload: Record<string, unknown>, result: Record<string, unknown>): Promise<void> {
  const cand = (payload.candidate ?? {}) as { name?: string; linkedin_url?: string | null };
  if (result.candidate_id && result.success) {
    await ctx.admin.from("ashby_snapshot_candidates").upsert({
      ashby_candidate_id: String(result.candidate_id),
      ashby_job_id: String(payload.job_id ?? ""),
      application_id: (result.application_id as string | null) ?? null,
      org_id: (result.org_id as string | null) ?? null,
      candidate_name: cand.name ?? "",
      company_name: String(result.org_name ?? payload.org_name ?? ""),
      job_title: String(payload.job_title ?? ""),
      pipeline_stage: "Application Review",
      decision_status: "In Process",
      stage_type: "Active",
      last_activity_at: new Date().toISOString(),
      days_in_stage: 0,
      needs_scheduling: false,
      credited_to: ctx.userEmail,
      source: "Candidate Labs",
      fetched_at: new Date().toISOString(),
      fetch_source: "slack_shortcut",
      updated_at: new Date().toISOString(),
    }, { onConflict: "ashby_candidate_id,ashby_job_id" });
    if (payload.channel_id && result.org_name) {
      await ctx.admin.from("ashby_channel_org_map").upsert({
        channel_id: String(payload.channel_id), org_name: String(result.org_name), channel_name: String(payload.channel_name ?? ""),
        learned_by: ctx.userId, updated_at: new Date().toISOString(),
      }, { onConflict: "channel_id" });
    }
  }
}
