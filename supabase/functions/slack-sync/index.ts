import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const SLACK_API = "https://slack.com/api";
const HISTORY_DAYS_DEFAULT = 120;

interface SlackChannel {
  id: string;
  name: string;
  is_archived?: boolean;
  is_ext_shared?: boolean;
  is_shared?: boolean;
  is_org_shared?: boolean;
  is_member?: boolean;
}

interface SlackReaction {
  name: string;
  users: string[];
  count: number;
}

interface SlackMessageElement {
  type?: string;
  url?: string;
  text?: string;
  elements?: SlackMessageElement[];
}

interface SlackBlock {
  type?: string;
  elements?: SlackMessageElement[];
}

interface SlackMessage {
  type?: string;
  user?: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  reactions?: SlackReaction[];
  blocks?: SlackBlock[];
  subtype?: string;
}

const LINKEDIN_RE = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%\.]+\/?/i;

function inferClientName(channelName: string): string {
  let name = channelName.trim().toLowerCase();
  name = name.replace(/^candidatelabs[-_]/, "");
  name = name.replace(/[-_]engineers?$/, "");
  name = name.replace(/[-_]eng$/, "");
  name = name.replace(/[-_]team$/, "");
  // Title case from words
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function walkElementsForLink(elements: SlackMessageElement[] | undefined): {
  url?: string;
  label?: string;
} {
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

function extractCandidate(msg: SlackMessage): {
  linkedin_url: string | null;
  candidate_name: string;
  needs_review: boolean;
} {
  // 1) Try block-kit hyperlink (covers "name hyperlinked to LinkedIn URL")
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

  // 2) Fallback: plain text regex
  const text = msg.text ?? "";
  if (!url) {
    const m = text.match(LINKEDIN_RE);
    if (m) url = m[0];
  }

  // Name: prefer link label if it looks like a name (not "LinkedIn", not a URL)
  let name = "";
  if (label && !/^linkedin$/i.test(label) && !/^https?:/i.test(label)) {
    name = label;
  } else {
    // Try: take the first chunk before a delimiter from the plain text, stripping slack mentions
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

  return {
    linkedin_url: url ?? null,
    candidate_name: name,
    needs_review: !name || !url,
  };
}

function statusFromReactions(reactions: SlackReaction[] | undefined): string {
  if (!reactions || reactions.length === 0) return "submitted";
  const names = new Set(reactions.map((r) => r.name));
  // Slack returns reaction names without colons. Check common variants.
  const hasCheck = names.has("white_check_mark") || names.has("heavy_check_mark") || names.has("white_check");
  const hasNoEntry = names.has("no_entry") || names.has("no_entry_sign");
  if (hasCheck && hasNoEntry) return "disqualified";
  if (hasCheck) return "accepted";
  if (hasNoEntry) return "not_in_process";
  return "submitted";
}

async function slackGet(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${path} failed: ${data.error ?? "unknown"}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = userData.user.id;

    const { data: tokenRow, error: tokenErr } = await supabase
      .from("slack_tokens")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (tokenErr) throw tokenErr;
    if (!tokenRow) {
      return new Response(JSON.stringify({ error: "Slack not connected" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token: string = tokenRow.access_token;
    const slackUserId: string = tokenRow.slack_user_id;

    const body = await req.json().catch(() => ({}));
    const days: number = Number(body.days) || HISTORY_DAYS_DEFAULT;
    const oldestTs = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

    // 1) Discover channels: paginate users.conversations
    const channels: SlackChannel[] = [];
    let cursor = "";
    for (let i = 0; i < 20; i++) {
      const data = await slackGet("users.conversations", token, {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      const list = (data.channels as SlackChannel[]) ?? [];
      channels.push(...list);
      cursor = (data.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      if (!cursor) break;
    }

    // Filter: external/shared channels OR channels named candidatelabs-*
    const candidateChannels = channels.filter(
      (c) =>
        !c.is_archived &&
        (c.is_ext_shared ||
          c.is_shared ||
          c.is_org_shared ||
          /^candidatelabs[-_]/i.test(c.name ?? "")),
    );

    // Load existing mappings to preserve user overrides
    const { data: existingMappings } = await supabase
      .from("slack_channel_mappings")
      .select("channel_id, client_name, enabled")
      .eq("user_id", userId);
    const existingByChannel = new Map<string, { client_name: string; enabled: boolean }>();
    for (const m of existingMappings ?? []) {
      existingByChannel.set(m.channel_id as string, {
        client_name: m.client_name as string,
        enabled: m.enabled as boolean,
      });
    }

    const mappingsUpsert = candidateChannels.map((c) => {
      const existing = existingByChannel.get(c.id);
      return {
        user_id: userId,
        channel_id: c.id,
        channel_name: c.name,
        client_name: existing?.client_name ?? inferClientName(c.name),
        enabled: existing?.enabled ?? true,
      };
    });

    if (mappingsUpsert.length > 0) {
      const { error: mapErr } = await supabase
        .from("slack_channel_mappings")
        .upsert(mappingsUpsert, { onConflict: "user_id,channel_id" });
      if (mapErr) console.error("channel mapping upsert error:", mapErr.message);
    }

    // 2) For each enabled channel, fetch parent messages by this user
    const enabledChannels = candidateChannels.filter((c) => {
      const m = existingByChannel.get(c.id);
      return m ? m.enabled : true;
    });

    const submissionsUpsert: Array<Record<string, unknown>> = [];
    let messagesSeen = 0;

    for (const channel of enabledChannels) {
      const clientName =
        existingByChannel.get(channel.id)?.client_name ?? inferClientName(channel.name);

      let chCursor = "";
      for (let i = 0; i < 20; i++) {
        let data: Record<string, unknown>;
        try {
          data = await slackGet("conversations.history", token, {
            channel: channel.id,
            limit: "200",
            oldest: oldestTs.toString(),
            ...(chCursor ? { cursor: chCursor } : {}),
          });
        } catch (e) {
          console.warn(`history failed for ${channel.name}:`, (e as Error).message);
          break;
        }
        const messages = (data.messages as SlackMessage[]) ?? [];
        for (const msg of messages) {
          messagesSeen++;
          if (msg.user !== slackUserId) continue;
          if (msg.subtype) continue; // skip joins, edits, bot messages
          if (msg.thread_ts && msg.thread_ts !== msg.ts) continue; // parent only

          const { linkedin_url, candidate_name, needs_review } = extractCandidate(msg);
          // Heuristic: only treat as candidate submission if there's a LinkedIn URL
          // OR the message is short and contains an @mention (typical pattern). To be
          // safe (no covert collection), require LinkedIn URL.
          if (!linkedin_url) continue;

          const status = statusFromReactions(msg.reactions);
          const submittedAt = new Date(parseFloat(msg.ts) * 1000).toISOString();

          // Build a permalink (best-effort; we could also call chat.getPermalink)
          submissionsUpsert.push({
            user_id: userId,
            channel_id: channel.id,
            message_ts: msg.ts,
            client_name: clientName,
            candidate_name: candidate_name || "",
            linkedin_url,
            submitted_at: submittedAt,
            status,
            raw_text: (msg.text ?? "").slice(0, 2000),
            permalink: null,
            needs_review,
          });
        }
        chCursor =
          (data.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
        if (!chCursor) break;
      }

      // Update last_synced_at for this channel
      await supabase
        .from("slack_channel_mappings")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("channel_id", channel.id);
    }

    // Upsert submissions in chunks
    let submissionsSaved = 0;
    for (let i = 0; i < submissionsUpsert.length; i += 500) {
      const chunk = submissionsUpsert.slice(i, i + 500);
      const { error: subErr } = await supabase
        .from("slack_submissions")
        .upsert(chunk, { onConflict: "user_id,channel_id,message_ts" });
      if (subErr) console.error(`submissions chunk ${i} failed:`, subErr.message);
      else submissionsSaved += chunk.length;
    }

    const missingNameCount = submissionsUpsert.filter((s) => !s.candidate_name).length;

    return new Response(
      JSON.stringify({
        ok: true,
        channels_discovered: candidateChannels.length,
        channels_scanned: enabledChannels.length,
        messages_seen: messagesSeen,
        submissions_saved: submissionsSaved,
        missing_name_count: missingNameCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("slack-sync error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
