import { useState, useEffect, useRef } from "react";
import { Download, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Candidate } from "@/data/candidates";
import { ASHBY_AUTOMATION_API_BASE, readErrorPayload } from "@/lib/ashbyAutomation";
import {
  getStoredAshbyCookie,
  setStoredAshbyCookie,
  clearStoredAshbyCookie,
} from "@/lib/ashbyCookie";
import { createFetchJob, updateFetchJob, getLatestRunningJob } from "@/lib/fetchJobs";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

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
  onUpload: (candidates: Candidate[]) => void;
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

export function AshbyFetchButton({ onUpload }: AshbyFetchButtonProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [cookie, setCookie] = useState("");
  const [loading, setLoading] = useState(false);
  const [staleJobNotified, setStaleJobNotified] = useState(false);
  const { progress, label, complete } = useSimulatedProgress(loading);

  // On mount: warn if a previous fetch is still marked running (likely stalled).
  useEffect(() => {
    if (!user || staleJobNotified) return;
    void (async () => {
      const job = await getLatestRunningJob(user.id);
      if (!job) return;
      const ageMin = (Date.now() - new Date(job.started_at).getTime()) / 60_000;
      if (ageMin > 10) {
        toast.warning(
          `A previous Ashby fetch from ${ageMin.toFixed(0)} min ago is still marked running. It may have stalled — re-run when ready.`,
          { duration: 12000 },
        );
        setStaleJobNotified(true);
      }
    })();
  }, [user, staleJobNotified]);

  const runFetch = async (cookieToUse: string) => {
    setLoading(true);
    const job = user ? await createFetchJob(user.id) : null;
    try {
      const res = await fetch(`${ASHBY_AUTOMATION_API_BASE}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: cookieToUse, force: true }),
      });

      if (res.status === 401) {
        clearStoredAshbyCookie();
        setOpen(true);
        toast.error("Ashby session expired. Paste a fresh cookie.");
        if (job) await updateFetchJob(job.id, {
          status: "failed",
          finished_at: new Date().toISOString(),
          error_message: "Ashby session expired (401)",
        });
        return;
      }

      if (!res.ok) {
        const msg = await readErrorPayload(res);
        toast.error(msg);
        if (job) await updateFetchJob(job.id, {
          status: "failed",
          finished_at: new Date().toISOString(),
          error_message: msg.slice(0, 500),
        });
        return;
      }

      const data = await res.json();
      const { candidates, stats } = parseAshbyResponse(data);

      if (candidates.length === 0) {
        toast.error("No candidates returned from Ashby");
        if (job) await updateFetchJob(job.id, {
          status: "failed",
          finished_at: new Date().toISOString(),
          error_message: "No candidates returned",
          orgs_total: stats.orgs_total ?? null,
          orgs_fetched: stats.orgs_fetched ?? null,
          orgs_failed: stats.orgs_failed ?? null,
        });
        return;
      }

      complete();
      await new Promise((r) => setTimeout(r, 400));
      setStoredAshbyCookie(cookieToUse);
      onUpload(candidates);

      // Surface upstream coverage so silent drops are visible.
      const orgsTotal = stats.orgs_total;
      const orgsFetched = stats.orgs_fetched;
      const orgsFailed = stats.orgs_failed ?? 0;
      const partial = !!(orgsTotal && orgsFetched !== undefined && orgsFailed > 0);

      if (partial) {
        toast.warning(
          `Loaded ${candidates.length} candidates from ${orgsFetched}/${orgsTotal} orgs — ${orgsFailed} org(s) failed. Re-run with a fresh cookie to recover missing data.`,
          { duration: 15000 },
        );
      } else if (orgsTotal && orgsFetched !== undefined) {
        toast.success(
          `Loaded ${candidates.length} candidates from ${orgsFetched}/${orgsTotal} orgs`,
        );
      } else {
        toast.success(`Loaded ${candidates.length} candidates from Ashby`);
      }

      if (job) await updateFetchJob(job.id, {
        status: partial ? "partial" : "succeeded",
        finished_at: new Date().toISOString(),
        orgs_total: orgsTotal ?? null,
        orgs_fetched: orgsFetched ?? null,
        orgs_failed: orgsFailed,
        candidate_count: candidates.length,
      });

      setOpen(false);
      setCookie("");
    } catch (err) {
      console.error("Ashby fetch error:", err);
      const message =
        err instanceof TypeError
          ? `Could not reach Ashby automation at ${ASHBY_AUTOMATION_API_BASE}.`
          : "Failed to fetch from Ashby.";
      toast.error(message);
      if (job) await updateFetchJob(job.id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: message,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleClick = () => {
    const stored = getStoredAshbyCookie();
    if (stored) {
      void runFetch(stored);
    } else {
      setOpen(true);
    }
  };

  const handleDialogSubmit = () => {
    const trimmed = cookie.trim();
    if (!trimmed) {
      toast.error("Please paste your Ashby session cookie");
      return;
    }
    void runFetch(trimmed);
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
        {loading ? "Syncing..." : hasStoredCookie ? "Sync from Ashby" : "Connect Ashby"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Paste your Ashby session cookie</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  We'll remember this in your browser and only ask again if it
                  expires.
                </p>
                <ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
                  <li>
                    Open <span className="font-medium text-foreground">app.ashbyhq.com</span> and sign in
                  </li>
                  <li>
                    DevTools (<kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">⌘⌥I</kbd>) → Application → Cookies → app.ashbyhq.com
                  </li>
                  <li>
                    Copy the value of <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">ashby_session_token</code>
                  </li>
                </ol>
              </div>
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Paste your ashby_session_token value here..."
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            rows={3}
            className="font-mono text-xs"
            disabled={loading}
          />
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
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                {label}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button onClick={handleDialogSubmit} disabled={loading} className="gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {loading ? "Fetching..." : "Fetch Candidates"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
