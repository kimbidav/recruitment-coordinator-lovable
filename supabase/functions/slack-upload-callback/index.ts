// The Ashby extractor posts an upload's outcome here when the job finishes
// (see /api/applications/add-candidate/start). We turn it into the result
// modal + a DM for the recruiter, record the row, and on success patch the
// snapshot and remember the channel -> org mapping.
//
// Authenticated by X-Extractor-Callback-Secret (shared with the extractor);
// deployed with verify_jwt=false.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { slackPost } from "../_shared/slackApi.ts";
import { recordSuccess, type Ctx } from "../_shared/addToAshby.ts";
import * as views from "../_shared/pure/slackViews.ts";

const COMPASS_URL = (Deno.env.get("COMPASS_URL") ?? "https://candidate-compass.lovable.app").replace(/\/$/, "");
const reconnectUrl = `${COMPASS_URL}/onboarding?step=ashby`;

function secretOk(req: Request): boolean {
  const expected = Deno.env.get("EXTRACTOR_CALLBACK_SECRET") ?? "";
  const given = req.headers.get("x-extractor-callback-secret") ?? "";
  if (!expected || expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (!secretOk(req)) return new Response("unauthorized", { status: 401 });
  let body: { job_id?: string; callback_ref?: string; user?: string; http_status?: number; result?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: up } = await db.from("ashby_uploads").select("*").eq("id", body.callback_ref ?? "").maybeSingle();
  if (!up) return new Response("unknown upload", { status: 404 });
  if (up.status !== "pending") return new Response("ok"); // duplicate delivery

  const status = body.http_status ?? 500;
  const result = body.result ?? {};
  const isDup = status === 409 && result.error === "candidate_exists";
  const success = status === 200;
  await db.from("ashby_uploads").update({ status: success ? "done" : "failed", http_status: status, result, finished_at: new Date().toISOString() }).eq("id", up.id);

  const { data: s } = await db.from("slack_shortcut_sessions").select("*").eq("id", up.session_id ?? "").maybeSingle();
  await db.from("slack_shortcut_sessions").update({ uploading: false, last_result: success ? result : null }).eq("id", up.session_id ?? "");
  if (!s) return new Response("ok");

  const { data: ws } = await db.from("slack_workspaces").select("bot_token").eq("team_id", s.slack_team_id).maybeSingle();
  const botToken = ws?.bot_token as string | undefined;
  if (!botToken) return new Response("ok");
  const payload = (s.last_payload ?? {}) as Record<string, unknown>;
  const name = String((payload.candidate as { name?: string })?.name ?? up.candidate_name ?? "Candidate");
  const org = String(payload.org_name ?? up.org_name ?? "");

  const update = (view: views.View) => s.view_id ? slackPost("views.update", botToken, { view_id: s.view_id, view }) : Promise.resolve({ ok: true });
  const dm = (text: string) => slackPost("chat.postMessage", botToken, { channel: s.slack_user_id, text, unfurl_links: false });

  if (isDup) {
    await update(views.duplicateView(s.id, (result.matches as views.Match[]) ?? [], org, String((payload.candidate as { linkedin_url?: string })?.linkedin_url ?? "")));
    return new Response("ok");
  }
  if (!success) {
    await update(views.errorView(s.id, result as views.ErrorBody, { reconnectUrl }));
    await dm(`:x: Upload of *${name}* to *${org}* didn't go through: \`${result.error ?? status}\`. ${result.detail ?? ""}`.trim());
    return new Response("ok");
  }
  await update(views.resultView(s.id, result as views.UploadResult, name, org));
  await dm(views.resultDm(result as views.UploadResult, name, org));

  const { data: u } = await db.auth.admin.getUserById(s.user_id);
  const ctx: Ctx = { admin: db, userId: s.user_id, userEmail: (u?.user?.email ?? "").toLowerCase(), slackUserId: s.slack_user_id, userToken: "" };
  try {
    await recordSuccess(ctx, payload, result);
  } catch (e) {
    console.error("recordSuccess failed (non-fatal)", e instanceof Error ? e.message : e);
  }
  return new Response("ok");
});
