import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

// Slack Events API receiver — push-based ingestion so new submissions and
// reaction changes land in slack_submissions the moment they happen, instead
// of waiting for the next polling sync (slack-sync remains as backfill).
//
// One-time Slack app setup (app owner, at api.slack.com/apps):
//   1. Basic Information → copy the Signing Secret → set it as the
//      SLACK_SIGNING_SECRET secret on this Supabase project.
//   2. Event Subscriptions → Enable → Request URL:
//      https://<project-ref>.supabase.co/functions/v1/slack-events
//      (deploy this function first; Slack sends a url_verification challenge).
//   3. Under "Subscribe to events on behalf of users" add:
//      message.channels, message.groups, reaction_added, reaction_removed.
//      These mirror the user scopes the connect flow already requests, so
//      existing connections start delivering without re-auth.
//
// This endpoint is called by Slack, not by the app, so it must be deployed
// with verify_jwt disabled (see supabase/config.toml). Authentication is the
// Slack request signature instead.

const SLACK_API = "https://slack.com/api";

// ── Helpers shared with slack-sync (kept in sync by hand) ──────────────────

const LINKEDIN_RE = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%\.]+\/?/i;
const EXCLUDED_NAME_RE = /^(eng[-_]?recruiting|eng[-_]?candidate|recruiting[-_]general|hiring[-_]general)/i;

function inferClientName(channelName: string): string {
  let name = channelName.trim().toLowerCase();
  name = name.replace(/^candidatelabs[-_]/, "");
  name = name.replace(/^internal[-_]/, "");
  name = name.replace(/[-_]engineers?$/, "");
  name = name.replace(/[-_]eng$/, "");
  name = name.replace(/[-_]team$/, "");
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface SlackMessageElement {
  type?: string;
  url?: string;
  text?: string;
  elements?: SlackMessageElement[];
}

function walkElementsForLink(elements: SlackMessageElement[] | undefined): { url?: string; label?: string } {
  if (!elements) return {};
  for (const el of elements) {
    if (el.type === "link" && el.url && LINKEDIN_RE.test(el.url)) {
      return { url: el.url, label: (el.text ?? "").trim() || undefined };
    }
    if (el.elements) {
      const nested = walkElementsForLink(el.elements);
      if (nested.url) return nested;
    }
  }
  return {};
}

function extractCandidate(msg: { text?: string; blocks?: Array<{ elements?: SlackMessageElement[] }> }): {
  linkedin_url: string | null;
  candidate_name: string;
  needs_review: boolean;
} {
  let url: string | undefined;
  let label: string | undefined;
  for (const block of msg.blocks ?? []) {
    const found = walkElementsForLink(block.elements);
    if (found.url) {
      url = found.url;
      label = found.label;
      break;
    }
  }
  const text = msg.text ?? "";
  if (!url) {
    const m = text.match(LINKEDIN_RE);
    if (m) url = m[0];
  }
  let name = "";
  if (label && !/^linkedin$/i.test(label) && !/^https?:/i.test(label)) {
    name = label;
  } else {
    const cleaned = text
      .replace(/<@[A-Z0-9]+>/g, "")
      .replace(/<https?:[^>]+>/g, "")
      .replace(/<https?:[^|]+\|([^>]+)>/g, "$1")
      .trim();
    const firstLine = cleaned.split("\n")[0] ?? "";
    const beforeDelim = firstLine.split(/\s[-–—]\s|\(/)[0];
    name = beforeDelim.trim();
    if (name.length > 80) name = name.slice(0, 80);
  }
  return { linkedin_url: url ?? null, candidate_name: name, needs_review: !name || !url };
}

function statusFromReactions(reactions: Array<{ name: string }> | undefined): string {
  if (!reactions || reactions.length === 0) return "submitted";
  const names = new Set(reactions.map((r) => r.name));
  const hasCheck = names.has("white_check_mark") || names.has("heavy_check_mark") || names.has("white_check");
  const hasNoEntry = names.has("no_entry") || names.has("no_entry_sign");
  if (hasCheck && hasNoEntry) return "disqualified";
  if (hasCheck) return "accepted";
  if (hasNoEntry) return "not_in_process";
  return "submitted";
}

async function slackGet(path: string, token: string, params: Record<string, string>): Promise<Record<string, unknown> | null> {
  const url = new URL(`${SLACK_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    const data = await res.json();
    return data.ok ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Slack request-signature verification ───────────────────────────────────

async function verifySlackSignature(req: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get("SLACK_SIGNING_SECRET");
  if (!secret) {
    console.error("SLACK_SIGNING_SECRET not configured — rejecting event");
    return false;
  }
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!ts || !sig) return false;
  // Replay-protection window per Slack docs.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${rawBody}`));
  const expected = "v0=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ── Event handling ──────────────────────────────────────────────────────────

type Admin = SupabaseClient;

interface TokenRow {
  user_id: string;
  slack_user_id: string;
  access_token: string;
}

/** Resolve (and lazily create) the channel mapping; returns null if the channel shouldn't be tracked. */
async function resolveChannel(
  admin: Admin,
  row: TokenRow,
  channelId: string,
): Promise<{ client_name: string } | null> {
  const { data: mapping } = await admin
    .from("slack_channel_mappings")
    .select("client_name, enabled")
    .eq("user_id", row.user_id)
    .eq("channel_id", channelId)
    .maybeSingle();
  if (mapping) return mapping.enabled ? { client_name: mapping.client_name as string } : null;

  // Unknown channel: apply the same qualification rules as slack-sync's discovery.
  const info = await slackGet("conversations.info", row.access_token, { channel: channelId });
  const ch = info?.channel as { name?: string; is_ext_shared?: boolean; is_archived?: boolean } | undefined;
  if (!ch?.name || ch.is_archived) return null;
  const qualifies = !EXCLUDED_NAME_RE.test(ch.name) && (ch.is_ext_shared === true || /^internal[-_]/i.test(ch.name));
  if (!qualifies) return null;
  const client_name = inferClientName(ch.name);
  await admin.from("slack_channel_mappings").upsert({
    user_id: row.user_id,
    channel_id: channelId,
    channel_name: ch.name,
    client_name,
    enabled: true,
  }, { onConflict: "user_id,channel_id" });
  return { client_name };
}

async function handleMessageEvent(admin: Admin, teamId: string, event: Record<string, unknown>) {
  // Normalize edits to the underlying parent message.
  type EventMessage = {
    user?: string;
    ts: string;
    thread_ts?: string;
    text?: string;
    blocks?: Array<{ elements?: SlackMessageElement[] }>;
    subtype?: string;
  };
  let msg = event as EventMessage;
  if (event.subtype === "message_changed") {
    msg = event.message as typeof msg;
    if (!msg?.ts) return;
  } else if (event.subtype) {
    return; // joins, bots, deletes, etc.
  }
  if (!msg.user) return;
  const channelId = event.channel as string;
  if (!channelId) return;

  if (msg.thread_ts && msg.thread_ts !== msg.ts) {
    // A thread reply is ACTIVITY on the parent submission: it keeps the loop
    // inside the lookback window and tells the agent a human is on it.
    await bumpThreadActivity(admin, channelId, msg.thread_ts, msg.ts);
    return;
  }

  const { linkedin_url, candidate_name, needs_review } = extractCandidate(msg);
  if (!linkedin_url) return;

  // Deliver to every dashboard user who connected as this Slack user.
  const { data: tokenRows } = await admin
    .from("slack_tokens")
    .select("user_id, slack_user_id, access_token")
    .eq("slack_team_id", teamId)
    .eq("slack_user_id", msg.user);
  for (const row of (tokenRows ?? []) as TokenRow[]) {
    const channel = await resolveChannel(admin, row, channelId);
    if (!channel) continue;
    await admin.from("slack_submissions").upsert({
      user_id: row.user_id,
      channel_id: channelId,
      message_ts: msg.ts,
      client_name: channel.client_name,
      candidate_name: candidate_name || "",
      linkedin_url,
      submitted_at: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      thread_ts: msg.ts,
      // status intentionally omitted: fresh inserts get the 'submitted'
      // default, and conflict-updates never clobber a status that reaction
      // events (or a polling sync) already set.
      raw_text: (msg.text ?? "").slice(0, 2000),
      permalink: null,
      needs_review,
    }, { onConflict: "user_id,channel_id,message_ts" });
  }
}

/** Stamp last_activity_at / reply_count on the parent row(s) of a thread reply. */
async function bumpThreadActivity(admin: Admin, channelId: string, parentTs: string, replyTs: string) {
  const replyAt = new Date(parseFloat(replyTs) * 1000);
  if (!Number.isFinite(replyAt.getTime())) return;
  const { data: rows } = await admin
    .from("slack_submissions")
    .select("id, last_activity_at, reply_count")
    .eq("channel_id", channelId)
    .eq("message_ts", parentTs);
  for (const r of (rows ?? []) as Array<{ id: string; last_activity_at: string | null; reply_count: number | null }>) {
    const prev = r.last_activity_at ? Date.parse(r.last_activity_at) : 0;
    await admin.from("slack_submissions").update({
      last_activity_at: new Date(Math.max(prev, replyAt.getTime())).toISOString(),
      last_reply_at: replyAt.toISOString(),
      reply_count: (r.reply_count ?? 0) + 1,
    }).eq("id", r.id);
  }
}

async function handleReactionEvent(admin: Admin, teamId: string, event: Record<string, unknown>) {
  const item = event.item as { type?: string; channel?: string; ts?: string } | undefined;
  if (item?.type !== "message" || !item.channel || !item.ts) return;

  // Only parent messages we already track matter.
  const { data: subs } = await admin
    .from("slack_submissions")
    .select("id, user_id")
    .eq("channel_id", item.channel)
    .eq("message_ts", item.ts);
  if (!subs?.length) return;

  // Recompute status from the full current reaction set (an incremental
  // update can't express combos like ✅+⛔ = disqualified).
  const userIds = subs.map((s) => s.user_id as string);
  const { data: tokenRows } = await admin
    .from("slack_tokens")
    .select("user_id, slack_user_id, access_token")
    .eq("slack_team_id", teamId)
    .in("user_id", userIds);
  const token = (tokenRows ?? [])[0]?.access_token as string | undefined;
  if (!token) return;
  const got = await slackGet("reactions.get", token, { channel: item.channel, timestamp: item.ts });
  if (!got) return;
  const reactions = (got.message as { reactions?: Array<{ name: string }> } | undefined)?.reactions;
  const status = statusFromReactions(reactions);
  await admin
    .from("slack_submissions")
    .update({ status })
    .eq("channel_id", item.channel)
    .eq("message_ts", item.ts)
    .in("user_id", userIds);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const rawBody = await req.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // url_verification happens during app setup, before signing is relevant —
  // but Slack signs it too, so verify everything uniformly.
  if (!(await verifySlackSignature(req, rawBody))) {
    return new Response("invalid signature", { status: 401 });
  }

  if (body.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (body.type !== "event_callback") return new Response("ok");

  const teamId = (body.team_id ?? "") as string;
  const event = (body.event ?? {}) as Record<string, unknown>;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Ack within Slack's 3-second window and do the work afterwards. Always
  // 200: Slack retries non-200s up to 3x, and our writes are idempotent
  // upserts, so a retry adds nothing but load.
  const work = (async () => {
    try {
      if (event.type === "message") {
        await handleMessageEvent(admin, teamId, event);
      } else if (event.type === "reaction_added" || event.type === "reaction_removed") {
        await handleReactionEvent(admin, teamId, event);
      }
    } catch (e) {
      console.error("slack-events processing error", e instanceof Error ? e.message : e);
    }
  })();
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  else await work;

  return new Response("ok");
});
