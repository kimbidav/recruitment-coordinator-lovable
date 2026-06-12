import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlarmClock,
  CalendarClock,
  ExternalLink,
  Loader2,
  Mail,
  MessageSquare,
  X,
  Check,
  Activity,
  Calendar,
  MessageCircle,
  Send,
  Ban,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import type { AgentCard } from "@/hooks/useAgentCards";
import { SlackThreadInline } from "./SlackThreadPanel";

interface Props {
  card: AgentCard;
  drafting?: boolean;
  closing?: boolean;
  onReplySlack: (card: AgentCard) => void;
  onEmail: (card: AgentCard) => void;
  onSnooze: (card: AgentCard) => void;
  onDismiss: (card: AgentCard) => void;
  onCloseCandidate: (card: AgentCard) => void;
}

export function AgentActionCard({ card, drafting, closing, onReplySlack, onEmail, onSnooze, onDismiss, onCloseCandidate }: Props) {
  const p = card.payload || {};
  const isStall = card.kind === "intro_stall";
  const isBatch = card.kind === "batch_followup";
  const isAshbyScheduling = card.kind === "ashby_needs_scheduling";
  const isAshbyFeedback = card.kind === "ashby_missing_feedback";
  const kindLabel = isBatch
    ? "Batch status check"
    : isStall
      ? "No scheduling signal"
      : isAshbyScheduling
        ? "Needs scheduling (Ashby)"
        : isAshbyFeedback
          ? "Missing feedback (Ashby)"
          : "Awaiting feedback";
  const ctx = p.ashby_context;
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-foreground truncate">
              {isBatch
                ? `${p.client_name || p.company_name} · ${p.candidates?.length ?? 0} candidates`
                : (p.candidate_name || "(unknown)")}
            </h3>
            {!isBatch && (
              <span className="text-sm text-muted-foreground truncate">· {p.company_name}</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant={isStall || isBatch ? "secondary" : "outline"} className="gap-1">
              {isBatch ? (
                <MessageCircle className="h-3 w-3" />
              ) : isStall ? (
                <CalendarClock className="h-3 w-3" />
              ) : (
                <AlarmClock className="h-3 w-3" />
              )}
              {kindLabel}
            </Badge>
            <span className="text-xs text-muted-foreground">
              created {formatDistanceToNow(new Date(card.created_at), { addSuffix: true })}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" onClick={() => onSnooze(card)} title="Snooze 3 days">
            <AlarmClock className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDismiss(card)} title="Dismiss">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {isBatch && p.candidates && p.candidates.length > 0 && (
        <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
            Candidates
          </div>
          <ul className="space-y-0.5">
            {p.candidates.map((c) => (
              <li key={c.submission_id} className="text-xs text-foreground flex items-center justify-between gap-2">
                <span className="truncate">{c.name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {formatDistanceToNow(new Date(c.submitted_at), { addSuffix: true })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {ctx && (
        <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
            Ashby Pipeline
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            {ctx.job_title && (
              <div className="col-span-2 text-foreground font-medium truncate">{ctx.job_title}</div>
            )}
            {ctx.pipeline_stage && (
              <div>
                <span className="text-muted-foreground">Stage: </span>
                {ctx.pipeline_stage}
                {ctx.stage_progress ? ` (${ctx.stage_progress})` : ""}
              </div>
            )}
            {typeof ctx.days_in_stage === "number" && (
              <div>
                <span className="text-muted-foreground">Days in stage: </span>
                {ctx.days_in_stage}
              </div>
            )}
            {ctx.decision_status && (
              <div>
                <span className="text-muted-foreground">Status: </span>
                {ctx.decision_status}
              </div>
            )}
            {typeof ctx.feedback_count === "number" && ctx.feedback_count > 0 && (
              <div>
                <span className="text-muted-foreground">Scorecards: </span>
                {ctx.feedback_count}
                {typeof ctx.avg_score === "number" ? ` · avg ${ctx.avg_score.toFixed(1)}` : ""}
              </div>
            )}
            {ctx.upcoming_interview && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Upcoming: </span>
                {ctx.upcoming_interview}
              </div>
            )}
            {ctx.current_stage_interviews && (
              <div className="col-span-2 truncate" title={ctx.current_stage_interviews}>
                <span className="text-muted-foreground">This stage: </span>
                {ctx.current_stage_interviews}
              </div>
            )}
            {ctx.latest_feedback && (ctx.latest_feedback.author || ctx.latest_feedback.date) && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Latest feedback: </span>
                {[
                  ctx.latest_feedback.author,
                  ctx.latest_feedback.date
                    ? new Date(ctx.latest_feedback.date).toLocaleDateString()
                    : null,
                  ctx.latest_feedback.recommendation,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
            {ctx.interview_history && (
              <div className="col-span-2 text-muted-foreground truncate" title={ctx.interview_history}>
                {ctx.interview_history}
              </div>
            )}
          </div>
        </div>
      )}

      {p.signal_summary && (() => {
        const SENTINELS = new Set(["llm_error", "no_llm", "no_tool_call", "parse_error"]);
        const raw = p.signal_summary.trim();
        const display = SENTINELS.has(raw)
          ? "Couldn't analyze scheduling signal — will retry on next scan."
          : p.signal_summary;
        return <p className="text-sm text-muted-foreground">{display}</p>;
      })()}


      {(p.signals && p.signals.length > 0) ? (
        <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
            Signals
          </div>
          <ul className="space-y-1">
            {p.signals.slice(0, 5).map((s, i) => {
              const Icon =
                s.kind === "introduced" ? Send :
                s.kind === "scheduled" ? CalendarClock :
                s.kind === "upcoming" ? Calendar :
                s.kind === "interviewed" ? Calendar :
                s.kind === "email" ? Mail :
                MessageCircle;
              return (
                <li key={`${s.kind}-${i}`} className="flex items-start gap-2 text-xs">
                  <Icon className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground truncate">
                      <span className="font-medium">{s.label}</span>
                      <span className="text-muted-foreground"> · {format(new Date(s.at), "MMM d, yyyy")}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {formatDistanceToNow(new Date(s.at), { addSuffix: true })} · via {s.source}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : p.last_event ? (
        <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Activity className="h-3.5 w-3.5" />
            <span className="truncate">{p.last_event.label}</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground gap-2">
            <span>
              {formatDistanceToNow(new Date(p.last_event.at), { addSuffix: true })}
              {" · "}
              {format(new Date(p.last_event.at), "MMM d, h:mm a")}
            </span>
            <span className="truncate" title={`Source: ${p.last_event.source}`}>
              via {p.last_event.source}
            </span>
          </div>
        </div>
      ) : null}

      {!isBatch && p.channel_id && p.message_ts ? (
        <SlackThreadInline
          channelId={p.channel_id}
          messageTs={p.message_ts}
          initialReply={p.suggested_slack_message}
          maxMessagesHeight={260}
        />
      ) : !isBatch && p.thread_excerpt && !p.last_event?.detail ? (
        <div className="text-xs text-muted-foreground border-l-2 border-border pl-2 line-clamp-2">
          {p.thread_excerpt}
        </div>
      ) : null}

      {isBatch && p.suggested_slack_message && (
        <div className="rounded-md border border-border p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
            Suggested batch nudge
          </div>
          <pre className="text-xs text-foreground whitespace-pre-wrap font-sans">{p.suggested_slack_message}</pre>
          <Button size="sm" className="mt-2 gap-1.5" onClick={() => onReplySlack(card)}>
            <MessageSquare className="h-3.5 w-3.5" /> Reply in Slack
          </Button>
        </div>
      )}

      {isStall && p.suggested_followup_at && (
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <Check className="h-3 w-3" />
          Suggested nudge: {format(new Date(p.suggested_followup_at), "EEE MMM d, h:mm a")}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap pt-1">
        {!isBatch && (
          <Button size="sm" variant="outline" disabled={drafting} onClick={() => onEmail(card)} className="gap-1.5">
            {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
            Email candidate
          </Button>
        )}
        {!isBatch && card.payload.channel_id && card.payload.message_ts && (
          <Button
            size="sm"
            variant="outline"
            disabled={closing}
            onClick={() => onCloseCandidate(card)}
            className="gap-1.5"
            title="Close out candidate (adds ⛔ reaction in Slack)"
          >
            {closing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
            Close out candidate
          </Button>
        )}
        {p.slack_permalink && (
          <a
            href={p.slack_permalink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            Open in Slack
          </a>
        )}
      </div>
    </Card>
  );
}
