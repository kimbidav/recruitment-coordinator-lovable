import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { googleAccessToken, GoogleNotConnected, hasScope } from "../_shared/google.ts";
import { sendGmail } from "../_shared/gmailSend.ts";

// Review-queue approval, atomically (desktop app: ApprovalQueue.approve).
//
//   POST { card_id, action, idempotency_key, ...args }
//     action = "slack_reply"  { text }                 thread reply on the card's thread
//            | "slack_post"   { text, channel_id? }    top-of-channel message (no thread)
//            | "email"        { to, subject, body }    from the recruiter's Gmail
//            | "close"        {}                       ⛔ on the parent message
//            | "resolve" | "dismiss" | "snooze" { snooze_until }
//
// Nothing auto-sends: this endpoint is only reached from a button the
// recruiter pressed on a card showing exactly what will be sent. The card is
// CLAIMED with the idempotency key before delivery and marked acted only
// after Slack or Gmail confirms; a failed delivery returns it to its prior
// status with the error recorded, so it stays reviewable. Replaying the
// same key returns the stored result instead of sending twice.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function slackCall(token: string, method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? "unknown"}`);
  return data;
}

const SIDE_EFFECT_ACTIONS = new Set(["slack_reply", "slack_post", "email", "close"]);

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
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const cardId = String(body.card_id ?? "");
    const action = String(body.action ?? "");
    const key = String(body.idempotency_key ?? "");
    if (!cardId || !action) return json({ error: "card_id and action required" }, 400);
    if (SIDE_EFFECT_ACTIONS.has(action) && !key) return json({ error: "idempotency_key required for a delivering action" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: card } = await admin.from("agent_action_cards").select("*").eq("id", cardId).eq("user_id", userId).maybeSingle();
    if (!card) return json({ error: "Card not found" }, 404);
    const payload = (card.payload ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();

    // Status-only actions carry no side effect: one update.
    if (!SIDE_EFFECT_ACTIONS.has(action)) {
      const patch: Record<string, unknown> = { updated_at: now };
      if (action === "resolve") patch.status = "resolved";
      else if (action === "dismiss") patch.status = "dismissed";
      else if (action === "snooze") {
        const until = String(body.snooze_until ?? "");
        if (!Number.isFinite(Date.parse(until))) return json({ error: "snooze_until required" }, 400);
        patch.status = "snoozed";
        patch.snooze_until = until;
      } else return json({ error: `Unknown action: ${action}` }, 400);
      const { error } = await admin.from("agent_action_cards").update(patch).eq("id", cardId);
      if (error) throw error;
      return json({ ok: true, status: patch.status });
    }

    // Idempotent replay.
    if (card.act_idempotency_key === key) {
      if (card.act_status === "acted") return json({ ok: true, replayed: true, status: card.status, result: card.act_result });
      if (card.act_status === "acting") return json({ error: "delivery_in_progress", detail: "This action is already being delivered." }, 409);
    }

    // Claim: only an open/snoozed card without a live claim can be delivered.
    const priorStatus = card.status as string;
    const { data: claimed } = await admin
      .from("agent_action_cards")
      .update({ act_idempotency_key: key, act_status: "acting", act_error: null, updated_at: now })
      .eq("id", cardId)
      .in("status", ["open", "snoozed"])
      .or("act_status.is.null,act_status.eq.failed")
      .select("id");
    if (!claimed || claimed.length === 0) {
      return json({ error: "card_not_claimable", detail: "The card was already actioned or is being delivered elsewhere.", status: priorStatus }, 409);
    }

    const release = async (error: string) => {
      await admin.from("agent_action_cards").update({ act_status: "failed", act_error: error.slice(0, 500), status: priorStatus, updated_at: new Date().toISOString() }).eq("id", cardId);
    };

    try {
      let result: Record<string, unknown> = {};
      if (action === "slack_reply" || action === "slack_post" || action === "close") {
        const { data: tok } = await admin.from("slack_tokens").select("access_token").eq("user_id", userId).maybeSingle();
        if (!tok?.access_token) throw new Error("Slack not connected");
        const channelId = String(body.channel_id ?? payload.channel_id ?? "");
        const messageTs = String(payload.message_ts ?? "");
        if (!channelId) throw new Error("This card has no Slack channel");
        if (action === "close") {
          if (!messageTs) throw new Error("This card has no Slack thread to close");
          try {
            await slackCall(tok.access_token as string, "reactions.add", { channel: channelId, timestamp: messageTs, name: "no_entry" });
          } catch (e) {
            if (!String((e as Error).message).includes("already_reacted")) throw e;
            result.already_reacted = true;
          }
          await admin.from("slack_submissions").update({ status: "not_in_process" }).eq("user_id", userId).eq("channel_id", channelId).eq("message_ts", messageTs);
          result = { ...result, closed: true };
        } else {
          const text = String(body.text ?? "").trim();
          if (!text) throw new Error("Message text is empty");
          if (action === "slack_reply" && !messageTs) throw new Error("This card has no Slack thread to reply in");
          const params: Record<string, string> = { channel: channelId, text };
          if (action === "slack_reply") params.thread_ts = messageTs;
          const posted = await slackCall(tok.access_token as string, "chat.postMessage", params);
          result = { ts: posted.ts, channel: posted.channel, in_thread: action === "slack_reply" };
          if (action === "slack_reply" && messageTs) {
            await admin.from("slack_submissions").update({ last_activity_at: now, last_reply_at: now }).eq("user_id", userId).eq("channel_id", channelId).eq("message_ts", messageTs);
          }
        }
      } else if (action === "email") {
        const to = String(body.to ?? "").trim();
        const subject = String(body.subject ?? "");
        const text = String(body.body ?? "");
        // Never auto-send without an explicit recipient the recruiter confirmed.
        if (!to) throw new Error("No recipient on this action — confirm the candidate's email before sending.");
        let token: Awaited<ReturnType<typeof googleAccessToken>>;
        try {
          token = await googleAccessToken(admin, userId);
        } catch (e) {
          if (e instanceof GoogleNotConnected) throw new Error("Google not connected");
          throw e;
        }
        if (!hasScope(token, "gmail.send")) throw new Error("Gmail send scope missing — reconnect Google");
        const sent = await sendGmail(token.access_token, { from: token.google_email ?? userData.user.email ?? "", to, subject, body: text });
        result = { message_id: sent.id, to, from: token.google_email };
      }

      const { error } = await admin.from("agent_action_cards").update({
        status: "resolved", act_status: "acted", acted_at: new Date().toISOString(), act_result: { action, ...result }, updated_at: new Date().toISOString(),
      }).eq("id", cardId);
      if (error) console.error("[agent-act] delivered but could not mark card:", error.message);
      return json({ ok: true, status: "resolved", result: { action, ...result } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await release(msg);
      return json({ error: msg, status: priorStatus }, 502);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
