import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const ASHBY_AUTOMATION_API_BASE =
  Deno.env.get("ASHBY_AUTOMATION_API_BASE") || "https://ashby-automation-production.up.railway.app";

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

async function runSync(args: {
  admin: ReturnType<typeof createClient>;
  jobId: string;
  cookie: string;
  includeEnrichment: boolean;
}) {
  const { admin, jobId, cookie, includeEnrichment } = args;
  // Enrichment takes much longer (it walks every candidate's interview/feedback history).
  const timeoutMs = includeEnrichment ? 300_000 : 240_000;
  // R6: when enrichment is requested, ask the extractor for the FULL payload —
  // interview plan, scheduled/future interviews, scorecards, feed, notes, emails.
  // Without these flags, interview loops and feedback simply never come back, and
  // no client-side merge can recover data that was never fetched.
  const extractBody: Record<string, unknown> = {
    cookie,
    force: true,
    include_enrichment: includeEnrichment,
  };
  if (includeEnrichment) {
    Object.assign(extractBody, {
      include_pipeline_context: true,
      include_stage_history: true,
      include_feed: true,
      include_notes: true,
      include_emails: true,
      include_interview_plan: true,
      include_interview_schedule: true,
      include_future_interviews: true,
      include_scorecards: true,
      include_all_interviews: true,
      requested_sections: [
        "candidate",
        "application",
        "current_stage",
        "stage_history",
        "interview_progress",
        "interview_plan",
        "scheduled_interviews",
        "future_interviews",
        "scorecards",
        "feed",
        "notes",
        "emails",
      ],
    });
  }
  try {
    const res = await fetchWithTimeout(
      `${ASHBY_AUTOMATION_API_BASE}/api/extract`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(extractBody),
      },
      timeoutMs,
    );

    if (res.status === 401) {
      await admin.from("fetch_jobs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: "Ashby session expired (401)",
      }).eq("id", jobId);
      return;
    }

    if (!res.ok) {
      const text = await res.text();
      const errorMessage = [
        `Ashby extractor request failed (${res.status})`,
        text?.trim() ? `: ${text.trim()}` : "",
      ].join("");
      await admin.from("fetch_jobs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: errorMessage.slice(0, 1000),
      }).eq("id", jobId);
      return;
    }

    const payload = await res.json();
    const { candidates, stats } = parseAshbyResponse(payload);
    const orgsTotal = typeof stats.orgs_total === "number" ? stats.orgs_total : null;
    const orgsFetched = typeof stats.orgs_fetched === "number" ? stats.orgs_fetched : null;
    const orgsFailed = typeof stats.orgs_failed === "number" ? stats.orgs_failed : 0;
    const partialFlag = (stats as { partial?: boolean }).partial === true;
    const status: FetchJobStatus = partialFlag || orgsFailed > 0 ? "partial" : "succeeded";

    await admin.from("fetch_jobs").update({
      status,
      finished_at: new Date().toISOString(),
      candidate_count: candidates.length,
      orgs_total: orgsTotal,
      orgs_fetched: orgsFetched,
      orgs_failed: orgsFailed,
      result_payload: payload,
      result_received_at: new Date().toISOString(),
      error_message: candidates.length === 0 ? "No candidates returned" : null,
    }).eq("id", jobId);
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    const message = isAbort
      ? `Ashby extractor timed out after ${Math.round(timeoutMs / 1000)}s (${includeEnrichment ? "enrichment" : "basic"} phase). The Railway service may be cold-starting — retry in a moment.`
      : error instanceof Error
        ? error.message
        : "Unknown error";
    console.error("ashby-sync background error", message);
    await admin.from("fetch_jobs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: message.slice(0, 1000),
    }).eq("id", jobId);
  }
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

      const { data: job, error } = await admin
        .from("fetch_jobs")
        .select("*")
        .eq("id", jobId)
        .eq("user_id", userData.user.id)
        .maybeSingle();
      if (error || !job) return json({ error: "Job not found" }, 404);
      return json({ job });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const body = await req.json().catch(() => ({}));
    const cookie = typeof body.cookie === "string" ? body.cookie.trim() : "";
    const includeEnrichment = body.include_enrichment === true;
    if (!cookie) return json({ error: "cookie required" }, 400);

    const { data: job, error: insertErr } = await admin
      .from("fetch_jobs")
      .insert({ user_id: userData.user.id, status: "running" })
      .select("*")
      .single();
    if (insertErr || !job) {
      return json({ error: insertErr?.message ?? "Failed to create job" }, 500);
    }

    EdgeRuntime.waitUntil(runSync({ admin, jobId: job.id, cookie, includeEnrichment }));
    return json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("ashby-sync error", message);
    return json({ error: message }, 500);
  }
});
