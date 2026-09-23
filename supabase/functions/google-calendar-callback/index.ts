import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { consumeOAuthState } from "../_shared/oauthState.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    if (!clientId || !clientSecret) throw new Error("Google OAuth secrets missing");

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

    const { code, redirect_uri, state } = await req.json();
    if (!code || !redirect_uri) throw new Error("code and redirect_uri required");
    // Use service role to upsert (RLS-friendly upsert needs both insert+update; service role simplifies)
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    if (!(await consumeOAuthState(admin, state, userId, "google"))) throw new Error("State mismatch");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri,
        grant_type: "authorization_code",
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokenJson)}`);
    }

    const { access_token, refresh_token, expires_in, scope } = tokenJson;
    if (!refresh_token) {
      throw new Error("No refresh_token returned. Revoke app access in Google account & retry.");
    }

    // Get email
    let googleEmail: string | null = null;
    try {
      const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (ui.ok) googleEmail = (await ui.json()).email ?? null;
    } catch { /* ignore */ }

    const expiresAt = new Date(Date.now() + (expires_in ?? 3600) * 1000).toISOString();

    const { error: upsertErr } = await admin
      .from("google_calendar_tokens")
      .upsert({
        user_id: userId,
        refresh_token,
        access_token,
        expires_at: expiresAt,
        scope,
        google_email: googleEmail,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    if (upsertErr) throw new Error(`DB upsert failed: ${upsertErr.message}`);

    return new Response(JSON.stringify({ success: true, email: googleEmail }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
