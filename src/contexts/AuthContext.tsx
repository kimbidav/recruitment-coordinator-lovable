import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Everyone whose last sign-in is older than this is signed out once, so they
 * sign in again and go through the new onboarding. To force another
 * company-wide sign-out later, move this forward. (The server-side
 * equivalent — revoking refresh tokens — is in docs/v2-rollout.md.)
 */
const FORCE_SIGN_IN_AFTER = Date.parse("2026-09-25T18:15:00Z");

function signedInBeforeCutoff(s: Session | null): boolean {
  const last = s?.user?.last_sign_in_at ? Date.parse(s.user.last_sign_in_at) : NaN;
  return !!s && Number.isFinite(last) && last < FORCE_SIGN_IN_AFTER;
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // IMPORTANT: subscribe before getSession so we don't miss the initial event.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
    });

    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (signedInBeforeCutoff(s)) {
        await supabase.auth.signOut();
        setSession(null);
        setUser(null);
        setLoading(false);
        return;
      }
      setSession(s);
      setUser(s?.user ?? null);
      setLoading(false);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
