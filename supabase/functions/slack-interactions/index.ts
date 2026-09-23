// Slack interactivity for the "Add to Ashby" message shortcut.
//
// Every recruiter clicks ⋮ → Add to Ashby on their OWN submission, reviews a
// private modal, confirms; the candidate lands in that client's Ashby under
// the recruiter's own login. Rules that never bend:
//  - review-then-write: nothing reaches a client's ATS except from a form
//    the recruiter submitted showing exactly what will be written;
//  - nothing client-visible: this app never joins, posts in or reacts in a
//    client channel — every message is a modal or a DM to the clicker;
//  - only your own submissions: the parent's author must be the clicker.
//
// Slack acks must land within 3 s, and both halves of the flow are slower
// (jobs: 2–90 s; an upload: minutes), so every handler responds at once and
// does the work in EdgeRuntime.waitUntil; the upload itself runs on the
// extractor as a job that calls back (slack-upload-callback).
//
// Deployed with verify_jwt=false (supabase/config.toml); authentication is the
// Slack request signature.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { verifySlackSignature } from "../_shared/slackSig.ts";
import { slackPost } from "../_shared/slackApi.ts";
import { enrich, fromMessage, resumeBase64, startUpload, type Ctx, type Prefill } from "../_shared/addToAshby.ts";
import { buildUploadPayload, retryExtra } from "../_shared/pure/addToAshbyRules.ts";
import * as views from "../_shared/pure/slackViews.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const background = (p: Promise<unknown>) => {
  const guarded = p.catch((e) => console.error("background task failed", e instanceof Error ? e.message : e));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(guarded);
};

const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const COMPASS_URL = (Deno.env.get("COMPASS_URL") ?? "https://ashbypipeline.lovable.app").replace(/\/$/, "");
const reconnectUrl = `${COMPASS_URL}/onboarding?step=ashby`;
const callbackUrl = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/slack-upload-callback`;

type Session = Record<string, unknown> & { id: string; view_id: string | null; prefill: Prefill | null };

// ── identity ─────────────────────────────────────────────────────────────

interface Identity { ctx: Ctx; botToken: string; recruiterName: string }

/** (team, slack user) -> Compass user -> email (the Ashby identity) + the app's bot token. */
async function identify(db: ReturnType<typeof admin>, teamId: string, slackUserId: string): Promise<{ ok: true; id: Identity } | { ok: false; botToken: string | null }> {
  const { data: ws } = await db.from("slack_workspaces").select("bot_token").eq("team_id", teamId).maybeSingle();
  const botToken = (ws?.bot_token as string | undefined) ?? null;
  const { data: tok } = await db.from("slack_tokens").select("user_id, access_token").eq("slack_team_id", teamId).eq("slack_user_id", slackUserId).maybeSingle();
  if (!botToken || !tok) return { ok: false, botToken };
  const { data: u } = await db.auth.admin.getUserById(tok.user_id as string);
  const email = (u?.user?.email ?? "").toLowerCase();
  if (!email) return { ok: false, botToken };
  const name = (u?.user?.user_metadata?.full_name as string | undefined) || (u?.user?.user_metadata?.name as string | undefined) || email;
  return { ok: true, id: { ctx: { admin: db, userId: tok.user_id as string, userEmail: email, slackUserId, userToken: tok.access_token as string }, botToken, recruiterName: name } };
}

// ── view helpers ─────────────────────────────────────────────────────────

async function update(botToken: string, viewId: string | null, view: views.View) {
  if (!viewId) return;
  const r = await slackPost("views.update", botToken, { view_id: viewId, view });
  if (!r.ok && r.error !== "not_found") console.warn("views.update failed", r.error); // not_found: the recruiter closed the modal
}

async function dm(botToken: string, slackUserId: string, text: string) {
  // The DM is the durable record (the modal may be closed). It goes to the
  // clicker only; this app never posts in a client channel.
  const r = await slackPost("chat.postMessage", botToken, { channel: slackUserId, text, unfurl_links: false });
  if (!r.ok) console.warn("DM failed", r.error);
}

async function showReview(db: ReturnType<typeof admin>, id: Identity, s: Session) {
  const { view, joiners, locked } = views.reviewView(s.id, s.prefill as views.Prefill, {
    emailValue: String(s.email_value ?? ""), emailVersion: Number(s.email_block_version ?? 1), recruiterName: id.recruiterName,
  });
  await db.from("slack_shortcut_sessions").update({ joiners, note_locked: locked }).eq("id", s.id);
  await update(id.botToken, s.view_id, view);
}

// ── prefill → enrich ─────────────────────────────────────────────────────

async function runPrefill(db: ReturnType<typeof admin>, id: Identity, s: Session, orgOverride: string, refreshJobs = false) {
  const override = orgOverride || String(s.org_override ?? "");
  const res = await fromMessage(id.ctx, { channelId: String(s.channel_id), messageTs: String(s.message_ts), threadTs: String(s.thread_ts ?? ""), orgOverride: override, refreshJobs });
  if (res.status !== 200) {
    await update(id.botToken, s.view_id, views.errorView(s.id, res.data as views.ErrorBody, { reconnectUrl }));
    return;
  }
  const prefill = res.data as Prefill;
  if (prefill.jobs_error || !prefill.jobs.length) {
    const err = (prefill.jobs_error as views.ErrorBody) ?? { error: "no_open_jobs", detail: `${prefill.org_name} has no open jobs in Ashby.` };
    await update(id.botToken, s.view_id, views.errorView(s.id, err, { clientName: prefill.client_name, reconnectUrl }));
    return;
  }
  await db.from("slack_shortcut_sessions").update({ prefill, org_override: override || null, thread_ts: prefill.thread_ts, email_value: "", email_block_version: 1, enriched_at: null, resume_path: null, resume_meta: null }).eq("id", s.id);
  s.prefill = prefill; s.email_value = ""; s.email_block_version = 1;
  // The form goes up now with everything the thread alone gives; resume,
  // email and role suggestion follow a moment later.
  await showReview(db, id, s);
  await runEnrich(db, id, s);
}

async function runEnrich(db: ReturnType<typeof admin>, id: Identity, s: Session) {
  const prefill = s.prefill!;
  const e = await enrich(id.ctx, s.id, prefill);
  // A Retry / Reload may have replaced the form while this ran.
  const { data: fresh } = await db.from("slack_shortcut_sessions").select("prefill, uploading, email_value, email_block_version").eq("id", s.id).maybeSingle();
  if (!fresh || (fresh.prefill as Prefill)?.thread_ts !== prefill.thread_ts) return;
  const merged = { ...(fresh.prefill as Prefill), resume: e.resume, resume_status: e.resume_status, email_lookup: e.email_lookup, suggested_job: e.suggested_job };
  const patch: Record<string, unknown> = { prefill: merged, resume_path: e.resume_path, resume_meta: e.resume, enriched_at: new Date().toISOString() };
  // Product rule: only a HIGH-confidence address is filled in unasked. A new
  // block id makes Slack redraw the field (and discards a value typed meanwhile).
  if (e.email_lookup.confidence === "high" && e.email_lookup.email && !fresh.email_value) {
    patch.email_value = e.email_lookup.email;
    patch.email_block_version = Number(fresh.email_block_version ?? 1) + 1;
  }
  await db.from("slack_shortcut_sessions").update(patch).eq("id", s.id);
  if (fresh.uploading) return;
  await showReview(db, id, { ...s, prefill: merged, email_value: patch.email_value ?? fresh.email_value, email_block_version: patch.email_block_version ?? fresh.email_block_version });
}

// ── upload ───────────────────────────────────────────────────────────────

async function launchUpload(db: ReturnType<typeof admin>, id: Identity, s: Session, payload: Record<string, unknown>) {
  const name = String((payload.candidate as { name?: string })?.name ?? "Candidate");
  const org = String(payload.org_name ?? "");
  const { data: up } = await db.from("ashby_uploads").insert({ session_id: s.id, user_id: id.ctx.userId, candidate_name: name, org_name: org, status: "pending" }).select("id").single();
  const res = await startUpload(id.ctx, payload, { url: callbackUrl(), ref: up?.id as string });
  if (res.status !== 202) {
    await db.from("ashby_uploads").update({ status: "failed", http_status: res.status, result: res.data, finished_at: new Date().toISOString() }).eq("id", up?.id as string);
    await db.from("slack_shortcut_sessions").update({ uploading: false }).eq("id", s.id);
    await update(id.botToken, s.view_id, views.errorView(s.id, res.data as views.ErrorBody, { reconnectUrl }));
    await dm(id.botToken, id.ctx.slackUserId, `:x: Upload of *${name}* to *${org}* didn't go through: \`${(res.data as { error?: string }).error}\`. ${(res.data as { detail?: string }).detail ?? ""}`.trim());
    return;
  }
  await db.from("ashby_uploads").update({ extractor_job_id: (res.data as { job_id: string }).job_id }).eq("id", up?.id as string);
}

async function buildPayload(db: ReturnType<typeof admin>, id: Identity, s: Session, form: ReturnType<typeof views.parseReview>) {
  // The recruiter can submit before the resume has arrived; wait for it.
  let session = s;
  for (let i = 0; i < 45 && !session.enriched_at; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await db.from("slack_shortcut_sessions").select("*").eq("id", s.id).maybeSingle();
    if (data) session = data as Session;
  }
  const prefill = session.prefill as Prefill;
  const payload = buildUploadPayload(prefill, form, (session.joiners as string[]) ?? [], !!session.note_locked, String(session.channel_id));
  if (payload.resume && session.resume_path) {
    const b64 = await resumeBase64(id.ctx, String(session.resume_path));
    const meta = session.resume_meta as { filename?: string } | null;
    payload.resume = b64 ? { filename: meta?.filename ?? "resume.pdf", content_base64: b64 } : null;
  } else {
    payload.resume = null;
  }
  return payload;
}

// ── request handling ─────────────────────────────────────────────────────

const ok = (body?: unknown) => new Response(body === undefined ? "" : JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function loadSession(db: ReturnType<typeof admin>, view: { private_metadata?: string }): Promise<Session | null> {
  const sid = views.sidFrom(view);
  if (!sid) return null;
  const { data } = await db.from("slack_shortcut_sessions").select("*").eq("id", sid).gt("expires_at", new Date().toISOString()).maybeSingle();
  return (data as Session | null) ?? null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const raw = await req.text();
  if (!(await verifySlackSignature(req, raw))) return new Response("invalid signature", { status: 401 });
  // Interactive payloads arrive form-encoded as `payload=<json>`.
  let payload: Record<string, unknown>;
  try {
    const form = new URLSearchParams(raw);
    payload = JSON.parse(form.get("payload") ?? raw);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const db = admin();
  const teamId = String((payload.team as { id?: string })?.id ?? "");
  const slackUserId = String((payload.user as { id?: string })?.id ?? "");
  const type = String(payload.type ?? "");

  // ── shortcut ──
  if (type === "message_action" || type === "shortcut") {
    if (payload.callback_id !== "add_to_ashby") return ok();
    const who = await identify(db, teamId, slackUserId);
    const triggerId = String(payload.trigger_id ?? "");
    if (!who.ok) {
      if (who.botToken) background(slackPost("views.open", who.botToken, { trigger_id: triggerId, view: views.notConnectedView(COMPASS_URL) }));
      return ok();
    }
    const msg = (payload.message as { ts?: string; thread_ts?: string }) ?? {};
    const { data: s } = await db.from("slack_shortcut_sessions").insert({
      user_id: who.id.ctx.userId, slack_team_id: teamId, slack_user_id: slackUserId,
      channel_id: String((payload.channel as { id?: string })?.id ?? ""), message_ts: String(msg.ts ?? payload.message_ts ?? ""), thread_ts: msg.thread_ts ?? null,
    }).select("*").single();
    const session = s as Session;
    background((async () => {
      const opened = await slackPost("views.open", who.id.botToken, { trigger_id: triggerId, view: views.loadingView(session.id) });
      session.view_id = ((opened.view as { id?: string })?.id) ?? null;
      await db.from("slack_shortcut_sessions").update({ view_id: session.view_id }).eq("id", session.id);
      // Stranded upload from a previous session? Say so before anything else.
      const { data: stranded } = await db.from("ashby_uploads").select("candidate_name, org_name").eq("user_id", who.id.ctx.userId).eq("status", "pending").lt("started_at", new Date(Date.now() - 10 * 60_000).toISOString()).limit(1);
      if (stranded?.length) {
        await db.from("ashby_uploads").update({ status: "lost" }).eq("user_id", who.id.ctx.userId).eq("status", "pending").lt("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
        await dm(who.id.botToken, slackUserId, `:warning: An earlier upload of *${stranded[0].candidate_name}* to *${stranded[0].org_name}* never reported back. Check Ashby before trying it again.`);
      }
      // Opportunistic cleanup of expired sessions (and their resumes).
      const { data: old } = await db.from("slack_shortcut_sessions").select("id, resume_path").lt("expires_at", new Date().toISOString()).eq("uploading", false).limit(50);
      if (old?.length) {
        const paths = old.map((o) => o.resume_path as string | null).filter((p): p is string => !!p);
        if (paths.length) await db.storage.from("shortcut-resumes").remove(paths);
        await db.from("slack_shortcut_sessions").delete().in("id", old.map((o) => o.id));
      }
      await runPrefill(db, who.id, session, "");
    })());
    return ok();
  }

  // ── modal submit ──
  if (type === "view_submission") {
    const view = payload.view as { private_metadata?: string; callback_id?: string; state?: { values?: Record<string, never> } };
    if (view.callback_id !== views.REVIEW_CALLBACK) return ok();
    const s = await loadSession(db, view);
    if (!s) return ok({ response_action: "update", view: views.sessionExpiredView() });
    const form = views.parseReview((view.state?.values ?? {}) as never, Number(s.email_block_version ?? 1));
    const errors: Record<string, string> = {};
    if (!form.job_id) errors.job = "Pick the role to file them under.";
    if (!form.name) errors.name = "A name is required.";
    if (Object.keys(errors).length) return ok({ response_action: "errors", errors });
    // Double-submit guard: exactly one claim succeeds.
    const { data: claimed } = await db.from("slack_shortcut_sessions").update({ uploading: true }).eq("id", s.id).eq("uploading", false).select("id");
    if (!claimed?.length) return ok();
    const who = await identify(db, teamId, slackUserId);
    if (!who.ok) return ok({ response_action: "update", view: views.notConnectedView(COMPASS_URL) });
    background((async () => {
      const payloadOut = await buildPayload(db, who.id, s, form);
      await db.from("slack_shortcut_sessions").update({ last_payload: payloadOut }).eq("id", s.id);
      await launchUpload(db, who.id, s, payloadOut);
    })());
    return ok({ response_action: "update", view: views.uploadingView(s.id, form.name, String((s.prefill as Prefill)?.org_name ?? "")) });
  }

  // ── buttons / selects ──
  if (type === "block_actions") {
    const action = ((payload.actions as Array<Record<string, unknown>>) ?? [])[0] ?? {};
    const actionId = String(action.action_id ?? "");
    if (actionId === "open_ashby" || actionId === "reconnect_ashby") return ok(); // URL buttons
    const view = payload.view as { id?: string; private_metadata?: string };
    const who = await identify(db, teamId, slackUserId);
    if (!who.ok) return ok();
    const s = await loadSession(db, view);
    if (!s) {
      background(update(who.id.botToken, view.id ?? null, views.sessionExpiredView()));
      return ok();
    }
    s.view_id = s.view_id ?? view.id ?? null;
    background((async () => {
      if (actionId === "retry_prefill" || actionId === "reload_jobs" || actionId === "org_chosen") {
        if (s.uploading) return;
        const chosen = actionId === "org_chosen" ? String((action.selected_option as { value?: string })?.value ?? "") : "";
        await update(who.id.botToken, s.view_id, views.loadingView(s.id));
        await runPrefill(db, who.id, s, chosen, actionId === "reload_jobs");
      } else if (/^use_email_\d+$/.test(actionId)) {
        const version = Number(s.email_block_version ?? 1) + 1;
        await db.from("slack_shortcut_sessions").update({ email_value: String(action.value ?? ""), email_block_version: version }).eq("id", s.id);
        await showReview(db, who.id, { ...s, email_value: String(action.value ?? ""), email_block_version: version });
      } else if (/^dup_use_\d+$/.test(actionId) || actionId === "dup_create_anyway" || actionId === "retry_failed") {
        const last = (s.last_payload as Record<string, unknown> | null) ?? null;
        if (!last) return;
        const { data: claimed } = await db.from("slack_shortcut_sessions").update({ uploading: true }).eq("id", s.id).eq("uploading", false).select("id");
        if (!claimed?.length) return;
        let extra: Record<string, unknown> = {};
        if (actionId === "dup_create_anyway") extra = { skip_duplicate_check: true };
        else if (actionId === "retry_failed") {
          const result = (s.last_result as { candidate_id?: string; steps?: Record<string, string> } | null) ?? {};
          if (!result.candidate_id) return;
          extra = retryExtra(result);
        } else extra = { existing_candidate_id: String(action.value ?? "") };
        const payloadOut = { ...last, ...extra };
        if (payloadOut.resume && typeof payloadOut.resume === "object" && !(payloadOut.resume as { content_base64?: string }).content_base64 && s.resume_path) {
          const b64 = await resumeBase64(who.id.ctx, String(s.resume_path));
          payloadOut.resume = b64 ? { ...(payloadOut.resume as object), content_base64: b64 } : null;
        }
        const name = String((payloadOut.candidate as { name?: string })?.name ?? "Candidate");
        await update(who.id.botToken, s.view_id, views.uploadingView(s.id, name, String(payloadOut.org_name ?? "")));
        await launchUpload(db, who.id, s, payloadOut);
      }
    })());
    return ok();
  }

  return ok();
});
