import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Download,
  Loader2,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
  Check,
  Shield,
  ChevronDown,
  PlayCircle,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { ASHBY_AUTOMATION_API_BASE } from "@/lib/ashbyAutomation";
import { clearStoredAshbyCookie } from "@/lib/ashbyCookie";
import {
  getJobProgress,
  getLatestRunningJob,
  pollFetchJob,
  type FetchJobProgress,
} from "@/lib/fetchJobs";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { normalizeTokenInput, validateToken } from "@/lib/ashbyToken";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

const PROGRESS_STEPS = [
  { at: 0, label: "Connecting to Ashby..." },
  { at: 5, label: "Authenticating session..." },
  { at: 10, label: "Discovering organizations..." },
  { at: 20, label: "Fetching open jobs..." },
  { at: 35, label: "Loading active candidates..." },
  { at: 50, label: "Pulling interview history..." },
  { at: 65, label: "Reading feedback..." },
  { at: 80, label: "Aggregating across orgs..." },
  { at: 90, label: "Finalizing results..." },
];

function useSimulatedProgress(active: boolean) {
  const [progress, setProgress] = useState(0);
  const [label, setLabel] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active) {
      setProgress(0);
      setLabel("");
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    let current = 0;
    setProgress(0);
    setLabel(PROGRESS_STEPS[0].label);

    intervalRef.current = setInterval(() => {
      current = Math.min(current + 0.5 + Math.random() * 1.5, 95);
      setProgress(current);
      for (let i = PROGRESS_STEPS.length - 1; i >= 0; i--) {
        if (current >= PROGRESS_STEPS[i].at) {
          setLabel(PROGRESS_STEPS[i].label);
          break;
        }
      }
    }, 800);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [active]);

  const complete = () => {
    setProgress(100);
    setLabel("Done!");
  };

  return { progress, label, complete };
}

interface AshbyFetchButtonProps {
  /** Called after a completed sync. Persistence happened SERVER-SIDE during
   *  the poll (org-shared snapshot tables) — the consumer just re-pulls. */
  onSyncComplete: () => Promise<void>;
}

type ConnectionStatus = "healthy" | "expired" | "disconnected" | "unknown";

/** Strip common paste mistakes (whole cookie header, name=value form, quotes, whitespace). */
const LOOM_WALKTHROUGH_URL = "https://www.loom.com/share/3423bbe88fdd4ad4819ce24afda058b1";

function detectOS(): "mac" | "win" {
  if (typeof navigator === "undefined") return "mac";
  const p = navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad/i.test(p) ? "mac" : "win";
}

const EXPIRY_PATTERN = /401|session expired|expired or invalid|reconnect/i;

export function AshbyFetchButton({ onSyncComplete }: AshbyFetchButtonProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [cookie, setCookie] = useState("");
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [staleJobNotified, setStaleJobNotified] = useState(false);
  const [liveProgress, setLiveProgress] = useState<FetchJobProgress | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("unknown");
  const { progress, label, complete } = useSimulatedProgress(loading);
  const os = useMemo(detectOS, []);
  const devtoolsKey = os === "mac" ? "⌘⌥I" : "F12";

  // The session is org-shared and lives on the extractor; per-user
  // localStorage cookies are a retired concept. Clean up old ones.
  useEffect(() => {
    clearStoredAshbyCookie();
  }, []);

  const refreshConnectionStatus = useCallback(async () => {
    try {
      const { data } = await supabase.functions.invoke("ashby-sync", {
        body: { action: "status" },
      });
      const status = (data as { connection?: { status?: string } } | null)?.connection?.status;
      if (status === "healthy" || status === "expired" || status === "disconnected") {
        setConnectionStatus(status);
      }
    } catch {
      // Leave as-is; sync attempts surface real errors.
    }
  }, []);

  useEffect(() => {
    if (user) void refreshConnectionStatus();
  }, [user, refreshConnectionStatus]);

  const describeFetchFailure = (message?: string | null) => {
    const trimmed = message?.trim();
    if (!trimmed) return "Ashby fetch failed before any candidates were returned.";
    if (trimmed.includes("401")) {
      return "The shared Ashby session expired during the fetch. Reconnect it below — any teammate's Ashby login works.";
    }
    if (trimmed.toLowerCase().includes("upstream error")) {
      return "The Ashby fetch service hit an upstream error before candidates were returned. This usually means the session went stale mid-run. Reconnect below and retry.";
    }
    return trimmed;
  };

  // On mount: warn if a previous fetch is still marked running (likely stalled).
  // Full sweeps can run well past 30 min on a slow day and now save
  // themselves when done, so only flag jobs that are hours old.
  useEffect(() => {
    if (!user || staleJobNotified) return;
    void (async () => {
      const job = await getLatestRunningJob(user.id);
      if (!job) return;
      const ageMin = (Date.now() - new Date(job.started_at).getTime()) / 60_000;
      if (ageMin > 120) {
        toast.warning(
          `An Ashby sync started ${ageMin.toFixed(0)} min ago never finished. It may have stalled — run Sync from Ashby again.`,
          { duration: 12000 },
        );
        setStaleJobNotified(true);
      }
    })();
  }, [user, staleJobNotified]);

  const validation = validateToken(cookie);

  const handleExpiry = (failureMessage: string) => {
    setConnectionStatus("expired");
    setFetchError(failureMessage);
    setOpen(true);
    toast.error(failureMessage);
  };

  // Watch for up to 60 min for live progress. Saving does NOT depend on this
  // loop any more: the extractor calls ashby-sync-callback when the sweep
  // finishes. Each poll goes through the edge function,
  // which is what actually advances the job (it checks the extractor's status).
  const pollJobUntilComplete = async (jobId: string) => {
    const pollStartedAt = Date.now();
    while (Date.now() - pollStartedAt < 3_600_000) {
      await new Promise((r) => setTimeout(r, 5000));
      const job = await pollFetchJob(jobId);
      if (!job) continue;

      if (job.status === "running") {
        setLiveProgress(getJobProgress(job));
        continue;
      }

      if (job.status === "failed") {
        const failureMessage = describeFetchFailure(job.error_message);
        if (EXPIRY_PATTERN.test(job.error_message ?? "")) {
          handleExpiry(failureMessage);
        } else {
          setFetchError(failureMessage);
          setOpen(true);
          toast.error(failureMessage);
        }
        return;
      }

      // Completed. The snapshot was persisted server-side by whichever poller
      // won the job — this client just re-pulls it and reports the job-row
      // stats (the bulky result payload is no longer retained).
      setConnectionStatus("healthy");
      complete();
      await new Promise((r) => setTimeout(r, 400));
      await onSyncComplete();
      const n = job.candidate_count ?? 0;
      const orgsFailed = job.orgs_failed ?? 0;
      const partial = job.status === "partial" || orgsFailed > 0;
      if (partial) {
        toast.warning(
          `Partial Ashby sync — ${orgsFailed} org(s) failed${job.orgs_total ? ` (${job.orgs_fetched ?? "?"}/${job.orgs_total})` : ""}. The snapshot keeps earlier data; re-sync to fill gaps.`,
          { duration: 15000 },
        );
      } else if (job.orgs_total) {
        toast.success(`Synced ${n} candidates from ${job.orgs_fetched ?? "?"}/${job.orgs_total} orgs`);
      } else {
        toast.success(`Synced ${n} candidates from Ashby`);
      }
      setOpen(false);
      return;
    }

    // The sweep saves itself when it finishes (the extractor calls Compass
    // back), so nobody has to keep this tab open.
    setOpen(false);
    toast.message("Ashby sync is still running — it will save automatically.", {
      description: "You can close this tab. Reload the page later to see the updated pipeline.",
      duration: 12000,
    });
  };

  const runSync = async () => {
    setFetchError(null);
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("ashby-sync", {
        body: {},
      });
      if (error) {
        // invoke() hides the response body on non-2xx; surface the real
        // message (e.g. "Ashby session expired") instead of the generic
        // "Edge Function returned a non-2xx status code".
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === "function") {
          const body = await ctx.json().catch(() => null);
          if (body?.error) throw new Error(body.error);
        }
        throw error;
      }

      const jobId = (data as { job?: { id?: string } } | null)?.job?.id;
      if (!jobId) throw new Error("Failed to start Ashby sync");
      await pollJobUntilComplete(jobId);
    } catch (err) {
      console.error("Ashby fetch error:", err);
      const message =
        err instanceof TypeError
          ? `Could not reach Ashby automation at ${ASHBY_AUTOMATION_API_BASE}.`
          : err instanceof Error && err.message
            ? err.message
            : "Failed to fetch from Ashby.";
      const failureMessage = describeFetchFailure(message);
      if (EXPIRY_PATTERN.test(message)) {
        handleExpiry(failureMessage);
      } else {
        setFetchError(failureMessage);
        setOpen(true);
        toast.error(failureMessage);
      }
    } finally {
      setLoading(false);
      setLiveProgress(null);
    }
  };

  const handleClick = () => {
    if (connectionStatus === "expired" || connectionStatus === "disconnected") {
      setFetchError(null);
      setOpen(true);
      return;
    }
    void (async () => {
      // Re-attach to a sweep that's still running (e.g. after a page reload,
      // or a teammate's sweep — the extractor runs one shared sweep at a time)
      // instead of starting a second one.
      const runningJob = user ? await getLatestRunningJob(user.id) : null;
      const isFresh =
        runningJob &&
        Date.now() - new Date(runningJob.started_at).getTime() < 120 * 60_000;
      if (runningJob && isFresh) {
        setLoading(true);
        try {
          await pollJobUntilComplete(runningJob.id);
        } finally {
          setLoading(false);
          setLiveProgress(null);
        }
        return;
      }
      await runSync();
    })();
  };

  // Seed: install a verified new shared session on the extractor, then sync.
  const handleDialogSubmit = () => {
    const cleaned = normalizeTokenInput(cookie);
    if (!cleaned) {
      toast.error("Please paste your Ashby session token");
      return;
    }
    const v = validateToken(cleaned);
    if (!v.valid) {
      toast.error(v.hint ?? "Token doesn't look right");
      return;
    }
    setFetchError(null);
    void (async () => {
      setSeeding(true);
      try {
        const { data, error } = await supabase.functions.invoke("ashby-sync", {
          body: { action: "seed", cookie: cleaned },
        });
        if (error) {
          const ctx = (error as { context?: Response }).context;
          if (ctx && typeof ctx.json === "function") {
            const body = await ctx.json().catch(() => null);
            if (body?.error) throw new Error(body.error);
          }
          throw error;
        }
        if ((data as { ok?: boolean } | null)?.ok !== true) {
          throw new Error("Seeding the Ashby session failed.");
        }
        setConnectionStatus("healthy");
        setCookie("");
        toast.success("Ashby reconnected for the whole team. Starting sync...");
      } catch (err) {
        const message = err instanceof Error && err.message ? err.message : "Could not reconnect Ashby.";
        setFetchError(message);
        toast.error(message);
        return;
      } finally {
        setSeeding(false);
      }
      await runSync();
    })();
  };

  const handlePaste = (raw: string) => {
    const cleaned = normalizeTokenInput(raw);
    setCookie(cleaned);
  };

  const needsReconnect = connectionStatus === "expired" || connectionStatus === "disconnected";

  return (
    <>
      <Button
        variant="outline"
        className="gap-2"
        onClick={handleClick}
        disabled={loading || seeding}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : needsReconnect ? (
          <KeyRound className="h-4 w-4" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        {loading
          ? liveProgress
            ? `Syncing ${liveProgress.completed}/${liveProgress.total} orgs...`
            : "Syncing..."
          : needsReconnect
            ? "Reconnect Ashby"
            : "Sync from Ashby"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Reconnect Ashby</DialogTitle>
            <DialogDescription>
              The whole team shares one Ashby connection, and it needs a re-login about
              once a week. Anyone can do it — your own Ashby session works for everyone.
              Follow the steps below; it takes about a minute.
            </DialogDescription>
          </DialogHeader>

          <div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-8 text-xs"
              onClick={() => window.open(LOOM_WALKTHROUGH_URL, "_blank", "noopener,noreferrer")}
            >
              <PlayCircle className="h-3.5 w-3.5" />
              Watch the 1-minute walkthrough
              <ExternalLink className="h-3 w-3 opacity-60" />
            </Button>
          </div>

          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">1</span>
              <div className="flex-1 space-y-2">
                <p>Open Ashby and make sure you're signed in.</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-7 text-xs"
                  onClick={() => window.open("https://app.ashbyhq.com/", "_blank", "noopener")}
                >
                  <ExternalLink className="h-3 w-3" />
                  Open Ashby
                </Button>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">2</span>
              <div className="flex-1">
                <p>
                  Open DevTools:{" "}
                  <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{devtoolsKey}</kbd>
                  {os === "mac" ? "" : " (or Ctrl+Shift+I)"}.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">3</span>
              <div className="flex-1">
                <p>
                  Go to the <span className="font-medium">Application</span> tab
                  {" "}(in Firefox: <span className="font-medium">Storage</span>).
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">4</span>
              <div className="flex-1">
                <p>
                  In the left sidebar, expand <span className="font-medium">Cookies</span> → select{" "}
                  <span className="font-medium">https://app.ashbyhq.com</span>.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">5</span>
              <div className="flex-1">
                <p>
                  Find the row{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">ashby_session_token</code>,
                  double-click its <span className="font-medium">Value</span>, and copy it.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">6</span>
              <div className="flex-1">
                <p>Paste it into the field below.</p>
              </div>
            </li>
          </ol>

          {/* Token input */}
          <div className="space-y-1.5">
            <div className="relative">
              <Textarea
                placeholder="Paste your ashby_session_token value here..."
                value={cookie}
                onChange={(e) => handlePaste(e.target.value)}
                rows={3}
                className={cn(
                  "font-mono text-xs pr-9",
                  cookie && validation.valid && "border-emerald-500/60 focus-visible:ring-emerald-500/30",
                  cookie && !validation.valid && "border-destructive/60 focus-visible:ring-destructive/30",
                )}
                disabled={loading || seeding}
              />
              {cookie && validation.valid && (
                <Check className="absolute right-2 top-2 h-4 w-4 text-emerald-600" />
              )}
            </div>
            {cookie && !validation.valid && validation.hint && (
              <p className="text-xs text-destructive">{validation.hint}</p>
            )}
            {cookie && validation.valid && (
              <p className="text-xs text-emerald-600">Looks good — ready to reconnect.</p>
            )}
          </div>

          {/* Privacy disclosure */}
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Shield className="h-3 w-3" />
              Why do you need this?
              <ChevronDown className="h-3 w-3" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 text-xs text-muted-foreground space-y-1">
              <p>
                Ashby has no per-user API key for external recruiters, so the team shares one
                session that our extraction service keeps alive. When it expires (~weekly),
                whoever needs data next reconnects it with their own login.
              </p>
              <p>
                The token is sent once to our extraction service and stored there — never in
                your browser. Heads up: the Ashby tab you copied it from may get signed out
                once the service starts using it; that's expected, just sign back in.
              </p>
            </CollapsibleContent>
          </Collapsible>

          {fetchError && !loading && !seeding && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-foreground">
              <p className="font-medium text-destructive">Something went wrong.</p>
              <p className="mt-1 text-muted-foreground">{fetchError}</p>
            </div>
          )}

          {loading && (
            <div className="space-y-3 py-1">
              <Progress
                value={liveProgress ? Math.round((liveProgress.completed / liveProgress.total) * 100) : progress}
                className="h-2"
              />
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                {liveProgress
                  ? `Sweeping orgs (${liveProgress.completed}/${liveProgress.total})${liveProgress.current_org ? `: ${liveProgress.current_org}` : ""}`
                  : label}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              onClick={handleDialogSubmit}
              disabled={loading || seeding || !validation.valid}
              className="gap-2"
            >
              {seeding || loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {seeding ? "Reconnecting..." : loading ? "Syncing..." : "Reconnect & Sync"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
