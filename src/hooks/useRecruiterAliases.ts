import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * The user's Ashby identity: which credited_to values in the org-shared
 * snapshot are THEM (e.g. {"David Kimball","david","dk"}). Captured at
 * onboarding into agent_settings.recruiter_aliases; drives the "My
 * candidates" pipeline filter, the calendar-sync guard, and (Phase 4) which
 * Ashby follow-up cards the agent generates for them.
 */
export function useRecruiterAliases() {
  const { user } = useAuth();
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasesLoaded, setAliasesLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("agent_settings")
      .select("recruiter_aliases")
      .eq("user_id", user.id)
      .maybeSingle();
    const loaded = (data as { recruiter_aliases?: string[] } | null)?.recruiter_aliases;
    setAliases(Array.isArray(loaded) ? loaded.filter((a) => typeof a === "string" && a.trim()) : []);
    setAliasesLoaded(true);
  }, [user?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveAliases = useCallback(
    async (next: string[]) => {
      if (!user) return false;
      const cleaned = Array.from(new Set(next.map((a) => a.trim()).filter(Boolean)));
      const { error } = await supabase.from("agent_settings").upsert(
        {
          user_id: user.id,
          recruiter_aliases: cleaned,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
      if (error) {
        console.error("Failed to save recruiter aliases:", error.message);
        return false;
      }
      setAliases(cleaned);
      return true;
    },
    [user?.id],
  );

  return { aliases, aliasesLoaded, saveAliases, refreshAliases: refresh };
}
