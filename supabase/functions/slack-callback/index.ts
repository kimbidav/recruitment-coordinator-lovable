import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const clientId = Deno.env.get("SLACK_CLIENT_ID");
    const clientSecret = Deno.env.get("SLACK_CLIENT_SECRET");
    if (!clientId || !clientSecret) throw new Error("Slack OAuth credentials not configured");

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

    const body = await req.json().catch(() => ({}));
    const code: string = body.code;
    const redirectUri: string = body.redirect_uri;
    const state: string = body.state;
    if (!code || !redirectUri) throw new Error("code and redirect_uri required");
    if (state !== userData.user.id) {
      return new Response(JSON.stringify({ error: "State mismatch" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Exchange code for token
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.ok) {
      throw new Error(`Slack OAuth failed: ${tokenData.error ?? "unknown"}`);
    }

    // user-token flow returns authed_user with access_token
    const authedUser = tokenData.authed_user ?? {};
    const userAccessToken: string | undefined = authedUser.access_token;
    const slackUserId: string | undefined = authedUser.id;
    const scope: string | undefined = authedUser.scope;
    const teamId: string | undefined = tokenData.team?.id;
    const teamName: string | undefined = tokenData.team?.name;

    if (!userAccessToken || !slackUserId || !teamId) {
      throw new Error("Slack OAuth response missing user token / id / team");
    }

    // Use service role to upsert (bypasses RLS), but we still scope to userData.user.id
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { error: upsertErr } = await admin
      .from("slack_tokens")
      .upsert(
        {
          user_id: userData.user.id,
          slack_user_id: slackUserId,
          slack_team_id: teamId,
          slack_team_name: teamName ?? null,
          access_token: userAccessToken,
          refresh_token: authedUser.refresh_token ?? null,
          expires_at: authedUser.expires_in
            ? new Date(Date.now() + authedUser.expires_in * 1000).toISOString()
            : null,
          scope: scope ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

    if (upsertErr) throw new Error(`DB upsert failed: ${upsertErr.message}`);

    return new Response(
      JSON.stringify({ ok: true, team_name: teamName ?? null, slack_user_id: slackUserId }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
