import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useAgentCards, visibleCards, type AgentCard } from "@/hooks/useAgentCards";
import { AgentActionCard } from "./AgentActionCard";
import { SlackThreadPanel } from "./SlackThreadPanel";
import { EmailComposer } from "./EmailComposer";

export function AgentTab() {
  const { cards, loading, scanning, lastScanAt, runScan, updateStatus } = useAgentCards();
  const [slackFor, setSlackFor] = useState<AgentCard | null>(null);
  const [emailFor, setEmailFor] = useState<AgentCard | null>(null);

  const open = useMemo(() => visibleCards(cards), [cards]);
  const stalls = open.filter((c) => c.kind === "intro_stall");
  const followups = open.filter((c) => c.kind === "post_interview_followup");

  const handleScan = async () => {
    try {
      const data = await runScan();
      toast.success(
        `Scan complete · ${data?.cards_created ?? 0} new, ${data?.cards_resolved ?? 0} resolved`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scan failed");
    }
  };

  const handleSnooze = async (c: AgentCard) => {
    const until = new Date(Date.now() + 3 * 86400000).toISOString();
    await updateStatus(c.id, "snoozed", until);
    toast.success("Snoozed for 3 days");
  };
  const handleDismiss = async (c: AgentCard) => {
    await updateStatus(c.id, "dismissed");
    toast.success("Dismissed");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Action items
          </h2>
          <p className="text-sm text-muted-foreground">
            {lastScanAt
              ? `Last scan ${formatDistanceToNow(new Date(lastScanAt), { addSuffix: true })}`
              : "No scans yet — run one to surface follow-ups."}
          </p>
        </div>
        <Button onClick={handleScan} disabled={scanning} className="gap-2">
          {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {scanning ? "Scanning..." : "Run scan"}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading...
        </div>
      ) : open.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-10 text-center">
          <p className="text-foreground font-medium mb-1">All caught up</p>
          <p className="text-sm text-muted-foreground">
            No follow-ups need your attention right now.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {stalls.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Intro stalls ({stalls.length})
              </h3>
              <div className="grid gap-3 md:grid-cols-2">
                {stalls.map((c) => (
                  <AgentActionCard
                    key={c.id}
                    card={c}
                    onReplySlack={setSlackFor}
                    onEmail={setEmailFor}
                    onSnooze={handleSnooze}
                    onDismiss={handleDismiss}
                  />
                ))}
              </div>
            </section>
          )}
          {followups.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Post-interview follow-ups ({followups.length})
              </h3>
              <div className="grid gap-3 md:grid-cols-2">
                {followups.map((c) => (
                  <AgentActionCard
                    key={c.id}
                    card={c}
                    onReplySlack={setSlackFor}
                    onEmail={setEmailFor}
                    onSnooze={handleSnooze}
                    onDismiss={handleDismiss}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <SlackThreadPanel
        open={!!slackFor}
        onOpenChange={(o) => !o && setSlackFor(null)}
        channelId={slackFor?.payload.channel_id ?? null}
        messageTs={slackFor?.payload.message_ts ?? null}
        candidateName={slackFor?.payload.candidate_name ?? ""}
        companyName={slackFor?.payload.company_name ?? ""}
        initialReply={slackFor?.payload.suggested_slack_message ?? ""}
      />

      <EmailComposer
        open={!!emailFor}
        onOpenChange={(o) => !o && setEmailFor(null)}
        candidateName={emailFor?.payload.candidate_name ?? ""}
        opportunities={[]}
        initialTo={emailFor?.payload.candidate_email ?? ""}
        initialSubject={emailFor?.payload.suggested_email_subject}
        initialBody={emailFor?.payload.suggested_email_body}
      />
    </div>
  );
}

export function useAgentOpenCount(): number {
  const { cards } = useAgentCards();
  return useMemo(() => visibleCards(cards).length, [cards]);
}
