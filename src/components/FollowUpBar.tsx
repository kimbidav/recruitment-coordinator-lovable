import { useState } from "react";
import { X, Send, Loader2, ChevronUp, ChevronDown, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Candidate } from "@/data/candidates";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Port of the desktop app's FollowUpBar: select rows in the pipeline table,
// group them by Slack channel, and send one "quick status check" message per
// channel (top-level post, not a thread reply). Rows without a Slack channel
// group under their company name and can't be sent — they still count toward
// the selection so batch-close covers them when possible.

interface FollowUpBarProps {
  selected: Candidate[];
  onClear: () => void;
  onDeselectChannel: (channelId: string) => void;
  /** Close one candidate (⛔ in Slack + local close). Returns success. */
  onCloseCandidate?: (candidate: Candidate) => Promise<boolean>;
}

function groupByChannel(candidates: Candidate[]) {
  const grouped: Record<string, { channelId: string; channelName: string; candidates: Candidate[] }> = {};
  for (const c of candidates) {
    const key = c.slack_meta?.channel_id || c.company_name;
    const name = c.company_name;
    if (!grouped[key]) {
      grouped[key] = { channelId: c.slack_meta?.channel_id || "", channelName: name, candidates: [] };
    }
    grouped[key].candidates.push(c);
  }
  return Object.values(grouped).sort((a, b) => a.channelName.localeCompare(b.channelName));
}

function buildMessage(candidates: Candidate[]): string {
  const lines = ["Quick status check on candidates currently in process:"];
  [...candidates]
    .sort((a, b) => a.candidate_name.localeCompare(b.candidate_name))
    .forEach((c) => {
      const days = c.days_in_stage || "";
      lines.push(`– ${c.candidate_name}${days ? ` (${days} days)` : ""}`);
    });
  lines.push("");
  lines.push("Any updates on where things stand with each? Appreciate it!");
  return lines.join("\n");
}

export function FollowUpBar({ selected, onClear, onDeselectChannel, onCloseCandidate }: FollowUpBarProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [closingAll, setClosingAll] = useState(false);

  const closeable = selected.filter((c) => c.slack_meta?.channel_id && c.slack_meta?.message_ts);

  const handleCloseAll = async () => {
    if (!onCloseCandidate || closeable.length === 0) return;
    const confirmed = window.confirm(
      `Add ⛔ to ${closeable.length} Slack submission${closeable.length === 1 ? "" : "s"}?\n\n` +
        closeable
          .slice(0, 12)
          .map((c) => `• ${c.candidate_name} at ${c.company_name}`)
          .join("\n") +
        (closeable.length > 12 ? `\n…and ${closeable.length - 12} more` : ""),
    );
    if (!confirmed) return;
    setClosingAll(true);
    let ok = 0;
    let fail = 0;
    try {
      for (const c of closeable) {
        const success = await onCloseCandidate(c);
        if (success) ok++;
        else fail++;
      }
      if (fail === 0) {
        toast.success(`⛔ Closed ${ok} submission${ok === 1 ? "" : "s"}`);
      } else {
        toast.message(`⛔ Closed ${ok}, ${fail} failed — check toasts above`);
      }
      onClear();
    } finally {
      setClosingAll(false);
    }
  };

  if (selected.length === 0) return null;

  const groups = groupByChannel(selected);

  const handlePreview = () => {
    const newDrafts: Record<string, string> = {};
    for (const group of groups) {
      newDrafts[group.channelId] = drafts[group.channelId] || buildMessage(group.candidates);
    }
    setDrafts({ ...drafts, ...newDrafts });
    setShowPreview(true);
  };

  const handleSend = async (channelId: string) => {
    const message = drafts[channelId];
    if (!message || !channelId) return;

    setSending((prev) => ({ ...prev, [channelId]: true }));
    try {
      const { data, error } = await supabase.functions.invoke("slack-thread", {
        body: { action: "post", channel_id: channelId, text: message },
      });
      if (error) {
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === "function") {
          const body = await ctx.json().catch(() => null);
          if (body?.error) throw new Error(body.error);
        }
        throw error;
      }
      if (data?.error) throw new Error(data.error);
      setSent((prev) => ({ ...prev, [channelId]: true }));
      toast.success(`Sent to #${groups.find((g) => g.channelId === channelId)?.channelName}`);
      onDeselectChannel(channelId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send follow-up";
      toast.error(msg);
    } finally {
      setSending((prev) => ({ ...prev, [channelId]: false }));
    }
  };

  const handleSendAll = async () => {
    for (const group of groups) {
      if (!sent[group.channelId] && group.channelId) {
        await handleSend(group.channelId);
      }
    }
  };

  return (
    <>
      {/* Sticky bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border shadow-lg z-40 px-6 py-3">
        <div className="container flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-foreground">
              {selected.length} candidate{selected.length !== 1 ? "s" : ""} selected
            </span>
            <Button variant="ghost" size="sm" onClick={onClear} className="gap-1 text-muted-foreground">
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {onCloseCandidate && closeable.length > 0 && (
              <Button
                variant="outline"
                onClick={handleCloseAll}
                disabled={closingAll}
                className="gap-2"
                title={`Add ⛔ to all ${closeable.length} selected Slack submissions`}
              >
                {closingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                Close {closeable.length}
              </Button>
            )}
            <Button onClick={handlePreview} className="gap-2">
              {showPreview ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              {showPreview ? "Hide Preview" : "Preview Follow-up"}
            </Button>
          </div>
        </div>
      </div>

      {/* Follow-up preview panel */}
      {showPreview && (
        <div className="fixed bottom-14 left-0 right-0 bg-card border-t border-border shadow-2xl z-30 max-h-[60vh] overflow-y-auto">
          <div className="container py-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Follow-up Messages</h3>
              {groups.filter((g) => g.channelId && !sent[g.channelId]).length > 1 && (
                <Button onClick={handleSendAll} className="gap-2 bg-green-600 hover:bg-green-700">
                  <Send className="h-4 w-4" />
                  Send All
                </Button>
              )}
            </div>

            {groups.map((group) => (
              <div key={group.channelId || group.channelName} className="bg-muted/50 rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-sm">
                    #{group.channelName}{" "}
                    <span className="font-normal text-muted-foreground">
                      ({group.candidates.length} candidate{group.candidates.length !== 1 ? "s" : ""})
                    </span>
                  </h4>
                  {sent[group.channelId] ? (
                    <span className="text-sm text-green-600 font-medium">Sent!</span>
                  ) : group.channelId ? (
                    <Button
                      size="sm"
                      onClick={() => handleSend(group.channelId)}
                      disabled={sending[group.channelId]}
                      className="gap-1.5"
                    >
                      {sending[group.channelId] ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                      Send to #{group.channelName}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">No Slack channel — can't send</span>
                  )}
                </div>
                <Textarea
                  value={drafts[group.channelId] || buildMessage(group.candidates)}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [group.channelId]: e.target.value }))}
                  rows={Math.min(group.candidates.length + 4, 10)}
                  className="text-sm"
                  disabled={sent[group.channelId]}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Spacer so content isn't hidden behind the bar */}
      <div className="h-14" />
    </>
  );
}
