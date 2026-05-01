import { useState } from "react";
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

  const handleSync = async () => {
    setBusy(true);
    const t = toast.loading("Syncing from Slack…");
    try {
      const { data, error } = await supabase.functions.invoke("slack-sync", { body: {} });
      if (error || data?.error) {
        toast.error(`Slack sync failed: ${error?.message || data?.error}`, { id: t });
        return;
      }
      const s = data as {
        channels_scanned?: number;
        submissions_saved?: number;
        missing_name_count?: number;
      };
      const missing =
        s.missing_name_count && s.missing_name_count > 0
          ? ` (${s.missing_name_count} need review)`
          : "";
      toast.success(
        `Synced ${s.submissions_saved ?? 0} submissions from ${s.channels_scanned ?? 0} channels${missing}`,
        { id: t },
      );
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
      <Button variant="outline" className="gap-2" onClick={handleSync} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Sync Slack{teamName ? ` (${teamName})` : ""}
      </Button>
      <Button variant="ghost" size="sm" onClick={handleDisconnect} disabled={busy} title="Disconnect Slack">
        Disconnect
      </Button>
    </div>
  );
}
