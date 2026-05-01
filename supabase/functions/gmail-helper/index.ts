import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// Gmail helper. Reuses the google_calendar_tokens row (same Google account).
//   action=lookup -> search the user's Gmail for messages mentioning a candidate name,
//                    return up to N candidate email addresses derived from To/Cc/From headers.
//   action=send   -> send a plain-text email as the connected Gmail user.

async function refreshAccessToken(refreshToken: string) {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${JSON.stringify(json)}`);
  return json as { access_token: string; expires_in: number };
}

function base64UrlEncode(input: string): string {
  // utf-8 safe
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildRfc2822({
  from,
  to,
  subject,
  body,
}: {
  from: string;
  to: string;
  subject: string;
  body: string;
}): string {
  // Encode subject as UTF-8 (RFC 2047) so non-ASCII works.
  const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    body,
  ].join("\r\n");
}

function extractEmails(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  return headerValue.match(re) ?? [];
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

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: tokenRow, error: tokenErr } = await admin
      .from("google_calendar_tokens")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (tokenErr) throw new Error(tokenErr.message);
    if (!tokenRow) {
      return new Response(
        JSON.stringify({
          error: "Google not connected",
          code: "google_not_connected",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Verify Gmail scope is present
    const scope: string = tokenRow.scope ?? "";
    const needsGmailRead = !scope.includes("gmail.readonly");
    const needsGmailSend = !scope.includes("gmail.send");
    if (
      (action === "lookup" && needsGmailRead) ||
      (action === "send" && needsGmailSend)
    ) {
      return new Response(
        JSON.stringify({
          error: "Gmail scopes missing — please reconnect Google",
          code: "gmail_scope_missing",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let accessToken: string = tokenRow.access_token;
    const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() : 0;
    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const refreshed = await refreshAccessToken(tokenRow.refresh_token);
      accessToken = refreshed.access_token;
      await admin
        .from("google_calendar_tokens")
        .update({
          access_token: accessToken,
          expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    }

    if (action === "lookup") {
      const name: string = (body.name ?? "").toString().trim();
      if (!name) {
        return new Response(JSON.stringify({ error: "name required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Search both sent and received messages for the candidate name.
      const q = `"${name.replace(/"/g, "")}"`;
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const listJson = await listRes.json();
      if (!listRes.ok) throw new Error(`Gmail list failed: ${JSON.stringify(listJson)}`);

      const ids: string[] = (listJson.messages ?? []).map((m: { id: string }) => m.id).slice(0, 10);
      const myEmail: string = (tokenRow.google_email ?? "").toLowerCase();
      const counts = new Map<string, number>();

      await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
              { headers: { Authorization: `Bearer ${accessToken}` } },
            );
            const j = await r.json();
            if (!r.ok) return;
            const headers: { name: string; value: string }[] = j.payload?.headers ?? [];
            const get = (n: string) =>
              headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value;
            const all = [
              ...extractEmails(get("From")),
              ...extractEmails(get("To")),
              ...extractEmails(get("Cc")),
            ];
            for (const e of all) {
              const lower = e.toLowerCase();
              if (lower === myEmail) continue;
              counts.set(lower, (counts.get(lower) ?? 0) + 1);
            }
          } catch {
            /* ignore */
          }
        }),
      );

      const ranked = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([email, count]) => ({ email, count }));

      return new Response(
        JSON.stringify({ ok: true, results: ranked }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "send") {
      const to: string = (body.to ?? "").toString().trim();
      const subject: string = (body.subject ?? "").toString();
      const text: string = (body.body ?? "").toString();
      if (!to || !subject || !text) {
        return new Response(JSON.stringify({ error: "to, subject, body required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!tokenRow.google_email) {
        return new Response(
          JSON.stringify({ error: "Connected Google account has no email on file" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const raw = base64UrlEncode(
        buildRfc2822({
          from: tokenRow.google_email,
          to,
          subject,
          body: text,
        }),
      );

      const sendRes = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw }),
        },
      );
      const sendJson = await sendRes.json();
      if (!sendRes.ok) {
        throw new Error(`Gmail send failed: ${JSON.stringify(sendJson)}`);
      }

      return new Response(
        JSON.stringify({ ok: true, message_id: sendJson.id, from: tokenRow.google_email }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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
