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

async function runSync(args: {
  admin: ReturnType<typeof createClient>;
  jobId: string;
  cookie: string;
}) {
  const { admin, jobId, cookie } = args;
  try {
    const res = await fetch(`${ASHBY_AUTOMATION_API_BASE}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie, force: true }),
    });

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
      await admin.from("fetch_jobs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: (text || `Request failed (${res.status})`).slice(0, 1000),
      }).eq("id", jobId);
      return;
    }

    const payload = await res.json();
    const { candidates, stats } = parseAshbyResponse(payload);
    const orgsTotal = typeof stats.orgs_total === "number" ? stats.orgs_total : null;
    const orgsFetched = typeof stats.orgs_fetched === "number" ? stats.orgs_fetched : null;
    const orgsFailed = typeof stats.orgs_failed === "number" ? stats.orgs_failed : 0;
    const status: FetchJobStatus = orgsTotal && orgsFetched !== null && orgsFailed > 0 ? "partial" : "succeeded";

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
    const message = error instanceof Error ? error.message : "Unknown error";
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
    if (!cookie) return json({ error: "cookie required" }, 400);

    const { data: job, error: insertErr } = await admin
      .from("fetch_jobs")
      .insert({ user_id: userData.user.id, status: "running" })
      .select("*")
      .single();
    if (insertErr || !job) {
      return json({ error: insertErr?.message ?? "Failed to create job" }, 500);
    }

    EdgeRuntime.waitUntil(runSync({ admin, jobId: job.id, cookie }));
    return json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("ashby-sync error", message);
    return json({ error: message }, 500);
  }
});