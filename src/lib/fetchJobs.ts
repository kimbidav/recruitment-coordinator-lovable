import { supabase } from "@/integrations/supabase/client";

export type FetchJobStatus = "pending" | "running" | "succeeded" | "failed" | "partial";

export interface FetchJob {
  id: string;
  user_id: string;
  status: FetchJobStatus;
  started_at: string;
  finished_at: string | null;
  orgs_total: number | null;
  orgs_fetched: number | null;
  orgs_failed: number | null;
  candidate_count: number | null;
  error_message: string | null;
  result_payload?: unknown;
  result_received_at?: string | null;
  updated_at: string;
}

export async function createFetchJob(userId: string): Promise<FetchJob | null> {
  const { data, error } = await supabase
    .from("fetch_jobs")
    .insert({ user_id: userId, status: "running" })
    .select("*")
    .single();
  if (error) {
    console.error("createFetchJob failed:", error.message);
    return null;
  }
  return data as FetchJob;
}

export async function updateFetchJob(
  id: string,
  patch: Partial<Omit<FetchJob, "id" | "user_id" | "started_at">>,
): Promise<void> {
  const { error } = await supabase.from("fetch_jobs").update(patch).eq("id", id);
  if (error) console.error("updateFetchJob failed:", error.message);
}

export async function getLatestRunningJob(userId: string): Promise<FetchJob | null> {
  const { data } = await supabase
    .from("fetch_jobs")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as FetchJob | null) ?? null;
}

export async function getFetchJob(id: string): Promise<FetchJob | null> {
  const { data, error } = await supabase
    .from("fetch_jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("getFetchJob failed:", error.message);
    return null;
  }
  return (data as FetchJob | null) ?? null;
}
