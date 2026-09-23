import { useState, useMemo } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown, AlertTriangle, ChevronDown, ChevronUp, Linkedin, Filter, MessagesSquare, Mail, Ban, Loader2 } from "lucide-react";
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

// Source is company-level: "ashby" = the client runs an Ashby instance (every
// loop there is tagged ashby, even Slack-only submissions); "slack" = client
// with no Ashby presence. The candidate-level "missing from Ashby" gap is
// flagged with an explicit badge under the candidate's name (not here) — the
// Source pill stays the company-level truth.
function SourcePill({ source }: { source: string }) {
  const label = source === "slack" ? "Slack" : "Ashby";
  const cls =
    label === "Slack"
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
  /** Multi-select for the follow-up bar. Checkbox column renders only when provided. */
  selectedIds?: Set<string>;
  onToggleSelect?: (c: Candidate) => void;
  /** candidate_id currently being resolved by the find-thread lookup (shows a spinner). */
  findingThreadId?: string | null;
}

export function CandidateTable({
  candidates,
  onFilterByCandidate,
  onOpenSlackThread,
  onOpenEmail,
  onCloseCandidate,
  selectedIds,
  onToggleSelect,
  findingThreadId,
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
        // Sort by percentage of completion (current/total). Rows with no
        // stage data (Slack-only candidates) get -1 so they rank below even
        // a genuine 0/N — unknown progress shouldn't interleave with real
        // values (and NaN would break the comparator entirely).
        aVal = a.total_stages > 0 ? a.current_stage_index / a.total_stages : -1;
        bVal = b.total_stages > 0 ? b.current_stage_index / b.total_stages : -1;
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
    <div className="bg-card rounded-lg border border-border shadow-card overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent border-border">
            {onToggleSelect && <TableHead className="w-8"></TableHead>}
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
            <TableHead
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleSort("days_in_stage")}
            >
              <div className="flex items-center gap-1.5">
                Days
                <SortIcon field="days_in_stage" />
              </div>
            </TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="sticky right-0 bg-card shadow-[-4px_0_8px_-4px_hsl(var(--border))]">Actions</TableHead>
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
                  {onToggleSelect && (
                    <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds?.has(candidate.candidate_id) ?? false}
                        onChange={() => onToggleSelect(candidate)}
                        className="h-3.5 w-3.5 accent-primary cursor-pointer"
                        aria-label={`Select ${candidate.candidate_name} for follow-up`}
                      />
                    </TableCell>
                  )}
                  <TableCell className="w-8">
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
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
                      {candidate.org_status === "retired" && (
                        <span
                          title="The team no longer has Ashby access to this client, so this row cannot refresh. This says nothing about the candidate's outcome."
                          className="inline-flex items-center gap-1 w-fit text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border cursor-help whitespace-nowrap"
                        >
                          ATS access lost
                        </span>
                      )}
                      {candidate.access_restricted && (
                        <span
                          title="This application is on a job your Ashby seat cannot see. Stage and interview details are invisible, not missing."
                          className="inline-flex items-center gap-1 w-fit text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border cursor-help whitespace-nowrap"
                        >
                          No-access job
                        </span>
                      )}
                      {candidate.missing_from_ashby && (
                        <span
                          title="This client runs Ashby, but this candidate has no Ashby record (not even an archived one) — they may be missing from the ATS."
                          className="inline-flex items-center gap-1 w-fit text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30 cursor-help whitespace-nowrap"
                        >
                          ⚠ Not yet in Ashby
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{candidate.credited_to}</span>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{candidate.company_name}</span>
                  </TableCell>
                  <TableCell>
                    <SourcePill source={candidate.source} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <StageBadge stage={candidate.pipeline_stage} />
                      {candidate.data_quality_warnings && candidate.data_quality_warnings.length > 0 && (
                        <span title={candidate.data_quality_warnings.join("\n")} className="inline-flex">
                          <AlertTriangle
                            className="h-3.5 w-3.5 shrink-0 text-amber-600"
                            aria-label="Ashby data warning"
                          />
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {candidate.total_stages > 0 ? (
                      <ProgressBar
                        current={candidate.current_stage_index}
                        total={candidate.total_stages}
                        className="w-24"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground" title="No Ashby record — pipeline progress unknown">
                        —
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "text-sm tabular-nums",
                        candidate.days_in_stage > 30
                          ? "text-destructive font-medium"
                          : "text-muted-foreground",
                      )}
                      title={
                        candidate.days_in_stage > 30
                          ? `${candidate.days_in_stage} days in stage — may need attention`
                          : `${candidate.days_in_stage} days in current stage`
                      }
                    >
                      {Number.isFinite(candidate.days_in_stage) ? `${candidate.days_in_stage}d` : "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      status={candidate.decision_status}
                      reason={
                        candidate.archived_reason ??
                        (candidate.archived_inferred
                          ? "Inferred: candidate no longer appears in Ashby's active pipeline"
                          : undefined)
                      }
                    />
                  </TableCell>
                  <TableCell
                    onClick={(e) => e.stopPropagation()}
                    className="sticky right-0 bg-card shadow-[-4px_0_8px_-4px_hsl(var(--border))]"
                  >
                    <div className="flex items-center gap-2 text-sm">

                      {onOpenSlackThread && (
                        <button
                          type="button"
                          onClick={() => onOpenSlackThread(candidate)}
                          disabled={findingThreadId === candidate.candidate_id}
                          className="text-muted-foreground hover:text-primary transition-colors inline-flex items-center gap-1 disabled:opacity-60"
                          title={
                            candidate.slack_meta
                              ? "Open Slack thread"
                              : "Find this candidate's Slack thread"
                          }
                        >
                          {findingThreadId === candidate.candidate_id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <MessagesSquare className="h-3.5 w-3.5" />
                          )}
                          Thread
                        </button>
                      )}
                      {onOpenEmail && (
                        <button
                          type="button"
                          onClick={() => onOpenEmail(candidate)}
                          className="text-foreground hover:text-primary transition-colors inline-flex items-center gap-1"
                          title="Compose email"
                        >
                          <Mail className="h-3.5 w-3.5" />
                          Email
                        </button>
                      )}
                      {onCloseCandidate && !candidate.closed_locally && (
                        <button
                          type="button"
                          onClick={() => onCloseCandidate(candidate)}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                          title="Close out this candidate (adds ⛔ in Slack)"
                        >
                          <Ban className="h-4 w-4" />
                        </button>
                      )}
                      {candidate.closed_locally && (
                        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                          <Ban className="h-3.5 w-3.5" /> closed
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                {isExpanded && (
                  <TableRow key={`${candidate.candidate_id}-expanded`} className="bg-muted/20 hover:bg-muted/20">
                    <TableCell colSpan={onToggleSelect ? 11 : 10} className="p-4">
                      <div className="space-y-4">
                        <div>
                          <h4 className="text-sm font-semibold text-foreground mb-1">Role</h4>
                          <p className="text-sm text-muted-foreground">{candidate.job_title}</p>
                        </div>
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
