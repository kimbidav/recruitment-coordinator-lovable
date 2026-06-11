import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

interface InEvent {
  id: string;
  interview_title: string;
  start_time: string;
  end_time: string;
}

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
  if (!res.ok) throw new Error(`Refresh failed: ${JSON.stringify(json)}`);
  return json as { access_token: string; expires_in: number };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const { events } = await req.json() as { events: InEvent[] };
    if (!Array.isArray(events) || events.length === 0) {
      return new Response(JSON.stringify({ error: "No events provided" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
      return new Response(JSON.stringify({ error: "Google Calendar not connected" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let accessToken: string = tokenRow.access_token;
    const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() : 0;
    if (!accessToken || Date.now() > expiresAt - 60_000) {
      const refreshed = await refreshAccessToken(tokenRow.refresh_token);
      accessToken = refreshed.access_token;
      const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
      await admin.from("google_calendar_tokens").update({
        access_token: accessToken,
        expires_at: newExpiresAt,
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
    }

    // Dedup against events already on the calendar: same title on the same
    // day = already synced. Without this, every click re-creates the whole
    // batch as duplicates.
    const existingKeys = new Set<string>();
    try {
      const times = events
        .map((ev) => new Date(ev.start_time).getTime())
        .filter((t) => !isNaN(t));
      if (times.length > 0) {
        const timeMin = new Date(Math.min(...times) - 86_400_000).toISOString();
        const timeMax = new Date(Math.max(...times) + 86_400_000).toISOString();
        const listRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
            new URLSearchParams({
              timeMin,
              timeMax,
              singleEvents: "true",
              maxResults: "2500",
            }),
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (listRes.ok) {
          const listJson = await listRes.json();
          for (const item of listJson.items ?? []) {
            const summary: string = item.summary ?? "";
            const start: string = item.start?.dateTime ?? item.start?.date ?? "";
            if (!summary || !start) continue;
            // Google may echo dateTime back in the calendar's timezone, so
            // normalize to the UTC date before comparing.
            const t = new Date(start).getTime();
            const day = isNaN(t) ? start.slice(0, 10) : new Date(t).toISOString().slice(0, 10);
            existingKeys.add(`${summary}|${day}`);
          }
        }
      }
    } catch {
      // Dedup is best-effort; if the listing fails we still create events.
    }

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const ev of events) {
      const evTime = new Date(ev.start_time).getTime();
      const evDay = isNaN(evTime)
        ? ev.start_time.slice(0, 10)
        : new Date(evTime).toISOString().slice(0, 10);
      const key = `${ev.interview_title}|${evDay}`;
      if (existingKeys.has(key)) {
        skipped++;
        continue;
      }
      try {
        const res = await fetch(
          "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              summary: ev.interview_title,
              start: { dateTime: ev.start_time },
              end: { dateTime: ev.end_time },
            }),
          },
        );
        if (!res.ok) {
          const t = await res.text();
          errors.push(`${ev.interview_title}: ${res.status} ${t.slice(0, 120)}`);
        } else {
          created++;
        }
      } catch (err) {
        errors.push(`${ev.interview_title}: ${err instanceof Error ? err.message : "err"}`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      created,
      skipped,
      total: events.length,
      errors,
      message: skipped > 0
        ? `Created ${created} calendar events (${skipped} already existed)`
        : `Created ${created}/${events.length} calendar events`,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
