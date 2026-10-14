import { useEffect } from "react";
import { KeyRound } from "lucide-react";
import { Link } from "react-router-dom";
import { useAshbyUserSession } from "@/hooks/useAshbyUserSession";

/**
 * Shown when the signed-in recruiter's OWN Ashby login has expired: Slack
 * uploads won't work until they reconnect. Probes the extractor live on
 * mount — the stored status only changes when something asks, and a login
 * that died quietly must not keep reading "Connected".
 */
export function AshbyUserSessionBanner() {
  const { session, overdue, refresh } = useAshbyUserSession();
  useEffect(() => { void refresh(true); }, [refresh]);
  if (session.status !== "expired" && !overdue) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
      <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div>
        <p className="font-medium text-foreground">Your Ashby login for Compass expired.</p>
        <p className="text-xs text-muted-foreground">
          "Add to Ashby" in Slack will fail until you{" "}
          <Link to="/onboarding?step=ashby" className="font-medium underline">reconnect Ashby</Link> (about a minute).
        </p>
      </div>
    </div>
  );
}
