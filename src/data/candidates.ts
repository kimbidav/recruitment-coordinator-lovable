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
  source: string;
  feedback_count: number;
  latest_recommendation?: number;
  latest_feedback_author?: string;
  latest_feedback_date?: string;
  current_stage_interviews?: string;
  current_stage_avg_score?: number;
  current_stage_date?: string;
  interview_history_summary?: string;
  interview_events?: Array<{ id: string; interview_title: string; start_time: string; end_time: string }>;
}

// Empty by default - data is loaded from CSV uploads
export const candidatesData: Candidate[] = [];
