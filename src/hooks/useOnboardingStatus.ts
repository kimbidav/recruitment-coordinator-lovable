import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface OnboardingStatus {
  googleConnected: boolean;
  /** Connected AND granted Calendar + Gmail read/send. */
  googleReady: boolean;
  googleEmail: string | null;
  slackConnected: boolean;
  /** Connected with the current permissions (resume files + search); the
   *  same flow installs the bot that runs Add to Ashby. */
  slackReady: boolean;
  slackTeamName: string | null;
  /** The signed-in recruiter's OWN Ashby login (drives Slack uploads). */
  ashbyConnected: boolean;
  /** The shared team session used for pipeline reads. */
  teamAshbyConnected: boolean;
  /** Has connected their own Ashby at least once (an expired login still
   *  counts: the weekly expiry is handled by a banner, not a lockout). */
  ashbyEverConnected: boolean;
  /** The onboarding version this user last finished (0 = never). */
  onboardingVersion: number;
  /** Google, Slack and their own Ashby — what Add to Ashby needs. */
  requiredDone: boolean;
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
  const [googleReady, setGoogleReady] = useState(false);
  const [slackReady, setSlackReady] = useState(false);
  const [slackTeamName, setSlackTeamName] = useState<string | null>(null);
  const [ashbyConnected, setAshbyConnected] = useState(false);
  const [teamAshbyConnected, setTeamAshbyConnected] = useState(false);
  const [ashbyEverConnected, setAshbyEverConnected] = useState(false);
  const [onboardingVersion, setOnboardingVersion] = useState(0);
  const [hasCandidates, setHasCandidates] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [googleRes, slackRes, candidatesRes, ashbyRes, userAshbyRes, settingsRes] = await Promise.all([
        supabase
          .from("google_calendar_tokens")
          .select("google_email, scope")
          .maybeSingle(),
        supabase
          .from("slack_tokens")
          .select("slack_team_name, scope")
          .maybeSingle(),
        supabase
          .from("candidates")
          .select("id", { count: "exact", head: true })
          .limit(1),
        // Org-wide shared session: connected for everyone or no one. New
        // teammates skip the Ashby step when the team session is healthy.
        supabase
          .from("ashby_connection")
          .select("status")
          .eq("id", 1)
          .maybeSingle(),
        supabase
          .from("ashby_user_sessions")
          .select("status")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("agent_settings")
          .select("onboarding_version")
          .eq("user_id", user.id)
          .maybeSingle(),
      ]);

      setGoogleConnected(!!googleRes.data);
      const gScope = (googleRes.data?.scope ?? "") as string;
      setGoogleReady(!!googleRes.data && ["calendar.events", "gmail.readonly", "gmail.send"].every((x) => gScope.includes(x)));
      const sScope = (slackRes.data?.scope ?? "") as string;
      setSlackReady(!!slackRes.data && ["files:read", "search:read"].every((x) => sScope.includes(x)));
      setGoogleEmail(googleRes.data?.google_email ?? null);
      setSlackConnected(!!slackRes.data);
      setSlackTeamName(slackRes.data?.slack_team_name ?? null);
      setHasCandidates((candidatesRes.count ?? 0) > 0);
      setTeamAshbyConnected(ashbyRes.data?.status === "healthy");
      setAshbyConnected(userAshbyRes.data?.status === "healthy");
      setAshbyEverConnected(["healthy", "expired", "unknown"].includes(String(userAshbyRes.data?.status ?? "")));
      setOnboardingVersion(Number((settingsRes.data as { onboarding_version?: number } | null)?.onboarding_version ?? 0));
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
    googleReady,
    googleEmail,
    slackConnected,
    slackReady,
    slackTeamName,
    ashbyConnected,
    teamAshbyConnected,
    ashbyEverConnected,
    onboardingVersion,
    requiredDone: googleReady && slackReady && ashbyEverConnected,
    hasCandidates,
    loading: loading || authLoading,
    refresh,
  };
}
