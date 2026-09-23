// OAuth `state` nonces. Issued by the *-connect functions, consumed once by
// the matching callback. Replaces the old scheme where `state` was the user
// id, which any callback URL could replay. Service-role client only.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

export type OAuthProvider = "slack" | "google";

const STATE_TTL_MS = 15 * 60 * 1000;

export async function issueOAuthState(
  admin: SupabaseClient,
  userId: string,
  provider: OAuthProvider,
): Promise<string> {
  const state = crypto.randomUUID();
  const { error } = await admin.from("oauth_states").insert({ state, user_id: userId, provider });
  if (error) throw new Error(`could not issue oauth state: ${error.message}`);
  // Opportunistic cleanup of stale nonces; never blocks the flow.
  await admin
    .from("oauth_states")
    .delete()
    .lt("created_at", new Date(Date.now() - STATE_TTL_MS).toISOString())
    .then(() => undefined, () => undefined);
  return state;
}

/**
 * True when `state` was issued to this user for this provider within the TTL.
 * The nonce is deleted on the first check whatever the outcome, so it can't be
 * replayed.
 */
export async function consumeOAuthState(
  admin: SupabaseClient,
  state: string | null | undefined,
  userId: string,
  provider: OAuthProvider,
): Promise<boolean> {
  if (!state || !/^[0-9a-f-]{36}$/i.test(state)) return false;
  const { data } = await admin
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .select("user_id, provider, created_at")
    .maybeSingle();
  if (!data) return false;
  if (data.user_id !== userId || data.provider !== provider) return false;
  return Date.now() - new Date(data.created_at as string).getTime() <= STATE_TTL_MS;
}
