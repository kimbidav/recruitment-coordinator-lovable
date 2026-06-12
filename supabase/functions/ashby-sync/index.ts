import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import {
  type RawRecord,
  mergeCandidateRecords,
  inferArchivedCandidates,
} from "../_shared/ashbyMerge.ts";

const ASHBY_AUTOMATION_API_BASE =
  Deno.env.get("ASHBY_AUTOMATION_API_BASE") || "https://ashby-automation-production.up.railway.app";

// Shared secret gating the Railway extractor's extract/session endpoints.
// Only edge functions hold it — the browser never talks to Railway directly.
const EXTRACTOR_SHARED_SECRET = Deno.env.get("EXTRACTOR_SHARED_SECRET") || "";

function extractorHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return EXTRACTOR_SHARED_SECRET
    ? { ...extra, "X-Extractor-Secret": EXTRACTOR_SHARED_SECRET }
    : extra;
}

// A full org sweep can take 15+ minutes on the extractor side. Edge functions
// can't outlive that, so this function never waits for the sweep itself:
//   POST {}                    -> starts an async extractor job using the
//                                 extractor's SHARED team session (no cookie),
//                                 records the extractor job id on a fetch_jobs
//                                 row, and returns immediately.
//   POST { poll_job_id }       -> checks the extractor's job status, advances
//                                 the fetch_jobs row, returns the row.
//   POST { action: "seed", cookie } -> verifies + installs a new shared
//                                 session on the extractor (self-service: any
//                                 teammate can do this when the session dies).
//   POST { action: "status" }  -> session health from ashby_connection, plus a
//                                 live probe of the extractor when {live:true}.
// The extractor caches a successful sweep for 10 minutes, runs at most one
// sweep at a time (a second start attaches to the running job), and keeps the
// shared session's rotating cookie chain on a durable volume.

type FetchJobStatus = "running" | "succeeded" | "failed" | "partial";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseAshbyResponse(data: unknown): {
  candidates: unknown[];
  stats: Record<string, unknown>;
  companies: string[];
} {
  if (Array.isArray(data)) return { candidates: data, stats: {}, companies: [] };
  if (data && typeof data === "object") {
    const obj = data as {
      candidates?: unknown;
      extraction_stats?: Record<string, unknown>;
      companies?: unknown;
    };
    if (Array.isArray(obj.candidates)) {
      // The extractor appends a company to `companies` only after its org
      // swept successfully — so this doubles as the trusted-org set for
      // archive inference AND the authoritative Ashby org list (it includes
      // orgs with zero candidates, which candidate rows can never reveal).
      const companies: string[] = [];
      for (const entry of Array.isArray(obj.companies) ? obj.companies : []) {
        if (typeof entry === "string" && entry.trim()) {
          companies.push(entry.trim());
        } else if (entry && typeof entry === "object") {
          const name = (entry as Record<string, unknown>).name ?? (entry as Record<string, unknown>).company_name;
          if (typeof name === "string" && name.trim()) companies.push(name.trim());
        }
      }
      return { candidates: obj.candidates, stats: obj.extraction_stats ?? {}, companies };
    }
  }
  return { candidates: [], stats: {}, companies: [] };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type Admin = ReturnType<typeof createClient>;

/** Upsert the org-wide Ashby session health singleton (id=1). */
async function setConnection(admin: Admin, fields: Record<string, unknown>) {
  await admin.from("ashby_connection").upsert(
    { id: 1, updated_at: new Date().toISOString(), ...fields },
    { onConflict: "id" },
  );
}

async function failJob(admin: Admin, jobId: string, message: string) {
  await admin.from("fetch_jobs").update({
    status: "failed",
    finished_at: new Date().toISOString(),
    error_message: message.slice(0, 1000),
  }).eq("id", jobId);
}

async function loadJob(admin: Admin, jobId: string, userId: string) {
  const { data: job } = await admin
    .from("fetch_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle();
  return job;
}

/** Start an async extraction using the extractor's shared team session. */
async function startExtractorJob(): Promise<{ jobId: string } | { error: string; status: number }> {
  let res: Response;
  try {
    // No force flag: if the extractor finished a sweep in the last 10 minutes
    // (e.g. a previous attempt the browser stopped watching), reuse it instead
    // of restarting the whole sweep. No cookie either: the extractor loads
    // the shared session from its persisted (volume-backed) rotation chain.
    res = await fetchWithTimeout(
      `${ASHBY_AUTOMATION_API_BASE}/api/extract/start`,
      {
        method: "POST",
        headers: extractorHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      },
      // Generous: Railway cold starts take ~30s.
      90_000,
    );
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    return {
      error: isAbort
        ? "The Ashby extractor service did not respond (it may be cold-starting). Try again in a minute."
        : `Could not reach the Ashby extractor: ${error instanceof Error ? error.message : "unknown error"}`,
      status: 502,
    };
  }

  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    return { error: "Ashby session expired. Anyone on the team can reconnect it from the dashboard.", status: 401 };
  }
  if (!res.ok) {
    const detail = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    return { error: `Ashby extractor request failed: ${detail}`, status: 502 };
  }
  const jobId = body?.jobId ?? body?.job_id ?? body?.id;
  if (typeof jobId !== "string" || !jobId) {
    return { error: "Ashby extractor did not return a job id.", status: 502 };
  }
  return { jobId };
}

/** Verify + install a new shared session on the extractor. */
async function seedExtractorSession(cookie: string): Promise<{ ok: true } | { error: string; status: number }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${ASHBY_AUTOMATION_API_BASE}/api/session/seed`,
      {
        method: "POST",
        headers: extractorHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ cookie }),
      },
      90_000,
    );
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    return {
      error: isAbort
        ? "The Ashby extractor service did not respond (it may be cold-starting). Try again in a minute."
        : `Could not reach the Ashby extractor: ${error instanceof Error ? error.message : "unknown error"}`,
      status: 502,
    };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    return { error: detail, status: res.status === 401 || res.status === 400 ? res.status : 502 };
  }
  return { ok: true };
}

// ── Org-shared snapshot persistence ─────────────────────────────────────────
//
// The cloud equivalent of the desktop app's data/ashby_candidates.json:
// `ashby_snapshot_candidates` is the canonical, org-scoped Ashby truth that
// every user's pipeline view reads (filtered per-user by credited_to). It is
// written exactly once per completed fetch, by whichever poller wins the
// conditional status flip — NOT by the browser.

const txt = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
  return s || null;
};
const reqTxt = (v: unknown, fb: string): string => txt(v) ?? fb;
const intg = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) ? n : 0;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const tstamp = (v: unknown): string | null => {
  const s = txt(v);
  if (!s) return null;
  const p = Date.parse(s);
  return Number.isFinite(p) ? new Date(p).toISOString() : null;
};

/** Extractor/merged record (candidate_id/job_id) → snapshot table row. */
function snapshotRow(rec: RawRecord): Record<string, unknown> {
  return {
    ashby_candidate_id: reqTxt(rec.candidate_id, ""),
    ashby_job_id: txt(rec.job_id) ?? "",
    application_id: txt(rec.application_id),
    org_id: txt(rec.org_id),
    candidate_name: reqTxt(rec.candidate_name, "(no name)"),
    company_name: reqTxt(rec.company_name, "(unknown company)"),
    job_title: txt(rec.job_title),
    pipeline_stage: txt(rec.pipeline_stage),
    stage_type: txt(rec.stage_type) ?? "",
    decision_status: txt(rec.decision_status),
    current_stage_index: intg(rec.current_stage_index),
    total_stages: intg(rec.total_stages),
    stage_progress: txt(rec.stage_progress),
    days_in_stage: intg(rec.days_in_stage),
    needs_scheduling: rec.needs_scheduling === true,
    credited_to: txt(rec.credited_to),
    source: txt(rec.source),
    feedback_count: intg(rec.feedback_count),
    latest_recommendation: txt(rec.latest_recommendation),
    latest_feedback_author: txt(rec.latest_feedback_author),
    latest_feedback_date: tstamp(rec.latest_feedback_date),
    current_stage_avg_score: num(rec.current_stage_avg_score),
    current_stage_date: tstamp(rec.current_stage_date),
    current_stage_interviews: txt(rec.current_stage_interviews),
    interview_history_summary: txt(rec.interview_history_summary),
    last_activity_at: txt(rec.last_activity_at),
    interview_events: Array.isArray(rec.interview_events) ? rec.interview_events : [],
    archived_reason: txt(rec.archived_reason),
    archived_inferred: typeof rec.archived_inferred === "boolean" ? rec.archived_inferred : null,
    archived_detected_at: tstamp(rec.archived_detected_at),
    fetched_at: tstamp(rec.fetched_at),
    fetch_source: txt(rec.fetch_source),
    updated_at: new Date().toISOString(),
  };
}

/** Snapshot table row → merge-shaped record (candidate_id/job_id keys). */
function recordFromRow(row: Record<string, unknown>): RawRecord {
  const { ashby_candidate_id, ashby_job_id, id: _id, created_at: _c, updated_at: _u, ...rest } = row;
  return { ...rest, candidate_id: ashby_candidate_id, job_id: ashby_job_id };
}

async function loadSnapshotRecords(admin: Admin): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from("ashby_snapshot_candidates")
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];
    out.push(...rows.map(recordFromRow));
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function verifyArchiveStatuses(
  apps: { application_id: string; org_id: string }[],
): Promise<{ application_id?: string }[]> {
  const res = await fetchWithTimeout(
    `${ASHBY_AUTOMATION_API_BASE}/api/applications/archive-status`,
    {
      method: "POST",
      headers: extractorHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ applications: apps }),
    },
    60_000,
  );
  if (!res.ok) throw new Error(`archive-status HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body?.results) ? body.results : [];
}

/**
 * Merge a completed fetch into the org-shared snapshot tables. Best-effort:
 * a persist failure must not fail the poll (the dashboard still gets the
 * payload; the next completed fetch retries the snapshot).
 */
async function persistSnapshot(
  admin: Admin,
  candidates: unknown[],
  companies: string[],
): Promise<void> {
  const incoming = candidates.filter((c): c is RawRecord => !!c && typeof c === "object");
  const existing = await loadSnapshotRecords(admin);
  const outcome = mergeCandidateRecords(existing, incoming);

  const trusted = new Set(companies.map((c) => c.toLowerCase()));
  const archive = await inferArchivedCandidates(outcome, trusted, verifyArchiveStatuses);

  const toUpsert = [...outcome.touched, ...archive.stamped]
    .map(snapshotRow)
    .filter((r) => (r.ashby_candidate_id as string).length > 0);

  // Chunked upserts: same rationale as usePipelineSession's saveSession —
  // one giant statement is where PostgREST writes go to die.
  for (let i = 0; i < toUpsert.length; i += 50) {
    const chunk = toUpsert.slice(i, i + 50);
    const { error } = await admin
      .from("ashby_snapshot_candidates")
      .upsert(chunk, { onConflict: "ashby_candidate_id,ashby_job_id" });
    if (error) throw error;
  }

  if (companies.length > 0) {
    const now = new Date().toISOString();
    const orgRows = Array.from(new Set(companies)).map((org_name) => ({
      org_name,
      last_swept_at: now,
      last_sweep_ok: true,
    }));
    const { error } = await admin.from("ashby_orgs").upsert(orgRows, { onConflict: "org_name" });
    if (error) throw error;
  }

  console.log(
    `[ashby-sync] snapshot merge: +${outcome.stats.added} new, ~${outcome.stats.updated} updated, ` +
      `=${outcome.stats.kept} kept, ↧${outcome.stats.downgrade_skipped} downgrade-skipped, ` +
      `⊘${archive.archived_inferred} archived, ★${archive.hired_detected} hired, ` +
      `${outcome.stats.skipped_no_id} skipped (no ashby id), total=${outcome.stats.total}, ` +
      `orgs=${companies.length}`,
  );
}

/** Poll the extractor for a running job and advance the fetch_jobs row. */
async function advanceJob(admin: Admin, job: Record<string, unknown>): Promise<Record<string, unknown>> {
  const jobId = job.id as string;
  const payload = (job.result_payload ?? {}) as Record<string, unknown>;
  const extractorJobId = payload.extractor_job_id;
  if (typeof extractorJobId !== "string" || !extractorJobId) {
    await failJob(admin, jobId, "Fetch job has no extractor job id (started by an older app version). Re-run the sync.");
    return { ...job, status: "failed", error_message: "Fetch job has no extractor job id (started by an older app version). Re-run the sync." };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${ASHBY_AUTOMATION_API_BASE}/api/extract/status/${extractorJobId}`,
      { method: "GET", headers: extractorHeaders() },
      30_000,
    );
  } catch {
    // Transient network hiccup — leave the row running; the next poll retries.
    return job;
  }

  if (res.status === 404) {
    // The extractor hands out a completed/failed result exactly once, then
    // deletes the job — so a concurrent poll (second tab) may have consumed
    // it and already finalized our row. Re-read before declaring it lost.
    const fresh = await admin
      .from("fetch_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();
    if (fresh.data && fresh.data.status !== "running") return fresh.data;
    // Otherwise the extractor restarted (in-memory job store) or the job hit
    // its 30-min TTL. Either way the run is unrecoverable from here.
    const message = "The Ashby extractor lost track of this run (it may have restarted). Click Sync from Ashby to start a new one.";
    await failJob(admin, jobId, message);
    return { ...job, status: "failed", error_message: message };
  }

  const body = await res.json().catch(() => ({}));

  if (body?.status === "running") {
    const progress = body?.progress ?? null;
    const update: Record<string, unknown> = {
      result_payload: { extractor_job_id: extractorJobId, progress },
    };
    if (progress && typeof progress.total === "number" && progress.total > 0) {
      update.orgs_total = progress.total;
      update.orgs_fetched = progress.completed ?? null;
    }
    await admin.from("fetch_jobs").update(update).eq("id", jobId);
    return { ...job, ...update };
  }

  if (body?.status === "failed" || !res.ok) {
    const detail = [body?.error, body?.detail].filter((s: unknown) => typeof s === "string" && s).join(" — ");
    const message = detail || `Ashby extraction failed (${res.status})`;
    await failJob(admin, jobId, message);
    if (res.status === 401 || /expired/i.test(message)) {
      await setConnection(admin, { status: "expired", last_error: message.slice(0, 500) });
    }
    return { ...job, status: "failed", error_message: message.slice(0, 1000) };
  }

  // Completed: the status response carries the full result payload.
  const { candidates, stats, companies } = parseAshbyResponse(body);
  const orgsTotal = typeof stats.orgs_total === "number" ? stats.orgs_total : null;
  const orgsFetched = typeof stats.orgs_fetched === "number" ? stats.orgs_fetched : null;
  const orgsFailed = typeof stats.orgs_failed === "number" ? stats.orgs_failed : 0;
  const incomplete = stats.complete === false || orgsFailed > 0;
  const status: FetchJobStatus = incomplete ? "partial" : "succeeded";

  const update = {
    status,
    finished_at: new Date().toISOString(),
    candidate_count: candidates.length,
    orgs_total: orgsTotal,
    orgs_fetched: orgsFetched,
    orgs_failed: orgsFailed,
    result_payload: body,
    result_received_at: new Date().toISOString(),
    error_message: candidates.length === 0 ? "No candidates returned" : null,
  };
  // Conditional flip: multiple teammates may be polling the same shared
  // extractor job. Only the poller that wins running→done persists the
  // snapshot, so the merge runs exactly once per fetch.
  const { data: claimed } = await admin
    .from("fetch_jobs")
    .update(update)
    .eq("id", jobId)
    .eq("status", "running")
    .select("id");
  const wonClaim = Array.isArray(claimed) && claimed.length > 0;
  await setConnection(admin, { status: "healthy", last_ok_at: new Date().toISOString(), last_error: null });

  if (wonClaim && candidates.length > 0) {
    try {
      await persistSnapshot(admin, candidates, companies);
      // The snapshot is the durable copy now — drop the multi-hundred-KB
      // payload from the job row (the dashboard reads candidate_count /
      // orgs_* columns, not the payload).
      const slim = { extractor_job_id: extractorJobId };
      await admin.from("fetch_jobs").update({ result_payload: slim }).eq("id", jobId);
      (update as Record<string, unknown>).result_payload = slim;
    } catch (err) {
      // Best-effort: if the persist hiccuped, KEEP the payload on the row so
      // nothing is lost; the next completed fetch re-runs the merge.
      console.error("[ashby-sync] snapshot persist failed:", err instanceof Error ? err.message : err);
    }
  }
  return { ...job, ...update };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (req.method === "GET") {
      const url = new URL(req.url);
      const jobId = url.searchParams.get("jobId");
      if (!jobId) return json({ error: "jobId required" }, 400);
      const job = await loadJob(admin, jobId, userData.user.id);
      if (!job) return json({ error: "Job not found" }, 404);
      return json({ job });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const body = await req.json().catch(() => ({}));

    // Poll mode: check the extractor and advance the job row.
    const pollJobId = typeof body.poll_job_id === "string" ? body.poll_job_id : "";
    if (pollJobId) {
      const job = await loadJob(admin, pollJobId, userData.user.id);
      if (!job) return json({ error: "Job not found" }, 404);
      if (job.status !== "running") return json({ job });
      const advanced = await advanceJob(admin, job as Record<string, unknown>);
      return json({ job: advanced });
    }

    // Seed mode: any teammate installs a new shared session on the extractor.
    if (body.action === "seed") {
      const cookie = typeof body.cookie === "string" ? body.cookie.trim() : "";
      if (!cookie) return json({ error: "cookie required" }, 400);
      const seeded = await seedExtractorSession(cookie);
      if ("error" in seeded) {
        await setConnection(admin, { status: "expired", last_error: seeded.error.slice(0, 500) });
        return json({ error: seeded.error }, seeded.status);
      }
      await setConnection(admin, {
        status: "healthy",
        last_seeded_at: new Date().toISOString(),
        seeded_by: userData.user.email ?? userData.user.id,
        last_error: null,
      });
      return json({ ok: true, status: "healthy" });
    }

    // Status mode: session health for the UI (DB state; live probe optional).
    if (body.action === "status") {
      const { data: conn } = await admin.from("ashby_connection").select("*").eq("id", 1).maybeSingle();
      if (body.live === true) {
        try {
          const res = await fetchWithTimeout(
            `${ASHBY_AUTOMATION_API_BASE}/api/session/status`,
            { method: "GET", headers: extractorHeaders() },
            30_000,
          );
          const probe = await res.json().catch(() => ({}));
          if (res.ok && typeof probe?.authenticated === "boolean") {
            const status = probe.authenticated ? "healthy" : "expired";
            await setConnection(admin, {
              status,
              ...(probe.authenticated ? { last_ok_at: new Date().toISOString(), last_error: null } : {}),
            });
            return json({ connection: { ...(conn ?? {}), status }, probe });
          }
        } catch {
          // Extractor unreachable — fall through to DB state.
        }
      }
      return json({ connection: conn ?? { id: 1, status: "disconnected" } });
    }

    // Start mode — uses the extractor's shared team session; no cookie.
    const started = await startExtractorJob();
    if ("error" in started) {
      if (started.status === 401) {
        await setConnection(admin, { status: "expired", last_error: started.error.slice(0, 500) });
      }
      return json({ error: started.error }, started.status);
    }

    const { data: job, error: insertErr } = await admin
      .from("fetch_jobs")
      .insert({
        user_id: userData.user.id,
        status: "running",
        result_payload: { extractor_job_id: started.jobId },
      })
      .select("*")
      .single();
    if (insertErr || !job) {
      return json({ error: insertErr?.message ?? "Failed to create job" }, 500);
    }
    return json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("ashby-sync error", message);
    return json({ error: message }, 500);
  }
});
