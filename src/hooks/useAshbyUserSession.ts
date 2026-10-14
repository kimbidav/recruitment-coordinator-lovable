import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { isUnauthorizedError, notifyUnauthorized } from "@/lib/sessionGuard";

export interface AshbyUserSession {
  status: "healthy" | "expired" | "unknown" | "disconnected";
  email: string | null;
  org_count: number;
  identity_verified: boolean;
  last_seeded_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  expires_estimate_at: string | null;
}

const EMPTY: AshbyUserSession = {
  status: "disconnected", email: null, org_count: 0, identity_verified: false,
  last_seeded_at: null, last_ok_at: null, last_error: null, expires_estimate_at: null,
};

/**
 * The signed-in recruiter's OWN Ashby login (health only; the login lives on
 * the extractor). `seed` sends a pasted session token under this user's
 * email — the extractor refuses a token that belongs to someone else.
 */
export function useAshbyUserSession() {
  const { user } = useAuth();
  const [session, setSession] = useState<AshbyUserSession>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [liveChecked, setLiveChecked] = useState(false);

  const refresh = useCallback(async (live = false) => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    try {
      if (live) {
        const { data, error } = await supabase.functions.invoke("ashby-user-session", { body: { action: "status", live: true } });
        // A dead token answers 401; re-reading it from the database just 401s
        // again. Say so once and let the app return to the sign-in screen.
        if (isUnauthorizedError(error)) { notifyUnauthorized(); return; }
        if (data?.session) {
          setSession({ ...EMPTY, ...data.session });
          if (data?.probe?.reason !== "probe_error") setLiveChecked(true);
          return;
        }
      }
      const { data, error: dbError } = await supabase.from("ashby_user_sessions").select("*").eq("user_id", user.id).maybeSingle();
      if (isUnauthorizedError(dbError)) { notifyUnauthorized(); return; }
      setSession(data ? { ...EMPTY, ...(data as Partial<AshbyUserSession>) } : EMPTY);
    } catch {
      // leave the last known state
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const seed = useCallback(async (cookie: string): Promise<{ ok: true; org_count: number } | { ok: false; error: string; detail: string | null }> => {
    const { data, error } = await supabase.functions.invoke("ashby-user-session", { body: { action: "seed", cookie } });
    if (isUnauthorizedError(error)) notifyUnauthorized();
    if (error || data?.error) {
      // supabase-js hides non-2xx bodies behind `error`; the function also returns the body on 200-ish paths.
      const body = data ?? (await error?.context?.json?.().catch(() => null));
      await refresh();
      return { ok: false, error: body?.error ?? error?.message ?? "seed_failed", detail: body?.detail ?? null };
    }
    await refresh();
    return { ok: true, org_count: data.org_count ?? 0 };
  }, [refresh]);

  const disconnect = useCallback(async () => {
    await supabase.functions.invoke("ashby-user-session", { body: { action: "disconnect" } });
    await refresh();
  }, [refresh]);

  /** Past the ~7-day estimate: treat as needing a reconnect even if no probe has run. */
  const overdue = session.status === "healthy" && !!session.expires_estimate_at && Date.parse(session.expires_estimate_at) < Date.now();
  return { session, loading, liveChecked, overdue, refresh, seed, disconnect };
}
