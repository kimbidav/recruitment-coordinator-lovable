export interface InterviewInterviewer {
  name: string;
  email?: string;
  score?: string | null;
  feedback_submitted?: boolean;
  feedback_text?: string | null;
}

export interface InterviewEvent {
  id: string;
  interview_title: string;
  start_time: string;
  end_time?: string;
  interviewers?: InterviewInterviewer[];
}

export interface SlackMeta {
  status: string; // submitted | accepted | not_in_process | disqualified
  submitted_at: string;
  channel_id: string;
  message_ts: string;
  linkedin_url: string | null;
  needs_review: boolean;
}

export interface Candidate {
  company_name: string;
  job_title: string;
  job_id: string;
  candidate_name: string;
  candidate_id: string;
  pipeline_stage: string;
  decision_status: string;
  stage_type: string;
  current_stage_index: number;
  total_stages: number;
  stage_progress: string;
  last_activity_at: string;
  days_in_stage: number;
  needs_scheduling: boolean;
  credited_to: string;
  // Company-level: "ashby" = client runs an Ashby instance (all loops there
  // are ashby, even Slack-only submissions); "slack" = no Ashby presence.
  source: string; // "ashby" | "slack"
  // Slack-only candidate at an Ashby-instrumented client — they exist in a
  // Slack thread but have no Ashby record, i.e. they SHOULD be in Ashby.
  missing_from_ashby?: boolean;
  feedback_count: number;
  // Ashby returns this as a string label (e.g. "Strong Hire") — not numeric.
  latest_recommendation?: string;
  latest_feedback_author?: string;
  latest_feedback_date?: string;
  current_stage_interviews?: string;
  current_stage_avg_score?: number;
  current_stage_date?: string;
  interview_history_summary?: string;
  interview_events?: InterviewEvent[];
  slack_meta?: SlackMeta;
  /** True if the user closed this candidate locally from the dashboard. */
  closed_locally?: boolean;
  closed_at?: string;
}

// Empty by default - data is loaded from Ashby fetch / CSV uploads
export const candidatesData: Candidate[] = [];
