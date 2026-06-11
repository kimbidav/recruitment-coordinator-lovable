import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const ASHBY_AUTOMATION_API_BASE =
  Deno.env.get("ASHBY_AUTOMATION_API_BASE") || "https://ashby-automation-production.up.railway.app";

// A full org sweep can take 15+ minutes on the extractor side. Edge functions
// can't outlive that, so this function never waits for the sweep itself:
//   POST { cookie }        -> starts an async extractor job (POST /api/extract/start),
//                             records the extractor job id on a fetch_jobs row,
//                             and returns immediately.
//   POST { poll_job_id }   -> checks the extractor's job status (GET
//                             /api/extract/status/:id), advances the fetch_jobs
//                             row (progress / succeeded / partial / failed),
//                             and returns the row. The frontend calls this every
//                             few seconds; each call is a single cheap fetch.
// The extractor caches a successful sweep for 10 minutes and reuses it for new
// start calls, so retries after a browser refresh don't restart from scratch.

type FetchJobStatus = "running" | "succeeded" | "failed" | "partial";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseAshbyResponse(data: unknown): { candidates: unknown[]; stats: Record<string, unknown> } {
  if (Array.isArray(data)) return { candidates: data, stats: {} };
  if (data && typeof data === "object") {
    const obj = data as { candidates?: unknown; extraction_stats?: Record<string, unknown> };
    if (Array.isArray(obj.candidates)) {
      return { candidates: obj.candidates, stats: obj.extraction_stats ?? {} };
    }
  }
  return { candidates: [], stats: {} };
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

/** Start an async extraction on the Railway extractor; returns its job id. */
async function startExtractorJob(cookie: string): Promise<{ jobId: string } | { error: string; status: number }> {
  let res: Response;
  try {
    // No force flag: if the extractor finished a sweep in the last 10 minutes
    // (e.g. a previous attempt the browser stopped watching), reuse it instead
    // of restarting the whole sweep.
    res = await fetchWithTimeout(
      `${ASHBY_AUTOMATION_API_BASE}/api/extract/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie }),
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
    return { error: "Ashby session expired (401). Paste a fresh token.", status: 401 };
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
      { method: "GET" },
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
    return { ...job, status: "failed", error_message: message.slice(0, 1000) };
  }

  // Completed: the status response carries the full result payload.
  const { candidates, stats } = parseAshbyResponse(body);
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
  await admin.from("fetch_jobs").update(update).eq("id", jobId);
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

    // Start mode.
    const cookie = typeof body.cookie === "string" ? body.cookie.trim() : "";
    if (!cookie) return json({ error: "cookie required" }, 400);

    const started = await startExtractorJob(cookie);
    if ("error" in started) return json({ error: started.error }, started.status);

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
