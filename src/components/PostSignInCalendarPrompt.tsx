import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

const PENDING_CALENDAR_KEY = "pendingCalendarConnect";

/**
 * After a fresh "Continue with Google" sign-in, automatically launch the
 * Google Calendar OAuth consent so the user only takes one Google trip.
 *
 * Renders nothing. Triggers a full-page redirect when conditions match.
 */
export const PostSignInCalendarPrompt = () => {
  const { user, loading } = useAuth();
  const ranRef = useRef(false);

  useEffect(() => {
    if (loading || !user || ranRef.current) return;
    if (sessionStorage.getItem(PENDING_CALENDAR_KEY) !== "1") return;
    ranRef.current = true;

    void (async () => {
      try {
        // Skip if already connected.
        const { data: existing } = await supabase
          .from("google_calendar_tokens")
          .select("user_id")
          .maybeSingle();
        if (existing) {
          sessionStorage.removeItem(PENDING_CALENDAR_KEY);
          return;
        }

        sessionStorage.removeItem(PENDING_CALENDAR_KEY);
        const redirectUri = `${window.location.origin}/google-calendar/callback`;
        const { data, error } = await supabase.functions.invoke(
          "google-calendar-connect",
          { body: { redirect_uri: redirectUri } },
        );
        if (error || !data?.url) {
          toast.error(
            `Couldn't auto-connect Google Calendar: ${error?.message || data?.error || "no url"}. Use the Connect button instead.`,
          );
          return;
        }
        window.location.href = data.url;
      } catch (e) {
        sessionStorage.removeItem(PENDING_CALENDAR_KEY);
        toast.error(
          `Couldn't auto-connect Google Calendar: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
    })();
  }, [user, loading]);

  return null;
};
