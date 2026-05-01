// Helpers for displaying Slack submission data on the client.
// Server-side parsing happens in the slack-sync edge function.

export type SlackStatus = "submitted" | "accepted" | "not_in_process" | "disqualified";

export const SLACK_STATUS_LABEL: Record<SlackStatus, string> = {
  submitted: "Submitted",
  accepted: "In Process",
  not_in_process: "Not in process",
  disqualified: "Disqualified",
};

/** Map a Slack-only submission status to the dashboard's pipeline stage label. */
export function slackStatusToPipelineStage(status: string): string {
  switch (status) {
    case "accepted":
      return "In Process";
    case "not_in_process":
      return "Not in Process";
    case "disqualified":
      return "Disqualified";
    default:
      return "Submitted";
  }
}

/** Map a Slack-only submission status to the dashboard's decision_status. */
export function slackStatusToDecision(status: string): string {
  switch (status) {
    case "accepted":
      return "Active";
    case "not_in_process":
      return "Rejected";
    case "disqualified":
      return "Rejected";
    default:
      return "Pending";
  }
}

/** Normalize a name/client for matching across Ashby + Slack. */
export function normalizeMatchKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function candidateMatchKey(clientName: string, candidateName: string): string {
  return `${normalizeMatchKey(clientName)}::${normalizeMatchKey(candidateName)}`;
}
