import { useState, useEffect, useRef } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Candidate } from "@/data/candidates";
import { ASHBY_AUTOMATION_API_BASE, readErrorPayload } from "@/lib/ashbyAutomation";
import { toast } from "sonner";

const PROGRESS_STEPS = [
  { at: 0, label: "Connecting to Ashby..." },
  { at: 5, label: "Authenticating session..." },
  { at: 10, label: "Discovering organizations..." },
  { at: 20, label: "Fetching open jobs..." },
  { at: 35, label: "Loading active candidates..." },
  { at: 50, label: "Preparing pipeline..." },
  { at: 65, label: "Finalizing results..." },
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

      // Find the matching step label
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

function parseAshbyResponse(data: any): Candidate[] {
  return data.candidates ?? (Array.isArray(data) ? data : []);
}

interface ExtractJobResponse {
  job_id: string;
  status: "running" | "done" | "error";
  stage: "queued" | "discovering" | "basic" | "enriching" | "done" | "error";
  basic_result?: { candidates?: Candidate[] };
  result?: { candidates?: Candidate[] };
  error?: string;
}

export function AshbyFetchButton({ onUpload }: AshbyFetchButtonProps) {
  const [open, setOpen] = useState(false);
  const [cookie, setCookie] = useState("");
  const [loading, setLoading] = useState(false);
  const { progress, label, complete } = useSimulatedProgress(loading);

  const handleFetch = async () => {
    const trimmed = cookie.trim();
    if (!trimmed) {
      toast.error("Please paste your Ashby session cookie");
      return;
    }

    setLoading(true);
    try {
      const startRes = await fetch(`${ASHBY_AUTOMATION_API_BASE}/api/extract/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: trimmed }),
      });

      if (!startRes.ok) {
        if (startRes.status === 401) {
          toast.error("Session expired. Please paste a fresh cookie from Ashby.");
        } else {
          toast.error(await readErrorPayload(startRes));
        }
        return;
      }

      const startData: ExtractJobResponse = await startRes.json();
      const jobId = startData.job_id;

      let uploadedBasic = false;
      let uploadedFinal = false;
      let pollAttempts = 0;

      while (pollAttempts < 180) {
        await new Promise((r) => setTimeout(r, 1000));
        pollAttempts += 1;

        const jobRes = await fetch(`${ASHBY_AUTOMATION_API_BASE}/api/extract/jobs/${jobId}`);
        if (!jobRes.ok) {
          toast.error(await readErrorPayload(jobRes));
          return;
        }

        const job: ExtractJobResponse = await jobRes.json();

        if (!uploadedBasic && job.basic_result) {
          const basicCandidates = parseAshbyResponse(job.basic_result);
          if (basicCandidates.length > 0) {
            complete();
            await new Promise((r) => setTimeout(r, 300));
            onUpload(basicCandidates);
            toast.success(`Loaded ${basicCandidates.length} candidates from Ashby`);
            toast.message("Pulling interview feedback and stage dates in the background...");
            setOpen(false);
            uploadedBasic = true;
          }
        }

        if (job.status === "done" && job.result) {
          const enrichedCandidates = parseAshbyResponse(job.result);
          if (enrichedCandidates.length > 0 && !uploadedFinal) {
            onUpload(enrichedCandidates);
            toast.success("Ashby enrichment complete: feedback and interview dates loaded.");
            uploadedFinal = true;
          } else if (!uploadedBasic) {
            toast.error("No candidates returned from Ashby");
          }
          setCookie("");
          return;
        }

        if (job.status === "error") {
          toast.error(job.error || "Ashby extraction failed.");
          return;
        }
      }

      toast.error("Ashby extraction timed out before enrichment completed.");
    } catch (err: any) {
      console.error("Ashby fetch error:", err);
      const message =
        err instanceof TypeError
          ? `Could not reach Ashby automation at ${ASHBY_AUTOMATION_API_BASE}. The deployed extractor may be down or not redeployed.`
          : "Failed to fetch from Ashby.";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Download className="h-4 w-4" />
          Fetch from Ashby
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fetch from Ashby</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3">
              <p>Follow these steps to get your session token:</p>
              <p className="text-[11px] text-muted-foreground">
                API: <code className="rounded bg-muted px-1 py-0.5 font-mono">{ASHBY_AUTOMATION_API_BASE}</code>
              </p>
              <ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
                <li>Open <span className="font-medium text-foreground">app.ashbyhq.com</span> in Chrome and sign in</li>
                <li>Open DevTools (<kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">⌘⌥I</kbd>) → <span className="font-medium text-foreground">Application</span> → <span className="font-medium text-foreground">Cookies</span> → <span className="font-medium text-foreground">app.ashbyhq.com</span></li>
                <li>Copy the value of the <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">ashby_session_token</code> cookie</li>
                <li>Paste it below and click <span className="font-medium text-foreground">Fetch Candidates</span></li>
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
          <div className="space-y-2 py-1">
            <Progress value={progress} className="h-2" />
            <p className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              {label}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button onClick={handleFetch} disabled={loading} className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {loading ? "Fetching..." : "Fetch Candidates"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
