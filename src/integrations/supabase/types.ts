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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      agent_action_cards: {
        Row: {
          candidate_row_id: string | null
          created_at: string
          id: string
          kind: string
          payload: Json
          slack_submission_id: string | null
          snooze_until: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          candidate_row_id?: string | null
          created_at?: string
          id?: string
          kind: string
          payload?: Json
          slack_submission_id?: string | null
          snooze_until?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          candidate_row_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          payload?: Json
          slack_submission_id?: string | null
          snooze_until?: string | null
          status?: string
          updated_at?: string
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
      slack_submissions: {
        Row: {
          candidate_name: string
          channel_id: string
          client_name: string
          created_at: string
          id: string
          linkedin_url: string | null
          message_ts: string
          needs_review: boolean
          permalink: string | null
          raw_text: string | null
          status: string
          submitted_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          candidate_name?: string
          channel_id: string
          client_name: string
          created_at?: string
          id?: string
          linkedin_url?: string | null
          message_ts: string
          needs_review?: boolean
          permalink?: string | null
          raw_text?: string | null
          status?: string
          submitted_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          candidate_name?: string
          channel_id?: string
          client_name?: string
          created_at?: string
          id?: string
          linkedin_url?: string | null
          message_ts?: string
          needs_review?: boolean
          permalink?: string | null
          raw_text?: string | null
          status?: string
          submitted_at?: string
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
