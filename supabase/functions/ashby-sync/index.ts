import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import {
  ASHBY_AUTOMATION_API_BASE,
  extractorHeaders,
  json,
  fetchWithTimeout,
  setConnection,
  loadJob,
  startExtractorJob,
  seedExtractorSession,
  advanceJob,
} from "../_shared/ashbySyncCore.ts";

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
    // The fetch_jobs id is chosen up front so the extractor can call back
    // with it when the sweep finishes (server-side save, no tab needed).
    const fetchJobId = crypto.randomUUID();
    const started = await startExtractorJob(fetchJobId);
    if ("error" in started) {
      if (started.status === 401) {
        await setConnection(admin, { status: "expired", last_error: started.error.slice(0, 500) });
      }
      return json({ error: started.error }, started.status);
    }

    const { data: job, error: insertErr } = await admin
      .from("fetch_jobs")
      .insert({
        id: fetchJobId,
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
