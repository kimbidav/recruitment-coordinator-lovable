import { useState, useEffect, useRef, useMemo } from "react";
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
import { Candidate } from "@/data/candidates";
import { ASHBY_AUTOMATION_API_BASE } from "@/lib/ashbyAutomation";
import {
  getStoredAshbyCookie,
  setStoredAshbyCookie,
  clearStoredAshbyCookie,
} from "@/lib/ashbyCookie";
import {
  getJobProgress,
  getLatestRunningJob,
  pollFetchJob,
  type FetchJobProgress,
} from "@/lib/fetchJobs";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
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
  /** Accumulate-and-merge handler: stored candidates are never deleted; per-field merge. */
  onMergeFetch: (candidates: Candidate[]) => Promise<void>;
}

interface ExtractionStats {
  orgs_total?: number;
  orgs_fetched?: number;
  orgs_failed?: number;
  orgs_retried?: number;
  total_seconds?: number;
}

function parseAshbyResponse(data: unknown): { candidates: Candidate[]; stats: ExtractionStats } {
  if (Array.isArray(data)) return { candidates: data as Candidate[], stats: {} };
  if (data && typeof data === "object") {
    const obj = data as { candidates?: unknown; extraction_stats?: ExtractionStats };
    if (Array.isArray(obj.candidates)) {
      return { candidates: obj.candidates as Candidate[], stats: obj.extraction_stats ?? {} };
    }
  }
  return { candidates: [], stats: {} };
}

/** Strip common paste mistakes (whole cookie header, name=value form, quotes, whitespace). */
function normalizeTokenInput(raw: string): string {
  let v = raw.trim();
  // Strip surrounding quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  // If they pasted a whole "cookie:" header, try to extract the token
  const cookieHeaderMatch = v.match(/ashby_session_token\s*=\s*([^;\s]+)/i);
  if (cookieHeaderMatch) v = cookieHeaderMatch[1];
  // If they copied the DevTools row "ashby_session_token<TAB>value..."
  if (v.toLowerCase().startsWith("ashby_session_token")) {
    const parts = v.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) v = parts[1];
  }
  return v.trim();
}

function validateToken(v: string): { valid: boolean; hint: string | null } {
  if (!v) return { valid: false, hint: null };
  if (v.length < 20) return { valid: false, hint: "Token looks too short" };
  if (/\s/.test(v)) return { valid: false, hint: "Token shouldn't contain spaces" };
  if (v.includes("=")) return { valid: false, hint: "Looks like you pasted name=value — paste only the value" };
  return { valid: true, hint: null };
}

const LOOM_WALKTHROUGH_URL = "https://www.loom.com/share/3423bbe88fdd4ad4819ce24afda058b1";

function detectOS(): "mac" | "win" {
  if (typeof navigator === "undefined") return "mac";
  const p = navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad/i.test(p) ? "mac" : "win";
}

function harvestClientNames(candidates: Candidate[], stats: ExtractionStats): string[] {
  const clientNames = Array.from(
    new Set(
      candidates
        .map((c) => (c.company_name ?? "").trim())
        .filter((n) => n.length > 0),
    ),
  );
  const statsAny = stats as unknown as Record<string, unknown>;
  const harvestFromValue = (v: unknown) => {
    if (!v) return;
    if (typeof v === "string") {
      const name = v.trim();
      if (name && !clientNames.includes(name)) clientNames.push(name);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) harvestFromValue(item);
      return;
    }
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      for (const k of ["name", "org_name", "organization", "org", "client_name", "company_name"]) {
        if (typeof obj[k] === "string") {
          harvestFromValue(obj[k]);
          return;
        }
      }
    }
  };
  for (const key of ["orgs", "org_names", "per_org", "orgs_breakdown", "organizations"]) {
    harvestFromValue(statsAny[key]);
  }
  for (const [k, v] of Object.entries(statsAny)) {
    if (v && typeof v === "object" && !Array.isArray(v) && /^[A-Z]/.test(k) && k.length < 80) {
      if (!clientNames.includes(k)) clientNames.push(k);
    }
  }
  return clientNames;
}

async function persistKnownClients(userId: string, clientNames: string[]) {
  if (!clientNames.length) return;
  const rows = clientNames.map((client_name) => ({
    user_id: userId,
    client_name,
    last_seen_at: new Date().toISOString(),
  }));
  await supabase.from("ashby_known_clients").upsert(rows, { onConflict: "user_id,client_name" });
  const { data: knownAll } = await supabase
    .from("ashby_known_clients")
    .select("client_name, last_seen_at")
    .eq("user_id", userId)
    .order("client_name");
  console.log(
    `[Ashby fetch] harvested ${clientNames.length} companies this run; ${knownAll?.length ?? 0} total Ashby companies known:`,
  );
  console.table((knownAll ?? []).map((r) => ({ company: r.client_name, last_seen: r.last_seen_at })));
}

async function applyFetchResult(args: {
  cookie: string;
  data: unknown;
  userId?: string;
  complete: () => void;
  onMergeFetch: (candidates: Candidate[]) => Promise<void>;
  closeDialog: () => void;
  clearInput: () => void;
}) {
  const { cookie, data, userId, complete, onMergeFetch, closeDialog, clearInput } = args;
  const { candidates, stats } = parseAshbyResponse(data);
  const orgsTotal = stats.orgs_total;
  const orgsFetched = stats.orgs_fetched;
  const orgsFailed = stats.orgs_failed ?? 0;
  const statsAny = stats as unknown as { complete?: boolean };
  // Partial if the extractor says the sweep didn't complete OR any org failed.
  const partial = statsAny.complete === false || orgsFailed > 0;

  if (candidates.length === 0) {
    toast.error("No candidates returned from Ashby");
    return;
  }

  const byCompany = new Map<string, number>();
  for (const c of candidates) {
    const name = (c.company_name ?? "").trim() || "(unknown)";
    byCompany.set(name, (byCompany.get(name) ?? 0) + 1);
  }
  const breakdown = Array.from(byCompany.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`[Ashby fetch] ${candidates.length} candidates across ${byCompany.size} companies (partial=${partial}):`);
  console.table(breakdown.map(([company, n]) => ({ company, candidates: n })));
  (window as unknown as Record<string, unknown>).__lastAshbyFetch = {
    candidates,
    stats,
    byCompany: Object.fromEntries(breakdown),
    partial,
    at: new Date().toISOString(),
  };

  complete();
  await new Promise((r) => setTimeout(r, 400));
  setStoredAshbyCookie(cookie);
  // ALWAYS merge. Stored rows the fetch didn't return are kept, and interview /
  // feedback enrichment accumulates across runs — the extractor enriches as many
  // candidates as fit its per-run budget, so repeated syncs fill in the rest.
  await onMergeFetch(candidates);

  if (userId) {
    await persistKnownClients(userId, harvestClientNames(candidates, stats));
  }

  if (partial) {
    toast.warning(
      `Partial Ashby fetch — ${orgsFailed} org(s) failed${orgsTotal ? ` (${orgsFetched ?? "?"}/${orgsTotal})` : ""}. Showing accumulated data; re-run to fill gaps.`,
      { duration: 15000 },
    );
  } else if (orgsTotal && orgsFetched !== undefined) {
    toast.success(`Merged ${candidates.length} candidates from ${orgsFetched}/${orgsTotal} orgs`);
  } else {
    toast.success(`Merged ${candidates.length} candidates from Ashby`);
  }

  closeDialog();
  clearInput();
}


export function AshbyFetchButton({ onMergeFetch }: AshbyFetchButtonProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [cookie, setCookie] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [staleJobNotified, setStaleJobNotified] = useState(false);
  const [liveProgress, setLiveProgress] = useState<FetchJobProgress | null>(null);
  const { progress, label, complete } = useSimulatedProgress(loading);
  const os = useMemo(detectOS, []);
  const devtoolsKey = os === "mac" ? "⌘⌥I" : "F12";

  const describeFetchFailure = (message?: string | null) => {
    const trimmed = message?.trim();
    if (!trimmed) return "Ashby fetch failed before any candidates were returned.";
    if (trimmed.includes("401")) {
      return "Your Ashby session expired during the fetch. Copy a fresh token from the same Ashby tab and try again.";
    }
    if (trimmed.toLowerCase().includes("upstream error")) {
      return "The Ashby fetch service hit an upstream error before candidates were returned. This usually means the session went stale mid-run, so grab a fresh token from the same signed-in Ashby tab and retry.";
    }
    return trimmed;
  };

  // On mount: warn if a previous fetch is still marked running (likely stalled).
  // Full sweeps can legitimately take 15-20 min, so only flag truly old jobs.
  useEffect(() => {
    if (!user || staleJobNotified) return;
    void (async () => {
      const job = await getLatestRunningJob(user.id);
      if (!job) return;
      const ageMin = (Date.now() - new Date(job.started_at).getTime()) / 60_000;
      if (ageMin > 30) {
        toast.warning(
          `A previous Ashby fetch from ${ageMin.toFixed(0)} min ago is still marked running. It may have stalled — re-run when ready.`,
          { duration: 12000 },
        );
        setStaleJobNotified(true);
      }
    })();
  }, [user, staleJobNotified]);

  const validation = validateToken(cookie);

  // A full org sweep takes up to ~20 min on slow days; the extractor keeps its
  // job for 30 min, so watch for 25. Each poll goes through the edge function,
  // which is what actually advances the job (it checks the extractor's status).
  const pollJobUntilComplete = async (jobId: string, cookieToUse: string) => {
    const pollStartedAt = Date.now();
    while (Date.now() - pollStartedAt < 1_500_000) {
      await new Promise((r) => setTimeout(r, 5000));
      const job = await pollFetchJob(jobId);
      if (!job) continue;

      if (job.status === "running") {
        setLiveProgress(getJobProgress(job));
        continue;
      }

      if (job.status === "failed") {
        const failureMessage = describeFetchFailure(job.error_message);
        setFetchError(failureMessage);
        setCookie(cookieToUse);
        setOpen(true);
        if ((job.error_message ?? "").includes("401")) {
          clearStoredAshbyCookie();
          toast.error("Ashby session expired. Paste a fresh cookie.");
        } else {
          toast.error(failureMessage);
        }
        return;
      }

      await applyFetchResult({
        cookie: cookieToUse,
        data: job.result_payload,
        userId: user?.id,
        complete,
        onMergeFetch,
        closeDialog: () => setOpen(false),
        clearInput: () => setCookie(""),
      });
      return;
    }

    setFetchError("Ashby sync is still running in the background. Leave your signed-in Ashby tab alone, then click Sync from Ashby again in a minute to resume watching it.");
    setOpen(true);
    toast.message("Ashby sync is still running in the background.", {
      description: "Click Sync from Ashby again to resume watching progress.",
    });
  };

  const runFetch = async (cookieToUse: string) => {
    setFetchError(null);
    setLoading(true);
    try {
      setStoredAshbyCookie(cookieToUse);
      const { data, error } = await supabase.functions.invoke("ashby-sync", {
        body: { cookie: cookieToUse },
      });
      if (error) {
        // invoke() hides the response body on non-2xx; surface the real
        // message (e.g. "Ashby session expired (401)") instead of the generic
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
      await pollJobUntilComplete(jobId, cookieToUse);
    } catch (err) {
      console.error("Ashby fetch error:", err);
      const message =
        err instanceof TypeError
          ? `Could not reach Ashby automation at ${ASHBY_AUTOMATION_API_BASE}.`
          : err instanceof Error && err.message
            ? err.message
            : "Failed to fetch from Ashby.";
      const failureMessage = describeFetchFailure(message);
      setFetchError(failureMessage);
      setCookie(cookieToUse);
      setOpen(true);
      toast.error(failureMessage);
    } finally {
      setLoading(false);
      setLiveProgress(null);
    }
  };

  const handleClick = () => {
    const stored = getStoredAshbyCookie();
    if (stored) {
      void (async () => {
        // Re-attach to a sweep that's still running (e.g. after a page reload)
        // instead of starting a second one.
        const runningJob = user ? await getLatestRunningJob(user.id) : null;
        const isFresh =
          runningJob &&
          Date.now() - new Date(runningJob.started_at).getTime() < 30 * 60_000;
        if (runningJob && isFresh) {
          setLoading(true);
          try {
            await pollJobUntilComplete(runningJob.id, stored);
          } finally {
            setLoading(false);
            setLiveProgress(null);
          }
          return;
        }
        await runFetch(stored);
      })();
    } else {
      setOpen(true);
    }
  };


  const handleDialogSubmit = () => {
    const cleaned = normalizeTokenInput(cookie);
    if (!cleaned) {
      toast.error("Please paste your Ashby session cookie");
      return;
    }
    const v = validateToken(cleaned);
    if (!v.valid) {
      toast.error(v.hint ?? "Token doesn't look right");
      return;
    }
    setCookie(cleaned);
    setFetchError(null);
    void runFetch(cleaned);
  };

  const handlePaste = (raw: string) => {
    const cleaned = normalizeTokenInput(raw);
    setCookie(cleaned);
  };



  const hasStoredCookie = !!getStoredAshbyCookie();

  return (
    <>
      <Button
        variant="outline"
        className="gap-2"
        onClick={handleClick}
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : hasStoredCookie ? (
          <RefreshCw className="h-4 w-4" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        {loading
          ? liveProgress
            ? `Syncing ${liveProgress.completed}/${liveProgress.total} orgs...`
            : "Syncing..."
          : hasStoredCookie
            ? "Sync from Ashby"
            : "Connect Ashby"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Connect your Ashby account</DialogTitle>
            <DialogDescription>
              We need your Ashby session token to pull candidates. Follow the steps
              below — it takes about a minute. Watch the walkthrough if you get stuck.
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
                disabled={loading}
              />
              {cookie && validation.valid && (
                <Check className="absolute right-2 top-2 h-4 w-4 text-emerald-600" />
              )}
            </div>
            {cookie && !validation.valid && validation.hint && (
              <p className="text-xs text-destructive">{validation.hint}</p>
            )}
            {cookie && validation.valid && (
              <p className="text-xs text-emerald-600">Looks good — ready to fetch.</p>
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
                Ashby has no per-user API key for external recruiters, so we use your session token to act on your behalf — only when you click Sync.
              </p>
              <p>
                The token is stored in your browser's localStorage and is sent only to our extraction service to fetch your candidates. We don't share it, log it, or use it for anything else.
              </p>
            </CollapsibleContent>
          </Collapsible>

          {fetchError && !loading && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-foreground">
              <p className="font-medium text-destructive">Fetch didn’t complete.</p>
              <p className="mt-1 text-muted-foreground">{fetchError}</p>
            </div>
          )}

          {loading && (
            <div className="space-y-3 py-1">
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <div className="space-y-0.5">
                  <p className="font-medium">Heads up: Ashby may sign you out in another tab.</p>
                  <p className="text-muted-foreground">
                    That's expected — your token is in use server-side. Don't re-sign in until this finishes,
                    or the running session will be invalidated and orgs may be dropped.
                  </p>
                </div>
              </div>
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
              disabled={loading || !validation.valid}
              className="gap-2"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {loading ? "Fetching..." : "Fetch Candidates"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
