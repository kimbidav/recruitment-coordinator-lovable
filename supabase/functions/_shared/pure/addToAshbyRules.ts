// Add-to-Ashby rules with no I/O, ported from the desktop coordinator
// (api_server._job_org_check, _unique_org_by_prefix) and the desktop bot
// (handlers.retry_extra, build_payload). Shared by the Slack shortcut and,
// later, the dashboard modal.
import { companiesMatch } from "./companyMatch.ts";
import { joinNote } from "./noteChunking.ts";

export interface SnapshotJobRow { stage_type: string | null; company_name: string | null; ashby_job_id: string | null }
export interface OrgCheck { status: "confirmed" | "mismatch" | "unconfirmed"; conflicts: Array<{ job_id: string; known_under: string }> }

/**
 * Cross-check job ids against the companies the snapshot files them under.
 * The extractor can't verify the org on a READ, so a mis-switched open-jobs
 * call would hand back another client's jobs under this client's name. The
 * snapshot is independent evidence: a job id it knows under a DIFFERENT
 * company means the list is suspect. A brand-new client is `unconfirmed`,
 * which is expected.
 */
export function jobOrgCheck(jobIds: Array<string | null | undefined>, orgName: string, rows: SnapshotJobRow[]): OrgCheck {
  const wanted = new Set(jobIds.filter((j): j is string => !!j));
  if (!wanted.size) return { status: "unconfirmed", conflicts: [] };
  let confirmed = false;
  const conflicts = new Map<string, string>();
  for (const rec of rows) {
    if (!rec.stage_type || !rec.ashby_job_id || !wanted.has(rec.ashby_job_id)) continue;
    const company = (rec.company_name || "").trim();
    if (!company) continue;
    if (companiesMatch(company, orgName)) confirmed = true;
    else conflicts.set(rec.ashby_job_id, company);
  }
  if (conflicts.size) {
    return { status: "mismatch", conflicts: [...conflicts].sort(([a], [b]) => a.localeCompare(b)).map(([job_id, known_under]) => ({ job_id, known_under })) };
  }
  return { status: confirmed ? "confirmed" : "unconfirmed", conflicts: [] };
}

/**
 * The one org whose name starts with the client name's leading words, or
 * null. Tries the full name first, then drops trailing words ("Valon Eng Ds"
 * -> "Valon Eng" -> "Valon"). A prefix must be >= 4 chars and match on a word
 * boundary; an ambiguous prefix (two orgs named "Titan") matches nothing.
 */
export function uniqueOrgByPrefix(clientName: string, available: string[]): string | null {
  const words = (clientName || "").toLowerCase().split(/\s+/).filter(Boolean);
  const names = available.filter((n) => typeof n === "string" && n.trim());
  for (let k = words.length; k > 0; k--) {
    const prefix = words.slice(0, k).join(" ");
    if (prefix.length < 4) break;
    const hits = names.filter((n) => {
      const l = n.toLowerCase();
      return l === prefix || l.startsWith(prefix + " ") || l.startsWith(prefix + ".") || l.startsWith(prefix + ",");
    });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

export interface UploadSteps { candidate?: string; publish?: string; resume?: string; application?: string; note?: string }

/**
 * Fields for "Retry failed steps". Resume upload and note creation are not
 * idempotent in Ashby, so anything that already landed is dropped: a retry
 * must never upload a second resume or post a second note.
 */
export function retryExtra(result: { candidate_id?: string | null; steps?: UploadSteps }): Record<string, unknown> {
  const steps = result.steps ?? {};
  const extra: Record<string, unknown> = { existing_candidate_id: result.candidate_id, previous_steps: steps };
  if (steps.resume === "uploaded" || steps.resume === "skipped") extra.resume = null;
  if (steps.note === "created" || steps.note === "skipped") extra.note_text = null;
  return extra;
}

/** The same stripping, applied server-side so every caller is safe. */
export function stripLandedSteps(payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload.existing_candidate_id) return payload;
  const prev = (payload.previous_steps ?? {}) as UploadSteps;
  const out = { ...payload };
  if (prev.resume === "uploaded" || prev.resume === "skipped") out.resume = null;
  if (prev.note === "created" || prev.note === "skipped") out.note_text = null;
  return out;
}

export interface ReviewForm {
  job_id: string; job_label: string; name: string; email: string; linkedin_url: string;
  include_resume: boolean; resume_pending: boolean; send_full_note: boolean; note_values: string[];
}

export interface PrefillLike {
  org_name?: string; jobs?: Array<{ id: string; title?: string }>; note_text?: string;
  resume?: unknown; source_id?: string | null; channel_name?: string;
}

/** The confirm payload from the reviewed form. Credited-to is never sent: the extractor uses the session's own identity. */
export function buildUploadPayload(
  prefill: PrefillLike, form: ReviewForm, joiners: string[], noteLocked: boolean, channelId: string,
): Record<string, unknown> {
  const job = (prefill.jobs ?? []).find((j) => j.id === form.job_id);
  const note = noteLocked ? (form.send_full_note ? prefill.note_text ?? "" : "") : joinNote(form.note_values, joiners);
  return {
    org_name: prefill.org_name,
    job_id: form.job_id,
    job_title: job?.title || form.job_label || "",
    candidate: { name: form.name, email: form.email || null, linkedin_url: form.linkedin_url || null },
    resume: form.include_resume || form.resume_pending ? prefill.resume ?? null : null,
    note_text: note.trim() || null,
    source_id: prefill.source_id ?? null,
    channel_id: channelId,
    channel_name: prefill.channel_name ?? "",
    added_via: "slack_shortcut",
  };
}
