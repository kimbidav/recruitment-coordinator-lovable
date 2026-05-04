import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlarmClock,
  CalendarClock,
  ExternalLink,
  Mail,
  MessageSquare,
  X,
  Check,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import type { AgentCard } from "@/hooks/useAgentCards";

interface Props {
  card: AgentCard;
  onReplySlack: (card: AgentCard) => void;
  onEmail: (card: AgentCard) => void;
  onSnooze: (card: AgentCard) => void;
  onDismiss: (card: AgentCard) => void;
}

export function AgentActionCard({ card, drafting, onReplySlack, onEmail, onSnooze, onDismiss }: Props) {
  const p = card.payload || {};
  const isStall = card.kind === "intro_stall";
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-foreground truncate">
              {p.candidate_name || "(unknown)"}
            </h3>
            <span className="text-sm text-muted-foreground truncate">· {p.company_name}</span>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant={isStall ? "secondary" : "outline"} className="gap-1">
              {isStall ? (
                <CalendarClock className="h-3 w-3" />
              ) : (
                <AlarmClock className="h-3 w-3" />
              )}
              {isStall ? "No scheduling signal" : "Awaiting feedback"}
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

      {p.signal_summary && (
        <p className="text-sm text-muted-foreground">{p.signal_summary}</p>
      )}

      {p.thread_excerpt && (
        <div className="text-xs text-muted-foreground border-l-2 border-border pl-2 line-clamp-2">
          {p.thread_excerpt}
        </div>
      )}

      {isStall && p.suggested_followup_at && (
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <Check className="h-3 w-3" />
          Suggested nudge: {format(new Date(p.suggested_followup_at), "EEE MMM d, h:mm a")}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap pt-1">
        <Button size="sm" variant="default" disabled={drafting} onClick={() => onReplySlack(card)} className="gap-1.5">
          {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
          Reply in Slack
        </Button>
        <Button size="sm" variant="outline" disabled={drafting} onClick={() => onEmail(card)} className="gap-1.5">
          {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
          Email candidate
        </Button>
        {p.slack_permalink && (
          <a
            href={p.slack_permalink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            Open thread
          </a>
        )}
      </div>
    </Card>
  );
}
