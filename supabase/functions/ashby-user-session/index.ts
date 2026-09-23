// A recruiter's own Ashby login for Candidate Compass.
//
// Actions (user JWT required):
//   seed       { cookie }  — hand the pasted ashby_session_token to the extractor
//                            under X-Ashby-User: <this user's email>. The
//                            extractor refuses a cookie that belongs to
//                            someone else (409 identity_mismatch).
//   status     { live? }   — health; live=true probes the extractor.
//   disconnect             — delete the login on the extractor + the row.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { callExtractor } from "../_shared/extractor.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SESSION_DAYS = 7; // Ashby's hard login expiry, roughly

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user?.email) return json({ error: "Unauthorized" }, 401);
  const userId = userData.user.id;
  const email = userData.user.email.toLowerCase();
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "status");

  const write = (patch: Record<string, unknown>) =>
    admin.from("ashby_user_sessions").upsert({ user_id: userId, email, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  if (action === "seed") {
    const cookie = typeof body.cookie === "string" ? body.cookie.trim() : "";
    if (!cookie) return json({ error: "cookie required" }, 400);
    const res = await callExtractor<{ authenticated: boolean; identity_verified: boolean; org_count: number }>(
      "/api/session/seed", { cookie }, { userEmail: email, timeoutMs: 60_000 },
    );
    if (res.error) {
      const err = res.error.body;
      // identity_mismatch / cookie_not_authenticated / cookie_missing_token: nothing was stored.
      await write({ status: "expired", last_error: String(err.detail ?? err.error ?? "").slice(0, 500) });
      return json({ error: err.error ?? "seed_failed", detail: err.detail ?? null }, res.error.status === 0 ? 503 : res.error.status);
    }
    const now = new Date();
    await write({
      status: "healthy", identity_verified: !!res.data.identity_verified, org_count: res.data.org_count ?? 0,
      last_seeded_at: now.toISOString(), last_ok_at: now.toISOString(), last_error: null,
      expires_estimate_at: new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString(),
    });
    return json({ ok: true, status: "healthy", org_count: res.data.org_count ?? 0, identity_verified: !!res.data.identity_verified });
  }

  if (action === "disconnect") {
    await callExtractor("/api/session/user", null, { userEmail: email, method: "DELETE", timeoutMs: 15_000 });
    await admin.from("ashby_user_sessions").delete().eq("user_id", userId);
    return json({ ok: true });
  }

  // status
  const { data: row } = await admin.from("ashby_user_sessions").select("*").eq("user_id", userId).maybeSingle();
  if (body.live === true) {
    const res = await callExtractor<{ authenticated: boolean; reason?: string; org_count?: number }>(
      "/api/session/status", null, { userEmail: email, method: "GET", timeoutMs: 30_000 },
    );
    if (!res.error) {
      const status = res.data.authenticated ? "healthy" : res.data.reason === "no_session" ? "disconnected" : "expired";
      if (row || status !== "disconnected") {
        await write({ status, ...(res.data.authenticated ? { last_ok_at: new Date().toISOString(), last_error: null } : {}) });
      }
      return json({ session: { ...(row ?? { user_id: userId, email }), status }, probe: res.data });
    }
  }
  return json({ session: row ?? { user_id: userId, email, status: "disconnected" } });
});
