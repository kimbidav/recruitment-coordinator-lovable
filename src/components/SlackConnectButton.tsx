import { useEffect, useState } from "react";
import { Hash, Loader2, RefreshCw, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useSlackSubmissions } from "@/hooks/useSlackSubmissions";

interface SlackConnectButtonProps {
  onSynced?: () => void;
}

export function SlackConnectButton({ onSynced }: SlackConnectButtonProps) {
  const { connected, teamName, reload } = useSlackSubmissions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "slack-connected") {
        toast.success("Slack connected");
        void reload();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [reload]);

  const handleConnect = async () => {
    setBusy(true);
    try {
      const redirectUri = `${window.location.origin}/slack/callback`;
      const { data, error } = await supabase.functions.invoke("slack-connect", {
        body: { redirect_uri: redirectUri },
      });
      if (error || !data?.url) {
        toast.error(`Failed to start Slack auth: ${error?.message || data?.error || "no url"}`);
        return;
      }
      // Open in a new tab — Slack's OAuth page refuses to load inside iframes (e.g. Lovable preview)
      const w = window.open(data.url, "_blank", "noopener,noreferrer");
      if (!w) {
        toast.error("Popup blocked. Allow popups for this site, or open the preview in a new tab.");
        return;
      }
      setOpen(false);
      toast.info("Complete Slack authorization in the new tab, then return here.");
    } finally {
      setBusy(false);
    }
  };

  // Incremental by default (one search for your new posts + one thread read
  // per open submission). Shift-click forces the full weekly rescan.
  const handleSync = async (full = false) => {
    setBusy(true);
    const t = toast.loading(full ? "Full Slack rescan…" : "Syncing from Slack…");
    try {
      const { data, error } = await supabase.functions.invoke("slack-sync", { body: full ? { full: true } : {} });
      if (error || data?.error) {
        toast.error(`Slack sync failed: ${error?.message || data?.error}`, { id: t });
        return;
      }
      const s = data as {
        mode?: string;
        channels_scanned?: number;
        submissions_saved?: number;
        new_submissions?: number;
        threads_refreshed?: number;
        migrated_threads?: number;
        renamed?: number;
        partial?: boolean;
        remaining?: number;
        channels_remaining?: string[];
      };
      const extras = [
        s.migrated_threads ? `${s.migrated_threads} migrated thread${s.migrated_threads === 1 ? "" : "s"} merged` : "",
        s.renamed ? `${s.renamed} row${s.renamed === 1 ? "" : "s"} relabelled after a channel rename` : "",
      ].filter(Boolean);
      const summary = `${s.new_submissions ?? 0} new, ${s.threads_refreshed ?? 0} threads refreshed across ${s.channels_scanned ?? 0} channels${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
      if (s.partial) {
        toast.warning(
          `${summary}. Slack's rate limits stopped the scan early (${s.remaining ?? s.channels_remaining?.length ?? 0} left). Run Sync again — it picks up where it left off.`,
          { id: t, duration: 12000 },
        );
      } else {
        toast.success(`${s.mode === "full" ? "Full rescan" : "Synced"}: ${summary}`, { id: t });
      }
      await reload();
      onSynced?.();
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect Slack? Your stored submissions will also be deleted.")) return;
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user?.id;
      if (!uid) return;
      await supabase.from("slack_submissions").delete().eq("user_id", uid);
      await supabase.from("slack_channel_mappings").delete().eq("user_id", uid);
      await supabase.from("slack_tokens").delete().eq("user_id", uid);
      toast.success("Slack disconnected");
      await reload();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (connected === null) {
    return null;
  }

  if (!connected) {
    return (
      <>
        <Button variant="outline" className="gap-2" onClick={() => setOpen(true)} disabled={busy}>
          <Plug className="h-4 w-4" />
          Connect Slack
        </Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Connect your Slack account</DialogTitle>
              <DialogDescription>
                We'll read messages <strong>you</strong> posted in CandidateLabs client channels and
                pull them into your dashboard.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>What we read:</p>
              <ul className="list-disc list-outside ml-5 space-y-1">
                <li>External / shared channels you're already a member of</li>
                <li>Only the parent messages <em>you</em> authored</li>
                <li>Reactions on those messages (to detect ✅ / 🚫 status)</li>
              </ul>
              <p>Other people's submissions are ignored. You can disconnect anytime.</p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={handleConnect} disabled={busy} className="gap-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Hash className="h-4 w-4" />}
                Continue with Slack
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" className="gap-2" onClick={(e) => void handleSync(e.shiftKey)}
          title="Sync new submissions and refresh open threads. Shift-click for a full rescan." disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Sync Slack{teamName ? ` (${teamName})` : ""}
      </Button>
      <Button variant="ghost" size="sm" onClick={handleDisconnect} disabled={busy} title="Disconnect Slack">
        Disconnect
      </Button>
    </div>
  );
}
