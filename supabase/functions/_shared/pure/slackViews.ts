// Block Kit view builders for the "Add to Ashby" shortcut. Pure functions:
// objects in, objects out. Port of ashby-upload-bot/views.py.
//
// Everything a recruiter sees is a MODAL. The app is never a member of a
// client channel (so it cannot post ephemerals there), and nothing about an
// upload may be visible to the client.
import { Chunk, splitNote } from "./noteChunking.ts";

export const MAX_OPTIONS = 100;        // static_select cap
export const MAX_OPTION_TEXT = 75;
export const MAX_NOTE_CHUNKS = 8;      // beyond this the note is sent whole, unedited
export const REVIEW_CALLBACK = "review_submit";

const STEP_LABELS: Array<[string, string]> = [
  ["candidate", "Candidate record"],
  ["publish", "Publish (make visible)"],
  ["resume", "Resume upload"],
  ["application", "Application on job"],
  ["note", "Write-up note"],
];
const STEP_OK = new Set(["created", "uploaded", "existing", "published"]);
const EVIDENCE_LABELS: Record<string, string> = {
  you_emailed: "You emailed them",
  they_emailed: "They emailed you",
  calendly_invitee: "Calendly invitee",
  scheduling_notice: "Scheduling notice",
  mention: "Copied on a thread",
};
const RESUME_STATUS_COPY: Record<string, string> = {
  not_found: "No resume PDF in the Slack thread. Add one in Ashby afterwards if you need it.",
  scope_missing: "Slack wouldn't let me download the resume. Reconnect Slack in Candidate Compass (the new connection includes file access).",
  download_failed: "Found a resume but the download failed (or it's over 10 MB).",
  pending: "Checking the thread for a resume… it will be attached if there is one.",
};

type Block = Record<string, unknown>;
export type View = Record<string, unknown>;

const trunc = (text: string | null | undefined, limit: number): string => {
  const t = text || "";
  return t.length <= limit ? t : t.slice(0, limit - 1) + "…";
};
const plain = (text: string, limit = 150) => ({ type: "plain_text", text: trunc(text, limit) || " ", emoji: true });
const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text: trunc(text, 3000) } });
const context = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text: trunc(text, 3000) }] });
const button = (text: string, actionId: string, value = "x", style = ""): Block => {
  const btn: Block = { type: "button", text: plain(text, 75), action_id: actionId, value: trunc(value, 2000) };
  if (style) btn.style = style;
  return btn;
};
const modal = (blocks: Block[], sid = "", opts: { submit?: string; callbackId?: string; close?: string } = {}): View => {
  const view: View = {
    type: "modal",
    callback_id: opts.callbackId ?? "info",
    title: plain("Add to Ashby", 24),
    close: plain(opts.close ?? "Close", 24),
    private_metadata: JSON.stringify({ sid }),
    blocks: blocks.slice(0, 100),
  };
  if (opts.submit) view.submit = plain(opts.submit, 24);
  return view;
};

function age(epochSeconds: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now / 1000 - epochSeconds) / 60));
  return minutes < 90 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

export function sidFrom(view: { private_metadata?: string } | null | undefined): string {
  try {
    return JSON.parse(view?.private_metadata || "{}").sid || "";
  } catch {
    return "";
  }
}

export interface Evidence { kind?: string; subject?: string; date?: string }

export function formatEvidence(e: Evidence | null | undefined): string {
  if (!e) return "";
  const label = EVIDENCE_LABELS[e.kind || ""] || e.kind || "";
  const subject = e.subject ? `‘${trunc(e.subject, 36)}’` : "";
  let date = e.date || "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const d = new Date(`${date}T12:00:00Z`);
    date = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  return [label, subject, date].filter(Boolean).join(" · ");
}

// ── Simple views ─────────────────────────────────────────────────────────

export const loadingView = (sid: string): View =>
  modal([section(":hourglass_flowing_sand: Reading the thread and loading this client's open jobs from Ashby…"),
         context("Usually a few seconds. Nothing is written until you confirm.")], sid);

export const notConnectedView = (compassUrl: string): View =>
  modal([section(`Add to Ashby runs under your own Slack, Gmail and Ashby logins. Connect them in <${compassUrl}|Candidate Compass> first, then run the shortcut again.`)]);

export const sessionExpiredView = (): View =>
  modal([section("This form expired (it sat open too long). Close it and run *Add to Ashby* on the message again.")]);

export const uploadingView = (sid: string, name: string, org: string): View =>
  modal([section(`:arrows_counterclockwise: Uploading *${name}* to *${org}*…`),
         context("Don't click around in Ashby for ~10 seconds: your browser and this upload share your Ashby org context. You can close this; I'll DM you the result.")], sid);

// ── Errors ───────────────────────────────────────────────────────────────

export interface ErrorBody {
  error?: string; detail?: string; extractor_error?: string; instructions?: string; holder?: string;
  nothing_written?: boolean; draft_candidate_id?: string; org_name?: string; available?: string[];
}

/** One view per failure the backend can report. */
export function errorView(sid: string, err: ErrorBody, opts: { clientName?: string; reconnectUrl?: string } = {}): View {
  let kind = err.error || "error";
  let detail = err.detail || err.extractor_error || "";
  const instructions = err.instructions || "";
  let retry = true;
  const blocks: Block[] = [];

  if (kind.startsWith("ashby_slow")) { kind = "ashby_slow"; detail = ""; }
  if (kind === "unknown_org") return orgPickerView(sid, err.org_name || opts.clientName || "", err.available || [], opts.reconnectUrl);

  let text: string;
  switch (kind) {
    case "extractor_busy":
      text = `:hourglass: Your previous Ashby request is still running (\`${err.holder || "in flight"}\`). Nothing was written.`;
      break;
    case "user_session_missing":
      text = ":lock: Your Ashby login isn't connected to Candidate Compass yet. Connect it, then retry. Nothing was written.";
      break;
    case "user_session_expired":
    case "ashby_session_dead":
      text = ":lock: Your Ashby login for Candidate Compass has expired. Reconnect Ashby, then retry. Nothing was written.";
      break;
    case "identity_mismatch":
      text = ":no_entry: That Ashby login belongs to a different account than yours, so it wasn't used. Reconnect Ashby with your own login. Nothing was written.";
      retry = false;
      break;
    case "ashby_slow":
      text = ":snail: Ashby didn't answer in time. It's usually back within a minute. Nothing was written.";
      break;
    case "extractor_unreachable":
      text = ":electric_plug: The Ashby extractor isn't answering. Nothing was written.";
      break;
    case "wrong_org_context":
      if (err.nothing_written ?? true) {
        text = ":no_entry: Couldn't prove the Ashby session was in this client's org, so I stopped. *Nothing was written.*";
      } else {
        text = `:warning: The org context was wrong right after a blank draft was created, so I stopped before adding any details. A blank, unpublished draft may exist (\`${err.draft_candidate_id || "unknown id"}\`); it's invisible in Ashby search.`;
        retry = false;
      }
      break;
    case "org_mismatch_suspected":
    case "job_org_mismatch":
      text = ":no_entry: The jobs Ashby returned look like they belong to a different client. *Nothing was written.*";
      break;
    case "not_your_message":
      text = "That thread wasn't started by you, so it isn't one of your submissions.";
      retry = false;
      break;
    case "no_linkedin_url":
      text = "No LinkedIn link in that message, so it doesn't look like a candidate submission. Use the shortcut on the intro message.";
      retry = false;
      break;
    case "no_open_jobs":
      text = `:mag: ${detail || "This client has no open jobs in Ashby."} Nothing was written.`;
      detail = "";
      break;
    default:
      text = `:x: Something went wrong (\`${kind}\`). Nothing was written.`;
  }
  blocks.push(section(text));
  if (detail && !text.includes(detail)) blocks.push(context(trunc(String(detail), 600)));
  if (instructions && !text.includes(instructions)) blocks.push(context(trunc(String(instructions), 600)));
  const actions: Block[] = [];
  if (retry) actions.push(button("Retry", "retry_prefill", "x", "primary"));
  if (["user_session_missing", "user_session_expired", "ashby_session_dead", "identity_mismatch"].includes(kind) && opts.reconnectUrl) {
    actions.push({ ...button("Reconnect Ashby", "reconnect_ashby"), url: opts.reconnectUrl });
  }
  if (actions.length) blocks.push({ type: "actions", block_id: "err_actions", elements: actions });
  return modal(blocks, sid);
}

export function orgPickerView(sid: string, clientName: string, available: string[], reconnectUrl?: string): View {
  const blocks: Block[] = [section(
    `:mag: *${clientName || "This client"}* isn't in the org list your Ashby login can see.\n\n` +
    "• *New client?* Ashby fixes the org list at login. Reconnect Ashby in Candidate Compass, then hit Retry. No refresh needed.\n" +
    "• *Under another name in Ashby?* Pick it below. It's remembered for this channel once an upload succeeds.",
  )];
  const elements: Block[] = [button("Retry", "retry_prefill", "x", "primary")];
  if (reconnectUrl) elements.push({ ...button("Reconnect Ashby", "reconnect_ashby"), url: reconnectUrl });
  const names = [...new Set(available.filter((n) => typeof n === "string" && n.trim()))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).slice(0, MAX_OPTIONS);
  if (names.length) {
    elements.push({
      type: "static_select", action_id: "org_chosen", placeholder: plain("Pick the Ashby org", 150),
      options: names.map((n) => ({ text: plain(n, MAX_OPTION_TEXT), value: trunc(n, 150) })),
    });
  }
  blocks.push({ type: "actions", block_id: "org_actions", elements });
  if (available.length > MAX_OPTIONS) blocks.push(context(`Showing the first ${MAX_OPTIONS} of ${available.length} orgs.`));
  return modal(blocks, sid);
}

// ── Review ───────────────────────────────────────────────────────────────

export interface Job { id: string; title?: string; location?: string | null }
export interface EmailLookup { email?: string | null; confidence?: string; evidence?: Evidence[]; candidates?: Array<{ email?: string }>; reason?: string }
export interface Prefill {
  org_name?: string; jobs?: Job[]; suggested_job?: { job_id?: string; confidence?: string; reasoning?: string } | null;
  candidate?: { name?: string; linkedin_url?: string | null }; org_check?: { status?: string };
  already_in_ashby?: boolean; thread_warning?: string | null; jobs_cached_at?: number | null;
  email_lookup?: EmailLookup | null; resume?: { filename?: string; size?: number } | null; resume_status?: string;
  note_parts?: string[]; note_text?: string; source_title?: string | null;
}

function jobOptions(jobs: Job[], suggestedId: string): { options: Block[]; initial: Block | null } {
  const ordered = [...jobs].sort((a, b) => Number(a.id !== suggestedId) - Number(b.id !== suggestedId)); // suggestion first, survives the cap
  const options: Block[] = [];
  let initial: Block | null = null;
  for (const job of ordered.slice(0, MAX_OPTIONS)) {
    let label = job.title || "(untitled job)";
    if (job.location) label = `${label} · ${job.location}`;
    const opt = { text: plain(label, MAX_OPTION_TEXT), value: job.id || "" };
    options.push(opt);
    if (job.id === suggestedId) initial = opt;
  }
  return { options, initial };
}

function emailBlocks(lookup: EmailLookup, emailValue: string, version: number): Block[] {
  const element: Block = { type: "plain_text_input", action_id: "v", placeholder: plain("optional", 150) };
  if (emailValue) element.initial_value = emailValue;
  // The block id changes whenever a suggestion is applied: views.update
  // won't overwrite a value already on screen under the same id.
  const blocks: Block[] = [{ type: "input", block_id: `email_v${version}`, optional: true, label: plain("Email"), element }];
  const confidence = lookup?.confidence || "none";
  const evidence = formatEvidence(lookup?.evidence?.[0]);
  if (confidence === "pending") {
    blocks.push(context(":mag: Looking their email up in Gmail…"));
  } else if (confidence === "high" && lookup.email) {
    blocks.push(context(`:white_check_mark: Found in Gmail (high confidence)${evidence ? " · " + evidence : ""}`));
  } else if (confidence === "medium" && lookup.email && lookup.email !== emailValue) {
    blocks.push(context(`Suggested (medium confidence)${evidence ? ": " + evidence : ""}. It becomes their primary email in the client's ATS, so only use it if it looks right.`));
    blocks.push({ type: "actions", block_id: "email_actions", elements: [button(`Use ${lookup.email}`, "use_email_0", lookup.email)] });
  } else if (["low", "none", "ambiguous"].includes(confidence)) {
    const cands = (lookup?.candidates || []).map((c) => c.email).filter((e): e is string => !!e && e !== emailValue).slice(0, 5);
    if (cands.length) {
      blocks.push(context("Couldn't confirm an email. Pick one only if you recognize it."));
      blocks.push({ type: "actions", block_id: "email_actions", elements: cands.map((e, i) => button(e, `use_email_${i}`, e)) });
    } else if (lookup?.reason) {
      blocks.push(context(lookup.reason));
    }
  }
  return blocks;
}

export interface ReviewRender { view: View; joiners: string[]; locked: boolean }

export function reviewView(
  sid: string, prefill: Prefill,
  opts: { emailValue?: string; emailVersion?: number; recruiterName?: string; now?: number } = {},
): ReviewRender {
  const org = prefill.org_name || "";
  const jobs = prefill.jobs || [];
  const suggested = prefill.suggested_job || {};
  const candidate = prefill.candidate || {};
  const blocks: Block[] = [{ type: "header", text: plain(`${candidate.name || "Candidate"} → ${org}`, 150) }];

  if (prefill.org_check?.status === "confirmed") blocks.push(context(`:white_check_mark: These jobs are already on file under ${org}.`));
  else blocks.push(context(`:information_source: First upload to ${org} from here, so check the job titles below look like theirs.`));
  if (prefill.already_in_ashby) blocks.push(section(":warning: Compass already has this candidate at this client. Ashby is checked for duplicates before anything is written."));
  if (prefill.thread_warning) blocks.push(section(`:warning: ${prefill.thread_warning}`));

  const { options, initial } = jobOptions(jobs, suggested.job_id || "");
  const jobElement: Block = { type: "static_select", action_id: "v", placeholder: plain("Pick the role"), options };
  if (initial) jobElement.initial_option = initial;
  blocks.push({ type: "input", block_id: "job", label: plain("Job / role"), element: jobElement });
  if (initial) blocks.push(context(`Suggested by Claude (${suggested.confidence || "low"} confidence): ${suggested.reasoning || ""} Change it if it's wrong.`));
  else if (prefill.email_lookup?.confidence === "pending") blocks.push(context(":thinking_face: Working out which role fits… pick one yourself if you already know."));
  if (jobs.length > MAX_OPTIONS) blocks.push(context(`Showing ${MAX_OPTIONS} of ${jobs.length} open jobs.`));
  if (prefill.jobs_cached_at) {
    // Remembered per client so the form opens fast. The upload itself still
    // checks live that the chosen job is open in this org.
    blocks.push({ type: "actions", block_id: "jobs_actions", elements: [button(`Reload jobs (${age(prefill.jobs_cached_at, opts.now)} old)`, "reload_jobs")] });
  }

  const nameEl: Block = { type: "plain_text_input", action_id: "v" };
  if (candidate.name) nameEl.initial_value = candidate.name;
  blocks.push({ type: "input", block_id: "name", label: plain("Name"), element: nameEl });
  blocks.push(...emailBlocks(prefill.email_lookup || {}, opts.emailValue || "", opts.emailVersion ?? 1));
  const liEl: Block = { type: "plain_text_input", action_id: "v" };
  if (candidate.linkedin_url) liEl.initial_value = candidate.linkedin_url;
  blocks.push({ type: "input", block_id: "linkedin", optional: true, label: plain("LinkedIn"), element: liEl });

  const resume = prefill.resume;
  if (resume) {
    const opt = { text: plain(`${resume.filename || "resume.pdf"} (${Math.round((resume.size || 0) / 1024)} KB)`, MAX_OPTION_TEXT), value: "include" };
    blocks.push({ type: "input", block_id: "resume_opt", optional: true, label: plain("Resume"), element: { type: "checkboxes", action_id: "v", options: [opt], initial_options: [opt] } });
  } else if (prefill.resume_status === "pending") {
    const opt = { text: plain("Attach the resume from the thread, if there is one", MAX_OPTION_TEXT), value: "include" };
    blocks.push({ type: "input", block_id: "resume_pending", optional: true, label: plain("Resume"), element: { type: "checkboxes", action_id: "v", options: [opt], initial_options: [opt] } });
  } else {
    blocks.push(context(`:page_facing_up: ${RESUME_STATUS_COPY[prefill.resume_status || "not_found"] || RESUME_STATUS_COPY.not_found}`));
  }

  const chunks: Chunk[] = splitNote(prefill.note_parts?.length ? prefill.note_parts : prefill.note_text ? [prefill.note_text] : []);
  const locked = chunks.length > MAX_NOTE_CHUNKS;
  if (locked) {
    const full = chunks.map((c) => c.text + c.joiner).join("");
    const opt = { text: plain(`Post the full write-up as the Ashby note (${full.length.toLocaleString("en-US")} characters)`, MAX_OPTION_TEXT), value: "send" };
    blocks.push({ type: "input", block_id: "note_full", optional: true, label: plain("Write-up note"), element: { type: "checkboxes", action_id: "v", options: [opt], initial_options: [opt] } });
    blocks.push(context("Too long to edit here. Preview: " + trunc(full, 600)));
  } else {
    chunks.forEach((chunk, i) => {
      const label = chunks.length === 1 ? "Write-up note" : `Write-up note (${i + 1}/${chunks.length})`;
      blocks.push({ type: "input", block_id: `note_${i}`, optional: true, label: plain(label), element: { type: "plain_text_input", action_id: "v", multiline: true, max_length: 3000, initial_value: chunk.text } });
    });
  }

  const source = prefill.source_title || "resolved at upload time";
  blocks.push(context(`Source: ${source} · Credited to: ${opts.recruiterName || "you"}\nDon't click around in Ashby for ~10s after confirming.`));
  return { view: modal(blocks, sid, { submit: "Upload", callbackId: REVIEW_CALLBACK, close: "Cancel" }), joiners: chunks.map((c) => c.joiner), locked };
}

type StateValues = Record<string, Record<string, { value?: string | null; selected_option?: { value?: string; text?: { text?: string } } | null; selected_options?: unknown[] }>>;

/** Pull the edited fields out of view.state.values. */
export function parseReview(values: StateValues, emailVersion: number) {
  const text = (block: string) => values[block]?.v?.value || "";
  const checked = (block: string) => !!values[block]?.v?.selected_options?.length;
  const job = values.job?.v?.selected_option || {};
  const notes: string[] = [];
  for (let i = 0; `note_${i}` in values; i++) notes.push(text(`note_${i}`));
  return {
    job_id: job.value || "",
    job_label: job.text?.text || "",
    name: text("name").trim(),
    email: text(`email_v${emailVersion}`).trim(),
    linkedin_url: text("linkedin").trim(),
    include_resume: checked("resume_opt"),
    // Submitted while the resume was still being fetched: attach it if found.
    resume_pending: !("resume_opt" in values) && checked("resume_pending"),
    send_full_note: checked("note_full"),
    note_values: notes,
  };
}

// ── Duplicate + result ───────────────────────────────────────────────────

const normLi = (u: string | null | undefined) => (u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("?")[0].replace(/\/+$/, "");

export interface Match { id?: string; name?: string; email?: string | null; linkedin_url?: string | null }

export function duplicateView(sid: string, matches: Match[], org: string, linkedinUrl: string): View {
  const blocks: Block[] = [section(`:warning: *${org}* already has ${matches.length === 1 ? "a candidate" : "candidates"} matching this person. *Nothing was written.*`)];
  const wanted = normLi(linkedinUrl);
  matches.slice(0, 10).forEach((m, i) => {
    const byLinkedin = !!wanted && normLi(m.linkedin_url) === wanted;
    const basis = byLinkedin ? ":link: LinkedIn match" : ":bust_in_silhouette: Name match only, could be a different person";
    const lines = [`*${m.name || "(no name)"}*`, m.email || "", m.linkedin_url || "", basis].filter(Boolean);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: trunc(lines.join("\n"), 3000) }, accessory: button("Use this one", `dup_use_${i}`, m.id || "") });
  });
  blocks.push(context("Using an existing candidate adds the application (and the resume and note, if any) to that record."));
  blocks.push({ type: "actions", block_id: "dup_actions", elements: [button("Create a new candidate anyway", "dup_create_anyway", "x", "danger")] });
  return modal(blocks, sid, { close: "Cancel" });
}

export interface UploadResult { success?: boolean; candidate_id?: string | null; candidate_url?: string | null; steps?: Record<string, string>; warnings?: string[] }

export function stepLines(steps: Record<string, string> | undefined): string[] {
  return STEP_LABELS.map(([key, label]) => {
    const status = steps?.[key] || "pending";
    const icon = STEP_OK.has(status) ? ":white_check_mark:" : status === "skipped" ? ":heavy_minus_sign:" : ":x:";
    return `${icon} ${label}: \`${status}\``;
  });
}

export const isClean = (r: UploadResult) => !!r.success && r.steps?.resume !== "failed" && r.steps?.note !== "failed";

/** Ashby URLs carry no org: the link opens in whichever org the browser is in. */
export const orgHint = (org: string) => `The link only opens if your browser is in *${org}*'s Ashby. Switch org first if it lands somewhere else.`;

export function resultView(sid: string, result: UploadResult, name: string, org: string): View {
  const clean = isClean(result);
  const head = clean ? `:tada: *${name}* is in *${org}*'s Ashby.` : `:warning: *${name}* was only partly uploaded to *${org}*.`;
  const blocks: Block[] = [section(head), section(stepLines(result.steps).join("\n"))];
  for (const w of (result.warnings || []).slice(0, 8)) blocks.push(context(`:warning: ${w}`));
  const elements: Block[] = [];
  if (!clean && result.candidate_id) elements.push(button("Retry failed steps", "retry_failed", "x", "primary"));
  if (result.candidate_url) elements.push({ ...button("Open in Ashby", "open_ashby"), url: result.candidate_url });
  if (elements.length) blocks.push({ type: "actions", block_id: "result_actions", elements });
  if (result.candidate_url) blocks.push(context(orgHint(org)));
  return modal(blocks, sid);
}

export function resultDm(result: UploadResult, name: string, org: string): string {
  const head = isClean(result) ? `:tada: *${name}* is in *${org}*'s Ashby.` : `:warning: *${name}* was only partly uploaded to *${org}*. Open the form again to retry the failed steps.`;
  const parts = [head, stepLines(result.steps).join("\n")];
  if (result.candidate_url) parts.push(`<${result.candidate_url}|Open in Ashby>\n_${orgHint(org)}_`);
  return parts.join("\n");
}
