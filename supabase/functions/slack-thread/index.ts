import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// Combined Slack thread helper:
//   action=fetch  -> read parent + replies in a thread
//   action=reply  -> post a reply as the connected user
//   action=close  -> add a "no_entry" (⛔) reaction to the parent message
// Body: { action, channel_id, message_ts, text? }

async function slackCall<T = any>(
  token: string,
  method: string,
  body: Record<string, unknown> | URLSearchParams,
): Promise<T> {
  const isForm = body instanceof URLSearchParams;
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": isForm
        ? "application/x-www-form-urlencoded"
        : "application/json; charset=utf-8",
    },
    body: isForm ? (body as URLSearchParams).toString() : JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!json.ok) throw new Error(`slack.${method}: ${json.error ?? "unknown"}`);
  return json;
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

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const body = await req.json();
    const action: string = body.action;
    const channelId: string = body.channel_id;
    const messageTs: string = body.message_ts;
    if (!action) {
      return new Response(
        JSON.stringify({ error: "action required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (action !== "users" && (!channelId || !messageTs)) {
      return new Response(
        JSON.stringify({ error: "channel_id, message_ts required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: tok, error: tokErr } = await admin
      .from("slack_tokens")
      .select("access_token, slack_user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (tokErr) throw new Error(tokErr.message);
    if (!tok?.access_token) {
      return new Response(JSON.stringify({ error: "Slack not connected" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = tok.access_token as string;

    if (action === "users") {
      // List workspace users for @mention autocomplete.
      // Optionally augment with members of a specific channel — this is how
      // we surface CLIENTS who are external guests in shared (Slack Connect)
      // channels and would otherwise not appear in users.list.
      const members: any[] = [];
      const seen = new Set<string>();
      const push = (m: any) => {
        if (!m?.id || seen.has(m.id)) return;
        if (m.deleted || m.is_bot || m.id === "USLACKBOT") return;
        const p = m.profile ?? {};
        seen.add(m.id);
        members.push({
          id: m.id,
          name: p.display_name || p.real_name || m.name || m.id,
          real_name: p.real_name || m.name || "",
          image: p.image_48 ?? p.image_72 ?? null,
          is_external: !!(m.is_stranger || m.is_restricted || m.is_ultra_restricted),
        });
      };

      // 1) Workspace users
      let cursor = "";
      try {
        for (let i = 0; i < 10; i++) {
          const params = new URLSearchParams({ limit: "200" });
          if (cursor) params.set("cursor", cursor);
          const r = await fetch(
            `https://slack.com/api/users.list?${params.toString()}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          const j = await r.json();
          if (!j.ok) throw new Error(`users.list: ${j.error}`);
          for (const m of j.members ?? []) push(m);
          cursor = j.response_metadata?.next_cursor ?? "";
          if (!cursor) break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2) Channel members (catches external/shared-channel guests = clients)
      const reqChannel: string | undefined = body.channel_id;
      if (reqChannel) {
        try {
          const memberIds: string[] = [];
          let mcur = "";
          for (let i = 0; i < 5; i++) {
            const params = new URLSearchParams({ channel: reqChannel, limit: "200" });
            if (mcur) params.set("cursor", mcur);
            const r = await fetch(
              `https://slack.com/api/conversations.members?${params.toString()}`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            const j = await r.json();
            if (!j.ok) break;
            for (const id of j.members ?? []) memberIds.push(id);
            mcur = j.response_metadata?.next_cursor ?? "";
            if (!mcur) break;
          }
          // Hydrate any unseen members via users.info
          await Promise.all(
            memberIds
              .filter((id) => !seen.has(id))
              .map(async (id) => {
                try {
                  const r = await fetch(
                    `https://slack.com/api/users.info?user=${encodeURIComponent(id)}`,
                    { headers: { Authorization: `Bearer ${token}` } },
                  );
                  const j = await r.json();
                  if (j.ok && j.user) push(j.user);
                } catch {
                  /* ignore */
                }
              }),
          );
        } catch {
          /* non-fatal */
        }
      }

      return new Response(JSON.stringify({ ok: true, users: members }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "fetch") {
      const params = new URLSearchParams({
        channel: channelId,
        ts: messageTs,
        limit: "200",
        inclusive: "true",
      });
      const resp = await fetch(
        `https://slack.com/api/conversations.replies?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const json = await resp.json();
      if (!json.ok) throw new Error(`conversations.replies: ${json.error}`);

      const messages = json.messages ?? [];

      // Resolve user IDs -> display names (best effort, dedup).
      const userIds = new Set<string>();
      for (const m of messages) if (m.user) userIds.add(m.user);
      const userMap = new Map<string, { name: string; image: string | null }>();
      await Promise.all(
        [...userIds].map(async (uid) => {
          try {
            const r = await fetch(
              `https://slack.com/api/users.info?user=${encodeURIComponent(uid)}`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            const j = await r.json();
            if (j.ok && j.user) {
              const p = j.user.profile ?? {};
              userMap.set(uid, {
                name: p.display_name || p.real_name || j.user.name || uid,
                image: p.image_48 ?? p.image_72 ?? null,
              });
            }
          } catch {
            /* ignore */
          }
        }),
      );

      // Check whether the parent message already has a no_entry reaction by anyone.
      const parent = messages[0];
      const hasCloseReaction =
        Array.isArray(parent?.reactions) &&
        parent.reactions.some((r: { name?: string }) => r?.name === "no_entry");

      const enriched = messages.map((m: any) => ({
        ts: m.ts,
        user_id: m.user ?? null,
        user_name: m.user ? (userMap.get(m.user)?.name ?? m.user) : "Unknown",
        user_image: m.user ? (userMap.get(m.user)?.image ?? null) : null,
        text: m.text ?? "",
        reactions: (m.reactions ?? []).map((r: any) => ({
          name: r.name,
          count: r.count,
        })),
      }));

      return new Response(
        JSON.stringify({
          ok: true,
          messages: enriched,
          has_close_reaction: hasCloseReaction,
          self_user_id: tok.slack_user_id,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "reply") {
      const text: string = (body.text ?? "").toString().trim();
      if (!text) {
        return new Response(JSON.stringify({ error: "text required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = await slackCall(token, "chat.postMessage", {
        channel: channelId,
        thread_ts: messageTs,
        text,
      });
      return new Response(JSON.stringify({ ok: true, ts: (result as any).ts }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "close") {
      // Add ⛔ no_entry reaction to the parent message. Idempotent-ish: ignore "already_reacted".
      try {
        await slackCall(
          token,
          "reactions.add",
          new URLSearchParams({
            channel: channelId,
            timestamp: messageTs,
            name: "no_entry",
          }),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("already_reacted")) throw e;
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "reopen") {
      // Remove the ⛔ reaction (only works if the calling user added it).
      try {
        await slackCall(
          token,
          "reactions.remove",
          new URLSearchParams({
            channel: channelId,
            timestamp: messageTs,
            name: "no_entry",
          }),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("no_reaction")) throw e;
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
