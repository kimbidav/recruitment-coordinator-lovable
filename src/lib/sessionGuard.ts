// ============= New file: src/lib/sessionGuard.ts =============
import { supabase } from "@/integrations/supabase/client";

/**
 * A tab can keep holding a session the backend no longer accepts: the signing
 * keys were rotated, the recruiter signed out (or signed in) somewhere else,
 * or the refresh token died. The tab still believes it is signed in, so the
 * protected screens render and every hook fires with a dead token — a wall of
 * 401s and a blank screen instead of a way back in.
 *
 * Anything that hears "this token is no good" says so here. The session is
 * dropped exactly once, which routes the app to the sign-in screen.
 */

let dropped = false;
let installed = false;

// Only JWT-validity wording. RLS/permission denials must never sign anyone out.
const JWT_REJECTION =
  /invalid jwt|jwt expired|token signature is invalid|no suitable key|token has expired|invalid claim|signature is invalid/i;

export function isUnauthorizedError(error: unknown): boolean {
  if (!error) return false;
  const e = error as {
    status?: number;
    statusCode?: number;
    code?: string;
    message?: string;
    context?: { status?: number };
  };
  const status = e.status ?? e.statusCode ?? e.context?.status;
  const message = String(e.message ?? "");
  if (e.code === "PGRST301") return true; // PostgREST: the JWT could not be decoded
  if (status === 401) return true; // the token was refused outright
  if (status === 403 && JWT_REJECTION.test(message)) return true; // Auth: invalid JWT
  return false;
}

/** Drop the session the backend has rejected — the first caller wins. */
export function notifyUnauthorized(): void {
  if (dropped) return;
  dropped = true;
  void supabase.auth.signOut().finally(() => {
    dropped = false;
  });
}

/**
 * Watch every edge-function call from one place instead of re-checking the
 * same 401 at each of the twenty call sites. Installed once, on app start.
 */
export function installSessionGuard(): void {
  if (installed) return;
  installed = true;
  type Invoke = typeof supabase.functions.invoke;
  const original = supabase.functions.invoke.bind(supabase.functions) as unknown as (
    ...args: unknown[]
  ) => Promise<{ error?: unknown }>;
  supabase.functions.invoke = ((...args: unknown[]) =>
    original(...args).then((res) => {
      if (isUnauthorizedError(res?.error)) notifyUnauthorized();
      return res;
    })) as unknown as Invoke;
}
