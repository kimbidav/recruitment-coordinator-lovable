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

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 401) {
          toast.error("Session expired. Please paste a fresh cookie from Ashby.");
        } else {
          toast.error(data.error || `API returned ${res.status}`);
        }
        return;
      }

      const candidates: Candidate[] = data.candidates ?? (Array.isArray(data) ? data : []);

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
