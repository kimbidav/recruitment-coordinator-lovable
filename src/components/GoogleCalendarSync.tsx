import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Calendar, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Candidate } from "@/data/candidates";

const TOKENS_KEY = "google_calendar_tokens";
const API_BASE = "https://ashby-automation-production.up.railway.app";

interface GoogleCalendarSyncProps {
  candidates: Candidate[];
}

export const GoogleCalendarSync = ({ candidates }: GoogleCalendarSyncProps) => {
  const [tokens, setTokens] = useState<Record<string, unknown> | null>(() => {
    const stored = localStorage.getItem(TOKENS_KEY);
    return stored ? JSON.parse(stored) : null;
  });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get("google_tokens");
    if (tokenParam) {
      try {
        const parsed = JSON.parse(decodeURIComponent(tokenParam));
        localStorage.setItem(TOKENS_KEY, JSON.stringify(parsed));
        setTokens(parsed);
        toast.success("Google Calendar connected!");
      } catch {
        toast.error("Failed to parse Google tokens");
      }
      params.delete("google_tokens");
      const cleanUrl = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
      window.history.replaceState({}, "", cleanUrl);
    }
  }, []);

  const handleConnect = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/google/auth`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || `Failed to get auth URL (${res.status})`);
        return;
      }
      const data = await res.json();
      window.location.href = data.url;
    } catch {
      toast.error("Failed to start Google auth");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSync = async () => {
    const now = new Date();
    const currentYear = now.getFullYear();

    // Extract interview type from strings like "• Technical Screen Interview (03/10) - Dar Mehta - No score yet"
    const extractInterviewType = (raw: string): string => {
      const cleaned = raw.replace(/^•\s*/, "").split("\n")[0].trim();
      // Match pattern before (MM/DD): "Technical Screen Interview (03/10)" → "Technical Screen Interview"
      const match = cleaned.match(/^(.+?)\s*\(\d{2}\/\d{2}\)/);
      let type = match ? match[1].trim() : cleaned.split(" - ")[0].trim();
      // Strip trailing " Interview" suffix
      type = type.replace(/\s+Interview$/i, "");
      return type;
    };

    // Extract (MM/DD) date from interview string and build a Date at 5pm local
    const extractDateFromInterviews = (interviews: string, fallbackDate?: string): Date | null => {
      const dateMatch = interviews.match(/\((\d{2})\/(\d{2})\)/);
      if (dateMatch) {
        const month = parseInt(dateMatch[1], 10);
        const day = parseInt(dateMatch[2], 10);
        return new Date(currentYear, month - 1, day, 17, 0, 0);
      }
      // Fallback to current_stage_date
      if (fallbackDate) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(fallbackDate)) {
          return new Date(fallbackDate + "T17:00:00");
        }
        return new Date(fallbackDate);
      }
      return null;
    };

    const withInterviews = candidates.filter((c) => c.current_stage_interviews);

    const events = withInterviews
      .map((c) => {
        const stageDate = extractDateFromInterviews(c.current_stage_interviews!, c.current_stage_date);
        if (!stageDate || isNaN(stageDate.getTime())) return null;
        const interviewType = extractInterviewType(c.current_stage_interviews!);
        return {
          id: c.candidate_id,
          interview_title: `${c.candidate_name} x ${c.company_name} (${interviewType})`,
          start_time: stageDate.toISOString(),
          end_time: new Date(stageDate.getTime() + 30 * 60 * 1000).toISOString(),
          candidate_name: c.candidate_name,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null && new Date(e.start_time) >= now);

    // Also include any structured interview_events
    const structuredEvents = candidates
      .flatMap((c) => (c.interview_events || []).map((e) => ({ ...e, candidate_name: c.candidate_name })))
      .filter((e) => new Date(e.start_time) >= now);

    const allEvents = [...events, ...structuredEvents];

    if (allEvents.length === 0) {
      toast.info("No upcoming interviews to sync");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/calendar/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: allEvents, google_tokens: tokens }),
      });

      if (res.status === 401) {
        localStorage.removeItem(TOKENS_KEY);
        setTokens(null);
        toast.error("Google session expired. Please reconnect.");
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || `Sync failed (${res.status})`);
        return;
      }

      const result = await res.json();
      toast.success(result.message || `Synced ${allEvents.length} events to Google Calendar`);
    } catch {
      toast.error("Failed to sync to Google Calendar");
    } finally {
      setIsLoading(false);
    }
  };

  if (!tokens) {
    return (
      <Button variant="outline" size="sm" onClick={handleConnect} disabled={isLoading} className="gap-2">
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
        Connect Google Calendar
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={handleSync} disabled={isLoading} className="gap-2">
      {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
      Sync to Calendar
    </Button>
  );
};
