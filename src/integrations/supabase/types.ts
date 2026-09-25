export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_action_cards: {
        Row: {
          act_error: string | null
          act_idempotency_key: string | null
          act_result: Json | null
          act_status: string | null
          acted_at: string | null
          ashby_pair_key: string | null
          candidate_row_id: string | null
          created_at: string
          id: string
          kind: string
          payload: Json
          queue_section: string | null
          slack_submission_id: string | null
          snooze_until: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          act_error?: string | null
          act_idempotency_key?: string | null
          act_result?: Json | null
          act_status?: string | null
          acted_at?: string | null
          ashby_pair_key?: string | null
          candidate_row_id?: string | null
          created_at?: string
          id?: string
          kind: string
          payload?: Json
          queue_section?: string | null
          slack_submission_id?: string | null
          snooze_until?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          act_error?: string | null
          act_idempotency_key?: string | null
          act_result?: Json | null
          act_status?: string | null
          acted_at?: string | null
          ashby_pair_key?: string | null
          candidate_row_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          payload?: Json
          queue_section?: string | null
          slack_submission_id?: string | null
          snooze_until?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      agent_scan_items: {
        Row: {
          candidate_name: string | null
          client_name: string | null
          created_at: string
          id: string
          outcome: string
          reason: string | null
          scan_run_id: string
          signal: Json | null
          slack_submission_id: string | null
          user_id: string
        }
        Insert: {
          candidate_name?: string | null
          client_name?: string | null
          created_at?: string
          id?: string
          outcome: string
          reason?: string | null
          scan_run_id: string
          signal?: Json | null
          slack_submission_id?: string | null
          user_id: string
        }
        Update: {
          candidate_name?: string | null
          client_name?: string | null
          created_at?: string
          id?: string
          outcome?: string
          reason?: string | null
          scan_run_id?: string
          signal?: Json | null
          slack_submission_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      agent_scan_runs: {
        Row: {
          cards_created: number
          cards_resolved: number
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          started_at: string
          user_id: string
        }
        Insert: {
          cards_created?: number
          cards_resolved?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          started_at?: string
          user_id: string
        }
        Update: {
          cards_created?: number
          cards_resolved?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          started_at?: string
          user_id?: string
        }
        Relationships: []
      }
      agent_settings: {
        Row: {
          batch_followup_threshold: number
          created_at: string
          intro_stall_min_days: number
          onboarding_version: number
          recruiter_aliases: string[]
          timezone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          batch_followup_threshold?: number
          created_at?: string
          intro_stall_min_days?: number
          onboarding_version?: number
          recruiter_aliases?: string[]
          timezone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          batch_followup_threshold?: number
          created_at?: string
          intro_stall_min_days?: number
          onboarding_version?: number
          recruiter_aliases?: string[]
          timezone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ashby_channel_org_map: {
        Row: {
          channel_id: string
          channel_name: string | null
          learned_by: string | null
          org_name: string
          updated_at: string
        }
        Insert: {
          channel_id: string
          channel_name?: string | null
          learned_by?: string | null
          org_name: string
          updated_at?: string
        }
        Update: {
          channel_id?: string
          channel_name?: string | null
          learned_by?: string | null
          org_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      ashby_connection: {
        Row: {
          id: number
          last_error: string | null
          last_ok_at: string | null
          last_seeded_at: string | null
          seeded_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          id?: number
          last_error?: string | null
          last_ok_at?: string | null
          last_seeded_at?: string | null
          seeded_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          id?: number
          last_error?: string | null
          last_ok_at?: string | null
          last_seeded_at?: string | null
          seeded_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      ashby_known_clients: {
        Row: {
          client_name: string
          first_seen_at: string
          id: string
          last_seen_at: string
          user_id: string
        }
        Insert: {
          client_name: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          user_id: string
        }
        Update: {
          client_name?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ashby_open_jobs_cache: {
        Row: {
          fetched_at: string
          jobs: Json
          org_id: string | null
          org_key: string
          org_name: string
          source_id: string | null
          source_title: string | null
        }
        Insert: {
          fetched_at?: string
          jobs?: Json
          org_id?: string | null
          org_key: string
          org_name: string
          source_id?: string | null
          source_title?: string | null
        }
        Update: {
          fetched_at?: string
          jobs?: Json
          org_id?: string | null
          org_key?: string
          org_name?: string
          source_id?: string | null
          source_title?: string | null
        }
        Relationships: []
      }
      ashby_org_aliases: {
        Row: {
          confirmed_by: string | null
          created_at: string
          current_name: string
          source: string
          stale_name: string
          updated_at: string
        }
        Insert: {
          confirmed_by?: string | null
          created_at?: string
          current_name: string
          source?: string
          stale_name: string
          updated_at?: string
        }
        Update: {
          confirmed_by?: string | null
          created_at?: string
          current_name?: string
          source?: string
          stale_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      ashby_org_health: {
        Row: {
          audit: Json
          checked_at: string
          id: number
        }
        Insert: {
          audit?: Json
          checked_at?: string
          id?: number
        }
        Update: {
          audit?: Json
          checked_at?: string
          id?: number
        }
        Relationships: []
      }
      ashby_orgs: {
        Row: {
          first_seen_at: string
          last_sweep_ok: boolean | null
          last_swept_at: string | null
          org_id: string | null
          org_name: string
        }
        Insert: {
          first_seen_at?: string
          last_sweep_ok?: boolean | null
          last_swept_at?: string | null
          org_id?: string | null
          org_name: string
        }
        Update: {
          first_seen_at?: string
          last_sweep_ok?: boolean | null
          last_swept_at?: string | null
          org_id?: string | null
          org_name?: string
        }
        Relationships: []
      }
      ashby_retired_orgs: {
        Row: {
          note: string | null
          org_name: string
          retired_at: string
          retired_by: string | null
        }
        Insert: {
          note?: string | null
          org_name: string
          retired_at?: string
          retired_by?: string | null
        }
        Update: {
          note?: string | null
          org_name?: string
          retired_at?: string
          retired_by?: string | null
        }
        Relationships: []
      }
      ashby_snapshot_candidates: {
        Row: {
          access_restricted: boolean
          added_via: string | null
          application_id: string | null
          archived_detected_at: string | null
          archived_inferred: boolean | null
          archived_reason: string | null
          archived_reason_type: string | null
          archived_verified_live_at: string | null
          ashby_candidate_id: string
          ashby_job_id: string
          candidate_name: string
          company_name: string
          created_at: string
          credited_to: string | null
          credited_to_email: string | null
          credited_to_user_id: string | null
          current_stage_avg_score: number | null
          current_stage_date: string | null
          current_stage_index: number
          current_stage_interviews: string | null
          days_in_stage: number
          decision_status: string | null
          feedback_count: number
          fetch_source: string | null
          fetched_at: string | null
          id: string
          interview_events: Json
          interview_history_summary: string | null
          job_title: string | null
          last_activity_at: string | null
          latest_feedback_author: string | null
          latest_feedback_date: string | null
          latest_recommendation: string | null
          linkedin_url: string | null
          needs_scheduling: boolean
          org_id: string | null
          org_retired_at: string | null
          org_status: string | null
          pipeline_stage: string | null
          previous_company_names: string[]
          source: string | null
          stage_progress: string | null
          stage_type: string
          status_verified_live: string | null
          status_verified_live_at: string | null
          total_stages: number
          updated_at: string
        }
        Insert: {
          access_restricted?: boolean
          added_via?: string | null
          application_id?: string | null
          archived_detected_at?: string | null
          archived_inferred?: boolean | null
          archived_reason?: string | null
          archived_reason_type?: string | null
          archived_verified_live_at?: string | null
          ashby_candidate_id: string
          ashby_job_id?: string
          candidate_name: string
          company_name: string
          created_at?: string
          credited_to?: string | null
          credited_to_email?: string | null
          credited_to_user_id?: string | null
          current_stage_avg_score?: number | null
          current_stage_date?: string | null
          current_stage_index?: number
          current_stage_interviews?: string | null
          days_in_stage?: number
          decision_status?: string | null
          feedback_count?: number
          fetch_source?: string | null
          fetched_at?: string | null
          id?: string
          interview_events?: Json
          interview_history_summary?: string | null
          job_title?: string | null
          last_activity_at?: string | null
          latest_feedback_author?: string | null
          latest_feedback_date?: string | null
          latest_recommendation?: string | null
          linkedin_url?: string | null
          needs_scheduling?: boolean
          org_id?: string | null
          org_retired_at?: string | null
          org_status?: string | null
          pipeline_stage?: string | null
          previous_company_names?: string[]
          source?: string | null
          stage_progress?: string | null
          stage_type?: string
          status_verified_live?: string | null
          status_verified_live_at?: string | null
          total_stages?: number
          updated_at?: string
        }
        Update: {
          access_restricted?: boolean
          added_via?: string | null
          application_id?: string | null
          archived_detected_at?: string | null
          archived_inferred?: boolean | null
          archived_reason?: string | null
          archived_reason_type?: string | null
          archived_verified_live_at?: string | null
          ashby_candidate_id?: string
          ashby_job_id?: string
          candidate_name?: string
          company_name?: string
          created_at?: string
          credited_to?: string | null
          credited_to_email?: string | null
          credited_to_user_id?: string | null
          current_stage_avg_score?: number | null
          current_stage_date?: string | null
          current_stage_index?: number
          current_stage_interviews?: string | null
          days_in_stage?: number
          decision_status?: string | null
          feedback_count?: number
          fetch_source?: string | null
          fetched_at?: string | null
          id?: string
          interview_events?: Json
          interview_history_summary?: string | null
          job_title?: string | null
          last_activity_at?: string | null
          latest_feedback_author?: string | null
          latest_feedback_date?: string | null
          latest_recommendation?: string | null
          linkedin_url?: string | null
          needs_scheduling?: boolean
          org_id?: string | null
          org_retired_at?: string | null
          org_status?: string | null
          pipeline_stage?: string | null
          previous_company_names?: string[]
          source?: string | null
          stage_progress?: string | null
          stage_type?: string
          status_verified_live?: string | null
          status_verified_live_at?: string | null
          total_stages?: number
          updated_at?: string
        }
        Relationships: []
      }
      ashby_uploads: {
        Row: {
          candidate_name: string | null
          extractor_job_id: string | null
          finished_at: string | null
          http_status: number | null
          id: string
          org_name: string | null
          result: Json | null
          session_id: string | null
          started_at: string
          status: string
          user_id: string
        }
        Insert: {
          candidate_name?: string | null
          extractor_job_id?: string | null
          finished_at?: string | null
          http_status?: number | null
          id?: string
          org_name?: string | null
          result?: Json | null
          session_id?: string | null
          started_at?: string
          status?: string
          user_id: string
        }
        Update: {
          candidate_name?: string | null
          extractor_job_id?: string | null
          finished_at?: string | null
          http_status?: number | null
          id?: string
          org_name?: string | null
          result?: Json | null
          session_id?: string | null
          started_at?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ashby_uploads_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "slack_shortcut_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      ashby_user_sessions: {
        Row: {
          email: string
          expires_estimate_at: string | null
          identity_verified: boolean
          last_error: string | null
          last_ok_at: string | null
          last_seeded_at: string | null
          org_count: number
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          email: string
          expires_estimate_at?: string | null
          identity_verified?: boolean
          last_error?: string | null
          last_ok_at?: string | null
          last_seeded_at?: string | null
          org_count?: number
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          email?: string
          expires_estimate_at?: string | null
          identity_verified?: boolean
          last_error?: string | null
          last_ok_at?: string | null
          last_seeded_at?: string | null
          org_count?: number
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      candidate_emails: {
        Row: {
          confidence: number
          email: string
          id: string
          learned_at: string
          slack_submission_id: string
          source: string
          user_id: string
        }
        Insert: {
          confidence?: number
          email: string
          id?: string
          learned_at?: string
          slack_submission_id: string
          source?: string
          user_id: string
        }
        Update: {
          confidence?: number
          email?: string
          id?: string
          learned_at?: string
          slack_submission_id?: string
          source?: string
          user_id?: string
        }
        Relationships: []
      }
      candidates: {
        Row: {
          ashby_candidate_id: string | null
          ashby_job_id: string | null
          candidate_name: string
          closed_at: string | null
          closed_locally: boolean
          company_name: string
          created_at: string
          credited_to: string
          current_stage_avg_score: number | null
          current_stage_date: string | null
          current_stage_index: number
          current_stage_interviews: string | null
          days_in_stage: number | null
          decision_status: string
          feedback_count: number | null
          id: string
          interview_history_summary: string | null
          job_title: string
          last_activity_at: string | null
          latest_feedback_author: string | null
          latest_feedback_date: string | null
          latest_recommendation: string | null
          needs_scheduling: boolean | null
          pipeline_stage: string
          session_id: string
          total_stages: number
          user_id: string
        }
        Insert: {
          ashby_candidate_id?: string | null
          ashby_job_id?: string | null
          candidate_name: string
          closed_at?: string | null
          closed_locally?: boolean
          company_name: string
          created_at?: string
          credited_to: string
          current_stage_avg_score?: number | null
          current_stage_date?: string | null
          current_stage_index?: number
          current_stage_interviews?: string | null
          days_in_stage?: number | null
          decision_status: string
          feedback_count?: number | null
          id?: string
          interview_history_summary?: string | null
          job_title: string
          last_activity_at?: string | null
          latest_feedback_author?: string | null
          latest_feedback_date?: string | null
          latest_recommendation?: string | null
          needs_scheduling?: boolean | null
          pipeline_stage: string
          session_id: string
          total_stages?: number
          user_id: string
        }
        Update: {
          ashby_candidate_id?: string | null
          ashby_job_id?: string | null
          candidate_name?: string
          closed_at?: string | null
          closed_locally?: boolean
          company_name?: string
          created_at?: string
          credited_to?: string
          current_stage_avg_score?: number | null
          current_stage_date?: string | null
          current_stage_index?: number
          current_stage_interviews?: string | null
          days_in_stage?: number | null
          decision_status?: string
          feedback_count?: number | null
          id?: string
          interview_history_summary?: string | null
          job_title?: string
          last_activity_at?: string | null
          latest_feedback_author?: string | null
          latest_feedback_date?: string | null
          latest_recommendation?: string | null
          needs_scheduling?: boolean | null
          pipeline_stage?: string
          session_id?: string
          total_stages?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidates_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "pipeline_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      client_aliases: {
        Row: {
          alias: string
          canonical: string
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          alias: string
          canonical: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          alias?: string
          canonical?: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      client_domain_cache: {
        Row: {
          client_name: string
          confidence: number
          domain: string
          learned_at: string
          source: string
          user_id: string
        }
        Insert: {
          client_name: string
          confidence?: number
          domain: string
          learned_at?: string
          source?: string
          user_id: string
        }
        Update: {
          client_name?: string
          confidence?: number
          domain?: string
          learned_at?: string
          source?: string
          user_id?: string
        }
        Relationships: []
      }
      fetch_jobs: {
        Row: {
          candidate_count: number | null
          created_at: string
          error_message: string | null
          finished_at: string | null
          id: string
          orgs_failed: number | null
          orgs_fetched: number | null
          orgs_total: number | null
          result_payload: Json | null
          result_received_at: string | null
          started_at: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          candidate_count?: number | null
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          orgs_failed?: number | null
          orgs_fetched?: number | null
          orgs_total?: number | null
          result_payload?: Json | null
          result_received_at?: string | null
          started_at?: string
          status: string
          updated_at?: string
          user_id: string
        }
        Update: {
          candidate_count?: number | null
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          orgs_failed?: number | null
          orgs_fetched?: number | null
          orgs_total?: number | null
          result_payload?: Json | null
          result_received_at?: string | null
          started_at?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      google_calendar_tokens: {
        Row: {
          access_token: string | null
          created_at: string
          expires_at: string | null
          google_email: string | null
          refresh_token: string
          scope: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token?: string | null
          created_at?: string
          expires_at?: string | null
          google_email?: string | null
          refresh_token: string
          scope?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string | null
          created_at?: string
          expires_at?: string | null
          google_email?: string | null
          refresh_token?: string
          scope?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      interview_events: {
        Row: {
          ashby_event_id: string | null
          candidate_row_id: string
          created_at: string
          end_time: string | null
          id: string
          interview_title: string
          interviewers: Json
          start_time: string
          user_id: string
        }
        Insert: {
          ashby_event_id?: string | null
          candidate_row_id: string
          created_at?: string
          end_time?: string | null
          id?: string
          interview_title: string
          interviewers?: Json
          start_time: string
          user_id: string
        }
        Update: {
          ashby_event_id?: string | null
          candidate_row_id?: string
          created_at?: string
          end_time?: string | null
          id?: string
          interview_title?: string
          interviewers?: Json
          start_time?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "interview_events_candidate_row_id_fkey"
            columns: ["candidate_row_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_states: {
        Row: {
          created_at: string
          provider: string
          state: string
          user_id: string
        }
        Insert: {
          created_at?: string
          provider: string
          state?: string
          user_id: string
        }
        Update: {
          created_at?: string
          provider?: string
          state?: string
          user_id?: string
        }
        Relationships: []
      }
      pipeline_save_reports: {
        Row: {
          created_at: string
          expected_count: number
          id: string
          missing: Json
          saved_count: number
          session_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expected_count?: number
          id?: string
          missing?: Json
          saved_count?: number
          session_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          expected_count?: number
          id?: string
          missing?: Json
          saved_count?: number
          session_id?: string
          user_id?: string
        }
        Relationships: []
      }
      pipeline_sessions: {
        Row: {
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      slack_channel_mappings: {
        Row: {
          channel_id: string
          channel_name: string
          client_name: string
          created_at: string
          enabled: boolean
          id: string
          last_synced_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          channel_id: string
          channel_name: string
          client_name: string
          created_at?: string
          enabled?: boolean
          id?: string
          last_synced_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          channel_id?: string
          channel_name?: string
          client_name?: string
          created_at?: string
          enabled?: boolean
          id?: string
          last_synced_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      slack_shortcut_sessions: {
        Row: {
          channel_id: string
          created_at: string
          email_block_version: number
          email_value: string
          enriched_at: string | null
          expires_at: string
          id: string
          joiners: Json
          last_payload: Json | null
          last_result: Json | null
          message_ts: string
          note_locked: boolean
          org_override: string | null
          prefill: Json | null
          resume_meta: Json | null
          resume_path: string | null
          slack_team_id: string
          slack_user_id: string
          thread_ts: string | null
          uploading: boolean
          user_id: string
          view_id: string | null
        }
        Insert: {
          channel_id: string
          created_at?: string
          email_block_version?: number
          email_value?: string
          enriched_at?: string | null
          expires_at?: string
          id?: string
          joiners?: Json
          last_payload?: Json | null
          last_result?: Json | null
          message_ts: string
          note_locked?: boolean
          org_override?: string | null
          prefill?: Json | null
          resume_meta?: Json | null
          resume_path?: string | null
          slack_team_id: string
          slack_user_id: string
          thread_ts?: string | null
          uploading?: boolean
          user_id: string
          view_id?: string | null
        }
        Update: {
          channel_id?: string
          created_at?: string
          email_block_version?: number
          email_value?: string
          enriched_at?: string | null
          expires_at?: string
          id?: string
          joiners?: Json
          last_payload?: Json | null
          last_result?: Json | null
          message_ts?: string
          note_locked?: boolean
          org_override?: string | null
          prefill?: Json | null
          resume_meta?: Json | null
          resume_path?: string | null
          slack_team_id?: string
          slack_user_id?: string
          thread_ts?: string | null
          uploading?: boolean
          user_id?: string
          view_id?: string | null
        }
        Relationships: []
      }
      slack_submissions: {
        Row: {
          candidate_name: string
          channel_id: string
          channel_name: string | null
          client_name: string
          created_at: string
          id: string
          last_activity_at: string | null
          last_refreshed_at: string | null
          last_reply_at: string | null
          linkedin_url: string | null
          message_ts: string
          migrated_from_channel_id: string | null
          needs_review: boolean
          permalink: string | null
          previous_client_names: string[]
          raw_text: string | null
          reply_count: number
          status: string
          submitted_at: string
          thread_ts: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          candidate_name?: string
          channel_id: string
          channel_name?: string | null
          client_name: string
          created_at?: string
          id?: string
          last_activity_at?: string | null
          last_refreshed_at?: string | null
          last_reply_at?: string | null
          linkedin_url?: string | null
          message_ts: string
          migrated_from_channel_id?: string | null
          needs_review?: boolean
          permalink?: string | null
          previous_client_names?: string[]
          raw_text?: string | null
          reply_count?: number
          status?: string
          submitted_at: string
          thread_ts?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          candidate_name?: string
          channel_id?: string
          channel_name?: string | null
          client_name?: string
          created_at?: string
          id?: string
          last_activity_at?: string | null
          last_refreshed_at?: string | null
          last_reply_at?: string | null
          linkedin_url?: string | null
          message_ts?: string
          migrated_from_channel_id?: string | null
          needs_review?: boolean
          permalink?: string | null
          previous_client_names?: string[]
          raw_text?: string | null
          reply_count?: number
          status?: string
          submitted_at?: string
          thread_ts?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      slack_sync_state: {
        Row: {
          channel_watermarks: Json
          failed_channel_ids: string[]
          last_full_sync_at: string | null
          last_scan_method: string | null
          last_sync_at: string | null
          live_channel_ids: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          channel_watermarks?: Json
          failed_channel_ids?: string[]
          last_full_sync_at?: string | null
          last_scan_method?: string | null
          last_sync_at?: string | null
          live_channel_ids?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          channel_watermarks?: Json
          failed_channel_ids?: string[]
          last_full_sync_at?: string | null
          last_scan_method?: string | null
          last_sync_at?: string | null
          live_channel_ids?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      slack_tokens: {
        Row: {
          access_token: string
          created_at: string
          expires_at: string | null
          refresh_token: string | null
          scope: string | null
          slack_team_id: string
          slack_team_name: string | null
          slack_user_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string
          expires_at?: string | null
          refresh_token?: string | null
          scope?: string | null
          slack_team_id: string
          slack_team_name?: string | null
          slack_user_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string
          expires_at?: string | null
          refresh_token?: string | null
          scope?: string | null
          slack_team_id?: string
          slack_team_name?: string | null
          slack_user_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      slack_workspaces: {
        Row: {
          bot_token: string
          bot_user_id: string | null
          installed_at: string
          installed_by: string | null
          team_id: string
          team_name: string | null
          updated_at: string
        }
        Insert: {
          bot_token: string
          bot_user_id?: string | null
          installed_at?: string
          installed_by?: string | null
          team_id: string
          team_name?: string | null
          updated_at?: string
        }
        Update: {
          bot_token?: string
          bot_user_id?: string | null
          installed_at?: string
          installed_by?: string | null
          team_id?: string
          team_name?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
