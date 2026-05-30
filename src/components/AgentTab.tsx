import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Sparkles, AlertCircle, ChevronLeft, ChevronRight, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAgentCards, visibleCards, fetchDrafts, type AgentCard } from "@/hooks/useAgentCards";
import { AgentActionCard } from "./AgentActionCard";
import { SlackThreadPanel } from "./SlackThreadPanel";
import { EmailComposer } from "./EmailComposer";
import { AgentScanDiagnostics } from "./AgentScanDiagnostics";
import { Progress } from "@/components/ui/progress";

export function AgentTab() {
  const {
    cards, loading, scanning, scanProgress, lastScanAt, lastRunId, gmailScopeMissing,
    runScan, updateStatus, reload,
  } = useAgentCards();
  const [slackFor, setSlackFor] = useState<AgentCard | null>(null);
  const [emailFor, setEmailFor] = useState<AgentCard | null>(null);
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"slack" | "ashby">("slack");

  const open = useMemo(() => visibleCards(cards), [cards]);

  const slackQueue = useMemo(() => {
    const ord = (k: AgentCard["kind"]) =>
      k === "batch_followup" ? 0 : k === "intro_stall" ? 1 : 2;
    return open
      .filter((c) => !c.payload.ashby_tracked)
      .filter((c) => !skippedIds.has(c.id))
      .sort((a, b) => {
        const k = ord(a.kind) - ord(b.kind);
        if (k !== 0) return k;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
  }, [open, skippedIds]);

  const ashbyQueue = useMemo(() => {
    // Stale first (these are the ones the user needs to action), then by age.
    return open
      .filter((c) => c.payload.ashby_tracked)
      .filter((c) => !skippedIds.has(c.id))
      .sort((a, b) => {
        const staleDiff = Number(!!b.payload.ashby_stale) - Number(!!a.payload.ashby_stale);
        if (staleDiff !== 0) return staleDiff;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
  }, [open, skippedIds]);

  const queue = view === "slack" ? slackQueue : ashbyQueue;
  const ashbyStaleCount = useMemo(
    () => ashbyQueue.filter((c) => c.payload.ashby_stale).length,
    [ashbyQueue],
  );

  const [cursorId, setCursorId] = useState<string | null>(null);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [sessionTotal, setSessionTotal] = useState<number>(0);

  // Reset cursor/session when switching views
  useEffect(() => {
    setCursorId(null);
    setSessionTotal(0);
  }, [view]);

  // Initialize / maintain the cursor as the queue changes
  useEffect(() => {
    if (queue.length === 0) {
      setCursorId(null);
      return;
    }
    if (sessionTotal === 0) setSessionTotal(queue.length);
    if (!cursorId || !queue.find((c) => c.id === cursorId)) {
      setCursorId(queue[0].id);
    }
  }, [queue, cursorId, sessionTotal]);

  const currentIndex = cursorId ? queue.findIndex((c) => c.id === cursorId) : -1;
  const current = currentIndex >= 0 ? queue[currentIndex] : null;
  const completedCount = completedIds.size;
  const totalForProgress = Math.max(sessionTotal, completedCount + queue.length);

  const advance = (delta: number) => {
    if (queue.length === 0) return;
    const i = currentIndex < 0 ? 0 : currentIndex;
    const next = (i + delta + queue.length) % queue.length;
    setCursorId(queue[next].id);
  };

  const markCompletedAndAdvance = (id: string) => {
    setCompletedIds((s) => new Set(s).add(id));
    // After update, the card will leave `queue`; pick the next neighbor
    const i = queue.findIndex((c) => c.id === id);
    const nextCard = queue[i + 1] ?? queue[i - 1] ?? null;
    setCursorId(nextCard?.id ?? null);
  };

  const handleScan = async () => {
    try {
      const data = await runScan();
      setCompletedIds(new Set());
      setSkippedIds(new Set());
      setSessionTotal(0);
      toast.success(
        `Scan complete · ${data?.cards_created ?? 0} new, ${data?.cards_resolved ?? 0} resolved (${data?.processed ?? 0} candidates checked)`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scan failed");
    }
  };

  const handleSnooze = async (c: AgentCard) => {
    const until = new Date(Date.now() + 3 * 86400000).toISOString();
    markCompletedAndAdvance(c.id);
    await updateStatus(c.id, "snoozed", until);
    toast.success("Snoozed for 3 days");
  };
  const handleDismiss = async (c: AgentCard) => {
    markCompletedAndAdvance(c.id);
    await updateStatus(c.id, "dismissed");
    toast.success("Dismissed");
  };
  const handleResolve = async (c: AgentCard) => {
    markCompletedAndAdvance(c.id);
    await updateStatus(c.id, "resolved");
    toast.success("Marked done");
  };
  const handleCloseCandidate = async (c: AgentCard) => {
    if (!c.payload.channel_id || !c.payload.message_ts) return;
    setClosingId(c.id);
    try {
      const { data, error } = await supabase.functions.invoke("slack-thread", {
        body: {
          action: "close",
          channel_id: c.payload.channel_id,
          message_ts: c.payload.message_ts,
        },
      });
      if (error || (data as any)?.error) {
        throw new Error(error?.message || (data as any)?.error || "Failed to close");
      }
      markCompletedAndAdvance(c.id);
      await updateStatus(c.id, "resolved");
      toast.success("Candidate closed out · ⛔ added in Slack");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't close out candidate");
    } finally {
      setClosingId(null);
    }
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

  const progressPct = totalForProgress > 0
    ? Math.round((completedCount / totalForProgress) * 100)
    : 0;

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
          {scanning
            ? scanProgress.total != null
              ? `Scanning… ${scanProgress.processed} / ${scanProgress.total}`
              : `Scanning… ${scanProgress.processed}`
            : "Run scan"}
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
      ) : current ? (
        <div className="space-y-4">
          {/* Tasker header: progress + position */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="uppercase tracking-wide font-medium">
                {current.kind === "intro_stall"
                  ? "Intro stall"
                  : current.kind === "post_interview_followup"
                    ? "Post-interview follow-up"
                    : "Batch follow-up"}
                {" · "}
                Task {Math.min(completedCount + 1, totalForProgress)} of {totalForProgress}
              </span>
              <span>
                {completedCount} done · {queue.length} left
              </span>
            </div>
            <Progress value={progressPct} className="h-1.5" />
          </div>

          {/* Single focused card */}
          <div className="max-w-2xl mx-auto w-full">
            <AgentActionCard
              card={current}
              drafting={draftingId === current.id}
              closing={closingId === current.id}
              onReplySlack={handleReplySlack}
              onEmail={handleEmail}
              onSnooze={handleSnooze}
              onDismiss={handleDismiss}
              onCloseCandidate={handleCloseCandidate}
            />
          </div>

          {/* Tasker controls */}
          <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => advance(-1)}
              disabled={queue.length <= 1}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleResolve(current)}
              className="gap-1"
            >
              <CheckCircle2 className="h-4 w-4" /> Mark done
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!current) return;
                const i = queue.findIndex((c) => c.id === current.id);
                const nextCard = queue[i + 1] ?? queue[i - 1] ?? null;
                setSkippedIds((s) => new Set(s).add(current.id));
                setCursorId(nextCard?.id ?? null);
              }}
              disabled={!current}
              className="gap-1"
            >
              Skip <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="border border-dashed border-border rounded-lg p-10 text-center">
          <p className="text-foreground font-medium mb-1">All caught up</p>
          <p className="text-sm text-muted-foreground">
            {completedCount > 0
              ? `You worked through ${completedCount} item${completedCount === 1 ? "" : "s"} — nice.`
              : "No follow-ups need your attention right now."}
          </p>
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
