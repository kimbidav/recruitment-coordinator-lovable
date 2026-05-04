import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Sparkles, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAgentCards, visibleCards, fetchDrafts, type AgentCard } from "@/hooks/useAgentCards";
import { AgentActionCard } from "./AgentActionCard";
import { SlackThreadPanel } from "./SlackThreadPanel";
import { EmailComposer } from "./EmailComposer";
import { AgentScanDiagnostics } from "./AgentScanDiagnostics";

export function AgentTab() {
  const {
    cards, loading, scanning, lastScanAt, lastRunId, gmailScopeMissing,
    runScan, updateStatus, reload,
  } = useAgentCards();
  const [slackFor, setSlackFor] = useState<AgentCard | null>(null);
  const [emailFor, setEmailFor] = useState<AgentCard | null>(null);
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const open = useMemo(() => visibleCards(cards), [cards]);
  const stalls = open.filter((c) => c.kind === "intro_stall");
  const followups = open.filter((c) => c.kind === "post_interview_followup");

  const handleScan = async () => {
    try {
      const data = await runScan();
      toast.success(
        `Scan complete · ${data?.cards_created ?? 0} new, ${data?.cards_resolved ?? 0} resolved (${data?.processed ?? 0} candidates checked)`,
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

  const ensureDrafts = async (c: AgentCard): Promise<AgentCard> => {
    if (c.payload.suggested_slack_message && c.payload.suggested_email_body) return c;
    setDraftingId(c.id);
    try {
      const drafts = await fetchDrafts(c.id);
      const updated: AgentCard = {
        ...c,
        payload: {
          ...c.payload,
          suggested_slack_message: drafts.slack_message,
          suggested_email_subject: drafts.email_subject,
          suggested_email_body: drafts.email_body,
        },
      };
      await reload();
      return updated;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't draft suggestion");
      return c;
    } finally {
      setDraftingId(null);
    }
  };

  const handleReplySlack = async (c: AgentCard) => {
    const ready = await ensureDrafts(c);
    setSlackFor(ready);
  };
  const handleEmail = async (c: AgentCard) => {
    const ready = await ensureDrafts(c);
    setEmailFor(ready);
  };

  const handleReconnectGoogle = async () => {
    setReconnecting(true);
    try {
      const redirectUri = `${window.location.origin}/google-calendar/callback`;
      const { data, error } = await supabase.functions.invoke("google-calendar-connect", {
        body: { redirect_uri: redirectUri },
      });
      if (error || !data?.url) {
        toast.error(`Couldn't start Google reconnect: ${error?.message || "no url"}`);
        return;
      }
      window.location.href = data.url;
    } finally {
      setReconnecting(false);
    }
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

      {gmailScopeMissing && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-start gap-3">
          <AlertCircle className="h-4 w-4 text-foreground mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">Gmail signals are off</p>
            <p className="text-xs text-muted-foreground">
              Reconnect Google to grant Gmail access — without it, the agent can't see scheduling
              confirmations sent over email.
            </p>
          </div>
          <Button size="sm" variant="outline" disabled={reconnecting} onClick={handleReconnectGoogle}>
            {reconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Reconnect Google"}
          </Button>
        </div>
      )}

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
                    drafting={draftingId === c.id}
                    onReplySlack={handleReplySlack}
                    onEmail={handleEmail}
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
                    drafting={draftingId === c.id}
                    onReplySlack={handleReplySlack}
                    onEmail={handleEmail}
                    onSnooze={handleSnooze}
                    onDismiss={handleDismiss}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <AgentScanDiagnostics runId={lastRunId} />

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
