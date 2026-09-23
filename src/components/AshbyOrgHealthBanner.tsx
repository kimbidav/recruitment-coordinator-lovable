import { useState } from "react";
import { EyeOff, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { CoverageEntry, OrgAudit } from "@shared/pure/orgHealth";

/**
 * Org reachability banner. An org that disappears from the Ashby sweep is a
 * BLIND SPOT, not a conclusion: its rows stop refreshing while still
 * rendering as a live pipeline. The audit written by every sync lists such
 * orgs with the measured age of their stalest row. Two human actions, both
 * statements about ACCESS (never about any candidate's outcome):
 *   - Retire: the team no longer expects access; rows demote to the archive
 *     as org_status="retired" (not Archived) on the next sync.
 *   - Restore: access is back; the next sync un-retires the rows.
 * Nothing here is ever inferred.
 */
export function AshbyOrgHealthBanner({ audit, onChanged }: { audit: OrgAudit | null; onChanged?: () => void }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  if (!audit) return null;
  const blind = audit.blind_spots ?? [];
  const retired = audit.retired ?? [];
  if (blind.length === 0 && retired.length === 0) return null;

  const retire = async (entry: CoverageEntry) => {
    if (!user) return;
    const ok = window.confirm(
      `Retire ${entry.company}?\n\nThis records that the team no longer has Ashby access to this client. ` +
        `Its ${entry.live_rows} live row(s) move to the archive as "access lost" on the next sync — nothing is marked Archived or Hired.`,
    );
    if (!ok) return;
    setBusy(entry.company);
    const { error } = await supabase
      .from("ashby_retired_orgs")
      .insert({ org_name: entry.company, retired_by: user.id, note: `retired from dashboard; ${entry.live_rows} live rows` });
    setBusy(null);
    if (error) {
      toast.error(`Could not retire ${entry.company}: ${error.message}`);
      return;
    }
    toast.success(`${entry.company} retired — rows demote on the next Ashby sync.`);
    onChanged?.();
  };

  const restore = async (entry: CoverageEntry) => {
    setBusy(entry.company);
    const { error } = await supabase.from("ashby_retired_orgs").delete().eq("org_name", entry.company);
    setBusy(null);
    if (error) {
      toast.error(`Could not restore ${entry.company}: ${error.message}`);
      return;
    }
    toast.success(`${entry.company} restored — rows un-retire on the next sync if access is back.`);
    onChanged?.();
  };

  const checked = new Date(audit.checked_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
      {blind.length > 0 && (
        <>
          <div className="flex items-start gap-2.5">
            <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">
                {blind.length} client{blind.length === 1 ? "" : "s"} with live candidates {blind.length === 1 ? "was" : "were"} not in the last Ashby sync.
              </p>
              <p className="text-xs text-muted-foreground">
                Their rows cannot refresh until access returns — they may look live long after the process ended. Either restore access in
                Ashby, or retire the client if the team no longer works with them. Checked {checked}.
              </p>
            </div>
          </div>
          <ul className="mt-2 space-y-1">
            {blind.map((e) => (
              <li key={e.company} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-medium text-foreground">{e.company}</span>
                <span className="text-muted-foreground">
                  {e.live_rows} live row{e.live_rows === 1 ? "" : "s"}
                  {e.stalest_data_age_days !== null ? ` · stage data ${e.stalest_data_age_days}d old` : ""}
                  {e.recruiters.length ? ` · ${e.recruiters.join(", ")}` : ""}
                </span>
                <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy === e.company} onClick={() => retire(e)}>
                  Retire
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {retired.length > 0 && (
        <div className={blind.length ? "mt-2 border-t border-amber-500/20 pt-2" : ""}>
          <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowRetired((v) => !v)}>
            {retired.length} retired client{retired.length === 1 ? "" : "s"} (access lost) {showRetired ? "▾" : "▸"}
          </button>
          {showRetired && (
            <ul className="mt-1 space-y-1">
              {retired.map((e) => (
                <li key={e.company} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="font-medium text-foreground">{e.company}</span>
                  <span className="text-muted-foreground">{e.live_rows} row{e.live_rows === 1 ? "" : "s"} in archive as "access lost"</span>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy === e.company} onClick={() => restore(e)}>
                    <RotateCcw className="mr-1 h-3 w-3" /> Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
