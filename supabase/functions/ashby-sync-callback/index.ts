import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { advanceJob } from "../_shared/ashbySyncCore.ts";

// The extractor calls this when a team sweep finishes (or fails), so the
// result is saved to the snapshot SERVER-SIDE. Before this existed, saving
// depended on a dashboard tab polling at the right moment: close the tab, or
// let the sweep outrun the tab's 25-minute watch, and the finished result was
// never written — the dashboard silently kept stale candidates.
//
// Body: { kind: "sweep", job_id, callback_ref, status }. callback_ref is the
// fetch_jobs row id. Authenticated by X-Extractor-Callback-Secret (the same
// secret as upload callbacks); verify_jwt=false in config.toml. The payload
// carries no candidate data — advanceJob fetches the result from the
// extractor's status endpoint (finished jobs are kept an hour) and persists
// it with the same claim-once rule the browser poll uses.

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const secret = Deno.env.get("EXTRACTOR_CALLBACK_SECRET") ?? "";
  const given = req.headers.get("x-extractor-callback-secret") ?? "";
  if (!secret || !timingSafeEqual(given, secret)) {
    console.warn("[ashby-sync-callback] rejected: bad or missing callback secret");
    return new Response("unauthorized", { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as { kind?: string; job_id?: string; callback_ref?: string; status?: string };
  const ref = typeof body.callback_ref === "string" ? body.callback_ref : "";
  const extractorJobId = typeof body.job_id === "string" ? body.job_id : "";
  if (body.kind !== "sweep" || !ref || !extractorJobId) return new Response("bad request", { status: 400 });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: job } = await admin.from("fetch_jobs").select("*").eq("id", ref).maybeSingle();
  if (!job) return new Response("unknown job", { status: 404 });
  const payload = (job.result_payload ?? {}) as Record<string, unknown>;
  if (payload.extractor_job_id !== extractorJobId) {
    console.warn(`[ashby-sync-callback] job ${ref} is bound to a different extractor job; ignoring`);
    return new Response("mismatched job", { status: 409 });
  }
  if (job.status !== "running") {
    // A browser poll already finished it — nothing to do.
    return new Response(JSON.stringify({ ok: true, already: job.status }), { headers: { "Content-Type": "application/json" } });
  }

  // Acknowledge at once; merging thousands of rows takes longer than the
  // extractor should wait. advanceJob claims running→done exactly once.
  const work = advanceJob(admin, job as Record<string, unknown>)
    .then((done) => console.log(`[ashby-sync-callback] job ${ref}: ${String((done as Record<string, unknown>).status)} (${String((done as Record<string, unknown>).candidate_count ?? 0)} candidates)`))
    .catch((e) => console.error(`[ashby-sync-callback] job ${ref} failed to persist:`, e instanceof Error ? e.message : e));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  else await work;
  return new Response(JSON.stringify({ ok: true, accepted: ref }), { status: 202, headers: { "Content-Type": "application/json" } });
});
