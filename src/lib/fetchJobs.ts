import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

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
  result_payload?: Json | null;
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

export interface FetchJobProgress {
  completed: number;
  total: number;
  current_org: string;
}

/** Live sweep progress reported by the extractor, stashed on the running job row. */
export function getJobProgress(job: FetchJob | null): FetchJobProgress | null {
  const payload = job?.result_payload as { progress?: unknown } | null | undefined;
  const p = payload?.progress as Partial<FetchJobProgress> | null | undefined;
  if (!p || typeof p.total !== "number" || p.total <= 0) return null;
  return {
    completed: typeof p.completed === "number" ? p.completed : 0,
    total: p.total,
    current_org: typeof p.current_org === "string" ? p.current_org : "",
  };
}

/**
 * Ask the ashby-sync edge function to check the extractor and advance the job.
 * This is the poll the UI should use while a job is running — reading the row
 * directly never advances it (nothing else talks to the extractor).
 */
export async function pollFetchJob(id: string): Promise<FetchJob | null> {
  const { data, error } = await supabase.functions.invoke("ashby-sync", {
    body: { poll_job_id: id },
  });
  if (error) {
    console.error("pollFetchJob failed:", error.message);
    // Network blip or edge hiccup — fall back to the row as-is so the
    // caller keeps polling instead of aborting the watch.
    return getFetchJob(id);
  }
  return ((data as { job?: FetchJob } | null)?.job as FetchJob | null) ?? null;
}
