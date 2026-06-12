import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

interface ConnectionRow {
  status: string;
  last_ok_at: string | null;
  seeded_by: string | null;
}

/**
 * Org-wide banner shown when the shared Ashby session has expired. The
 * session is self-service: ANY teammate can reconnect it via the
 * "Reconnect Ashby" button in the header — no designated owner.
 */
export function AshbyConnectionBanner() {
  const { user } = useAuth();
  const [connection, setConnection] = useState<ConnectionRow | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("ashby_connection")
        .select("status, last_ok_at, seeded_by")
        .eq("id", 1)
        .maybeSingle();
      if (!cancelled) setConnection(data ?? null);
    };
    void load();
    // Re-check occasionally so the banner clears after someone reconnects.
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user]);

  if (!connection || connection.status !== "expired") return null;

  const lastOk = connection.last_ok_at
    ? new Date(connection.last_ok_at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
      <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div>
        <p className="font-medium text-foreground">
          The shared Ashby connection expired — anyone can reconnect it.
        </p>
        <p className="text-xs text-muted-foreground">
          Click <span className="font-medium">Reconnect Ashby</span> in the header and paste your
          own Ashby session token (takes ~1 minute, fixes it for the whole team).
          {lastOk ? ` Last successful sync: ${lastOk}.` : ""}
        </p>
      </div>
    </div>
  );
}
