import { useState } from "react";
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
import { Candidate } from "@/data/candidates";
import { toast } from "sonner";

interface AshbyFetchButtonProps {
  onUpload: (candidates: Candidate[]) => void;
}

export function AshbyFetchButton({ onUpload }: AshbyFetchButtonProps) {
  const [open, setOpen] = useState(false);
  const [cookie, setCookie] = useState("");
  const [loading, setLoading] = useState(false);

  const handleFetch = async () => {
    const trimmed = cookie.trim();
    if (!trimmed) {
      toast.error("Please paste your Ashby session cookie");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(
        "https://ashby-automation-production.up.railway.app/api/extract",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cookie: trimmed }),
        }
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || `API returned ${res.status}`);
        return;
      }

      const data = await res.json();

      // The API should return an array of candidate objects
      const candidates: Candidate[] = (Array.isArray(data) ? data : data.candidates ?? []).map(
        (row: Record<string, unknown>): Candidate => ({
          company_name: String(row.company_name ?? ""),
          job_title: String(row.job_title ?? ""),
          job_id: String(row.job_id ?? ""),
          candidate_name: String(row.candidate_name ?? ""),
          candidate_id: String(row.candidate_id ?? ""),
          pipeline_stage: String(row.pipeline_stage ?? ""),
          decision_status: String(row.decision_status ?? ""),
          stage_type: String(row.stage_type ?? ""),
          current_stage_index: Number(row.current_stage_index) || 0,
          total_stages: Number(row.total_stages) || 0,
          stage_progress: String(row.stage_progress ?? ""),
          last_activity_at: String(row.last_activity_at ?? ""),
          days_in_stage: Number(row.days_in_stage) || 0,
          needs_scheduling: row.needs_scheduling === true || String(row.needs_scheduling).toLowerCase() === "true",
          credited_to: String(row.credited_to ?? ""),
          source: String(row.source ?? ""),
          feedback_count: Number(row.feedback_count) || 0,
          latest_recommendation: row.latest_recommendation != null ? Number(row.latest_recommendation) : undefined,
          latest_feedback_author: row.latest_feedback_author ? String(row.latest_feedback_author) : undefined,
          latest_feedback_date: row.latest_feedback_date ? String(row.latest_feedback_date) : undefined,
          current_stage_interviews: row.current_stage_interviews ? String(row.current_stage_interviews) : undefined,
          current_stage_avg_score: row.current_stage_avg_score != null ? Number(row.current_stage_avg_score) : undefined,
          current_stage_date: row.current_stage_date ? String(row.current_stage_date) : undefined,
          interview_history_summary: row.interview_history_summary ? String(row.interview_history_summary) : undefined,
          interview_events: Array.isArray(row.interview_events) ? row.interview_events as Array<{ id: string; interview_title: string; start_time: string; end_time: string }> : [],
        })
      );

      if (candidates.length === 0) {
        toast.error("No candidates returned from Ashby");
        return;
      }

      onUpload(candidates);
      toast.success(`Loaded ${candidates.length} candidates from Ashby`);
      setOpen(false);
      setCookie("");
    } catch (err) {
      console.error("Ashby fetch error:", err);
      toast.error("Failed to fetch from Ashby. Check your cookie and try again.");
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
        />
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
