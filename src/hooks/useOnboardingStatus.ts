import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { getStoredAshbyCookie } from "@/lib/ashbyCookie";

export interface OnboardingStatus {
  googleConnected: boolean;
  googleEmail: string | null;
  slackConnected: boolean;
  slackTeamName: string | null;
  ashbyConnected: boolean;
  hasCandidates: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Reads the user's onboarding state from one source of truth so the
 * routing guard and the onboarding screen never disagree.
 */
export function useOnboardingStatus(): OnboardingStatus {
  const { user, loading: authLoading } = useAuth();
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  const [slackConnected, setSlackConnected] = useState(false);
  const [slackTeamName, setSlackTeamName] = useState<string | null>(null);
  const [ashbyConnected, setAshbyConnected] = useState(false);
  const [hasCandidates, setHasCandidates] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [googleRes, slackRes, candidatesRes] = await Promise.all([
        supabase
          .from("google_calendar_tokens")
          .select("google_email")
          .maybeSingle(),
        supabase
          .from("slack_tokens")
          .select("slack_team_name")
          .maybeSingle(),
        supabase
          .from("candidates")
          .select("id", { count: "exact", head: true })
          .limit(1),
      ]);

      setGoogleConnected(!!googleRes.data);
      setGoogleEmail(googleRes.data?.google_email ?? null);
      setSlackConnected(!!slackRes.data);
      setSlackTeamName(slackRes.data?.slack_team_name ?? null);
      setHasCandidates((candidatesRes.count ?? 0) > 0);
      setAshbyConnected(!!getStoredAshbyCookie());
    } catch {
      // Non-fatal — leave defaults.
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (authLoading) return;
    void refresh();
  }, [authLoading, refresh]);

  return {
    googleConnected,
    googleEmail,
    slackConnected,
    slackTeamName,
    ashbyConnected,
    hasCandidates,
    loading: loading || authLoading,
    refresh,
  };
}
