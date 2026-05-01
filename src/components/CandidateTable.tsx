import { useState, useMemo } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronDown, ChevronUp, Linkedin, Filter, MessagesSquare, Mail, Ban } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "./StatusBadge";
import { StageBadge } from "./StageBadge";
import { ProgressBar } from "./ProgressBar";
import { Candidate } from "@/data/candidates";
import { cn } from "@/lib/utils";
import { format, parseISO } from "date-fns";
import { SLACK_STATUS_LABEL, SlackStatus } from "@/lib/slackParse";

function SourcePill({ source, hasSlack }: { source: string; hasSlack: boolean }) {
  const label =
    source === "both" || (source === "ashby" && hasSlack)
      ? "Both"
      : source === "slack"
        ? "Slack"
        : "Ashby";
  const cls =
    label === "Both"
      ? "bg-primary/10 text-primary"
      : label === "Slack"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={cn("text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded", cls)}>
      {label}
    </span>
  );
}

type SortField = "candidate_name" | "company_name" | "job_title" | "pipeline_stage" | "days_in_stage" | "last_activity_at" | "feedback_count" | "credited_to" | "progress";
type SortDirection = "asc" | "desc";

interface CandidateTableProps {
  candidates: Candidate[];
  onFilterByCandidate?: (name: string) => void;
  onOpenSlackThread?: (c: Candidate) => void;
  onOpenEmail?: (c: Candidate) => void;
  onCloseCandidate?: (c: Candidate) => void;
}

export function CandidateTable({
  candidates,
  onFilterByCandidate,
  onOpenSlackThread,
  onOpenEmail,
  onCloseCandidate,
}: CandidateTableProps) {
  const [sortField, setSortField] = useState<SortField>("last_activity_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const toggleRow = (candidateId: string) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(candidateId)) {
      newExpanded.delete(candidateId);
    } else {
      newExpanded.add(candidateId);
    }
    setExpandedRows(newExpanded);
  };

  // Build a lookup from candidate_name -> first available LinkedIn URL across all rows for that person.
  const linkedinByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of candidates) {
      const url = c.slack_meta?.linkedin_url;
      if (url && !map.has(c.candidate_name)) map.set(c.candidate_name, url);
    }
    return map;
  }, [candidates]);

  const sortedCandidates = useMemo(() => {
    return [...candidates].sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      if (sortField === "progress") {
        // Sort by percentage of completion (current/total)
        aVal = a.current_stage_index / a.total_stages;
        bVal = b.current_stage_index / b.total_stages;
      } else if (sortField === "last_activity_at") {
        aVal = new Date(a.last_activity_at).getTime();
        bVal = new Date(b.last_activity_at).getTime();
      } else {
        aVal = a[sortField] as string | number;
        bVal = b[sortField] as string | number;
      }

      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortDirection === "asc"
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }

      return sortDirection === "asc"
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
  }, [candidates, sortField, sortDirection]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />;
    }
    return sortDirection === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5 text-foreground" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5 text-foreground" />
    );
  };

  const formatDate = (dateString: string) => {
    try {
      return format(parseISO(dateString), "MMM d, yyyy");
    } catch {
      return dateString;
    }
  };

  return (
    <div className="bg-card rounded-lg border border-border shadow-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent border-border">
            <TableHead className="w-8"></TableHead>
            <TableHead
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleSort("candidate_name")}
            >
              <div className="flex items-center gap-1.5">
                Candidate
                <SortIcon field="candidate_name" />
              </div>
            </TableHead>
            <TableHead
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleSort("credited_to")}
            >
              <div className="flex items-center gap-1.5">
                Submitted By
                <SortIcon field="credited_to" />
              </div>
            </TableHead>
            <TableHead
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleSort("company_name")}
            >
              <div className="flex items-center gap-1.5">
                Company
                <SortIcon field="company_name" />
              </div>
            </TableHead>
            <TableHead>Source</TableHead>
            <TableHead
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleSort("job_title")}
            >
              <div className="flex items-center gap-1.5">
                Role
                <SortIcon field="job_title" />
              </div>
            </TableHead>
            <TableHead
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleSort("pipeline_stage")}
            >
              <div className="flex items-center gap-1.5">
                Stage
                <SortIcon field="pipeline_stage" />
              </div>
            </TableHead>
            <TableHead
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleSort("progress")}
            >
              <div className="flex items-center gap-1.5">
                Progress
                <SortIcon field="progress" />
              </div>
            </TableHead>
            <TableHead>Status</TableHead>
            <TableHead
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleSort("days_in_stage")}
            >
              <div className="flex items-center gap-1.5">
                Days in Stage
                <SortIcon field="days_in_stage" />
              </div>
            </TableHead>
            <TableHead
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleSort("last_activity_at")}
            >
              <div className="flex items-center gap-1.5">
                Last Activity
                <SortIcon field="last_activity_at" />
              </div>
            </TableHead>
            <TableHead
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleSort("feedback_count")}
            >
              <div className="flex items-center gap-1.5">
                Feedback
                <SortIcon field="feedback_count" />
              </div>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedCandidates.map((candidate) => {
            const isExpanded = expandedRows.has(candidate.candidate_id);
            return (
              <>
                <TableRow
                  key={candidate.candidate_id}
                  className={cn(
                    "cursor-pointer transition-colors hover:bg-muted/50",
                    isExpanded && "bg-muted/30"
                  )}
                  onClick={() => toggleRow(candidate.candidate_id)}
                >
                  <TableCell className="w-8">
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 group/name">
                      <span className="font-medium text-foreground">
                        {candidate.candidate_name}
                      </span>
                      <div className="flex items-center gap-1 opacity-0 group-hover/name:opacity-100 transition-opacity">
                        {linkedinByName.get(candidate.candidate_name) && (
                          <a
                            href={linkedinByName.get(candidate.candidate_name)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open LinkedIn profile"
                            className="text-muted-foreground hover:text-primary transition-colors"
                          >
                            <Linkedin className="h-3.5 w-3.5" />
                          </a>
                        )}
                        {onFilterByCandidate && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onFilterByCandidate(candidate.candidate_name);
                            }}
                            title={`Filter to all processes for ${candidate.candidate_name}`}
                            className="text-muted-foreground hover:text-primary transition-colors"
                          >
                            <Filter className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{candidate.credited_to}</span>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{candidate.company_name}</span>
                  </TableCell>
                  <TableCell>
                    <SourcePill source={candidate.source} hasSlack={!!candidate.slack_meta} />
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{candidate.job_title}</span>
                  </TableCell>
                  <TableCell>
                    <StageBadge stage={candidate.pipeline_stage} />
                  </TableCell>
                  <TableCell>
                    <ProgressBar
                      current={candidate.current_stage_index}
                      total={candidate.total_stages}
                      className="w-24"
                    />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={candidate.decision_status} />
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "font-medium",
                        candidate.days_in_stage > 30
                          ? "text-status-warning"
                          : "text-foreground"
                      )}
                    >
                      {candidate.days_in_stage}d
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(candidate.last_activity_at)}
                  </TableCell>
                  <TableCell>
                    {candidate.feedback_count > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{candidate.feedback_count}</span>
                        {candidate.latest_recommendation && (
                          <span className="text-xs text-muted-foreground">
                            (avg: {candidate.latest_recommendation})
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
                {isExpanded && (
                  <TableRow key={`${candidate.candidate_id}-expanded`} className="bg-muted/20 hover:bg-muted/20">
                    <TableCell colSpan={11} className="p-4">
                      <div className="space-y-4">
                        <div>
                          <h4 className="text-sm font-semibold text-foreground mb-2">
                            Interview timeline
                          </h4>
                          {candidate.interview_events && candidate.interview_events.length > 0 ? (
                            <div className="space-y-2">
                              {[...candidate.interview_events]
                                .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime())
                                .map((ev) => {
                                  const start = new Date(ev.start_time);
                                  const isUpcoming = start.getTime() > Date.now();
                                  return (
                                    <div
                                      key={ev.id}
                                      className="bg-card p-3 rounded-md border border-border"
                                    >
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <div className="text-sm font-medium text-foreground">
                                            {ev.interview_title}
                                          </div>
                                          <div className="text-xs text-muted-foreground mt-0.5">
                                            {format(start, "EEE, MMM d, yyyy 'at' h:mm a")}
                                          </div>
                                        </div>
                                        <span
                                          className={cn(
                                            "text-[10px] uppercase tracking-wide font-medium px-2 py-0.5 rounded",
                                            isUpcoming
                                              ? "bg-status-success/10 text-status-success"
                                              : "bg-muted text-muted-foreground"
                                          )}
                                        >
                                          {isUpcoming ? "Scheduled" : "Completed"}
                                        </span>
                                      </div>
                                      {ev.interviewers && ev.interviewers.length > 0 && (
                                        <div className="mt-2 space-y-1">
                                          {ev.interviewers.map((iv, i) => (
                                            <div key={i} className="text-xs text-muted-foreground flex flex-wrap items-center gap-2">
                                              <span className="font-medium text-foreground">{iv.name}</span>
                                              {iv.score && (
                                                <span className="text-[10px] uppercase font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                                                  {iv.score}
                                                </span>
                                              )}
                                              {iv.feedback_text && (
                                                <span className="italic">"{iv.feedback_text}"</span>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                            </div>
                          ) : candidate.interview_history_summary ? (
                            <div className="text-sm text-muted-foreground bg-card p-3 rounded-md border border-border">
                              {candidate.interview_history_summary.split(" | ").map((item, i) => (
                                <div key={i} className="py-0.5">{item}</div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground">No interviews recorded yet</p>
                          )}
                        </div>
                        {candidate.latest_feedback_author && (
                          <p className="text-sm">
                            <span className="text-muted-foreground">Latest feedback by: </span>
                            <span className="font-medium">{candidate.latest_feedback_author}</span>
                            {candidate.latest_feedback_date && (
                              <span className="text-muted-foreground"> on {formatDate(candidate.latest_feedback_date)}</span>
                            )}
                          </p>
                        )}
                        {candidate.slack_meta && (
                          <div className="text-sm bg-card p-3 rounded-md border border-border space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400">
                                Slack
                              </span>
                              <span className="text-muted-foreground">
                                {SLACK_STATUS_LABEL[candidate.slack_meta.status as SlackStatus] ?? candidate.slack_meta.status}
                                {" · submitted "}
                                {formatDate(candidate.slack_meta.submitted_at)}
                              </span>
                            </div>
                            {candidate.slack_meta.linkedin_url && (
                              <a
                                href={candidate.slack_meta.linkedin_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary underline text-xs break-all"
                              >
                                {candidate.slack_meta.linkedin_url}
                              </a>
                            )}
                            {candidate.slack_meta.needs_review && (
                              <p className="text-xs text-status-warning">Needs review — name couldn't be auto-extracted</p>
                            )}
                          </div>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            );
          })}
        </TableBody>
      </Table>
      {sortedCandidates.length === 0 && (
        <div className="p-8 text-center text-muted-foreground">
          No candidates found matching your criteria
        </div>
      )}
    </div>
  );
}
