// One Google access-token refresh, replacing the copies in gmail-helper,
// agent-scan and google-calendar-sync. Refreshes within 60 s of expiry and
// writes the new token back so the next function call doesn't pay again.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

export interface GoogleTokenRow {
  user_id: string;
  refresh_token: string;
  access_token: string | null;
  expires_at: string | null;
  scope: string | null;
  google_email: string | null;
}

export class GoogleNotConnected extends Error {
  code = "google_not_connected";
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Google OAuth secrets missing");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`Google token refresh failed: ${JSON.stringify(json).slice(0, 200)}`);
  return { access_token: json.access_token, expires_in: json.expires_in ?? 3600 };
}

/** The user's Google token row with a valid access token, refreshing if needed. */
export async function googleAccessToken(admin: SupabaseClient, userId: string): Promise<GoogleTokenRow & { access_token: string }> {
  const { data: row, error } = await admin.from("google_calendar_tokens").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new GoogleNotConnected("Google not connected");
  const token = row as GoogleTokenRow;
  const expiresAt = token.expires_at ? new Date(token.expires_at).getTime() : 0;
  if (token.access_token && Date.now() < expiresAt - 60_000) return { ...token, access_token: token.access_token };
  const refreshed = await refreshGoogleAccessToken(token.refresh_token);
  const expires_at = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await admin
    .from("google_calendar_tokens")
    .update({ access_token: refreshed.access_token, expires_at, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  return { ...token, access_token: refreshed.access_token, expires_at };
}

export function hasScope(row: { scope: string | null }, scope: string): boolean {
  return (row.scope ?? "").includes(scope);
}
