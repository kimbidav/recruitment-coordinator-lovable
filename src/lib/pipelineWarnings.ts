// Data-quality warnings for Ashby snapshot rows — port of the desktop app's
// getAshbyPipelineWarnings (useMergedPipeline.ts). Only ever called on rows
// that genuinely came from the Ashby extractor; Slack/CSV rows don't have the
// structured interview_events the logic assumes (letting them through caused
// the Brian Ton false positive locally).
import { Candidate } from "@/data/candidates";

function parseEventTime(raw?: string): number | null {
  if (!raw) return null;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : null;
}

function hasFutureInterview(candidate: Candidate): boolean {
  const now = Date.now();
  return (candidate.interview_events || []).some((event) => {
    const time = parseEventTime(event.start_time);
    return time != null && time > now;
  });
}

function hasOnlyPastInterviewEvents(candidate: Candidate): boolean {
  const events = candidate.interview_events || [];
  if (events.length === 0) return false;
  const now = Date.now();
  return events.every((event) => {
    const time = parseEventTime(event.start_time);
    return time != null && time <= now;
  });
}

export function getAshbyPipelineWarnings(candidate: Candidate): string[] {
  const warnings: string[] = [];
  const decision = (candidate.decision_status || "").toLowerCase();
  const stage = (candidate.pipeline_stage || "").toLowerCase();
  const events = candidate.interview_events || [];

  if (decision.includes("scheduled") && events.length === 0) {
    warnings.push(
      "Ashby says this candidate is scheduled, but the saved snapshot has no structured interview events.",
    );
  }

  if (decision.includes("scheduled") && hasOnlyPastInterviewEvents(candidate) && !hasFutureInterview(candidate)) {
    warnings.push(
      "Ashby says this candidate is scheduled, but all saved current-stage interviews are in the past. Future interviews or a stage movement may be missing from the extract.",
    );
  }

  const textParts = [
    candidate.current_stage_interviews,
    candidate.interview_history_summary,
    ...(candidate.interview_events || []).flatMap((event) => [
      event.interview_title,
      ...(event.interviewers || []).map((interviewer) => interviewer.feedback_text || ""),
    ]),
  ];
  const text = textParts.filter(Boolean).join(" ").toLowerCase();
  if (
    !stage.includes("onsite") &&
    /\bon[-\s]?site\b/.test(text) &&
    /(move|moved|moving|advance|proceed|invitation|invite)/.test(text)
  ) {
    warnings.push("Saved Ashby notes mention onsite movement, but the extracted current stage is not onsite.");
  }

  return warnings;
}
