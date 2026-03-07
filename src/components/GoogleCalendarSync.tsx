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

    // Extract just the interview type name from strings like "• Founder Call (03/09) - Michael Lee - No score yet"
    // or "Gina Wang x Forge (FD Technical Screen)" patterns
    const extractInterviewType = (raw: string): string => {
      const cleaned = raw.replace(/^•\s*/, "").split("\n")[0].trim();
      // If it contains "x CompanyName (Type)" pattern, extract just the type
      const xMatch = cleaned.match(/\((?:FD\s+)?(.+?)\)\s*$/);
      if (xMatch) return xMatch[1].trim();
      // Remove everything from the date parenthetical onward: "Founder Call (03/09) - ..." → "Founder Call"
      const match = cleaned.match(/^(.+?)\s*\(\d{2}\/\d{2}\)/);
      return match ? match[1].trim() : cleaned.split(" - ")[0].trim();
    };

    // Parse date and set to 5pm local time
    const parseStageDate = (dateStr: string): Date => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return new Date(dateStr + "T17:00:00");
      }
      return new Date(dateStr);
    };

    const withInterviews = candidates.filter((c) => c.current_stage_interviews && c.current_stage_date);
    console.log("Candidates with interviews+date:", withInterviews.length, withInterviews.map(c => ({ name: c.candidate_name, date: c.current_stage_date, interviews: c.current_stage_interviews })));

    const events = withInterviews
      .map((c) => {
      .map((c) => {
        const stageDate = parseStageDate(c.current_stage_date!);
        const interviewType = extractInterviewType(c.current_stage_interviews!);
        return {
          id: c.candidate_id,
          interview_title: `${c.candidate_name} x ${c.company_name} (${interviewType})`,
          start_time: stageDate.toISOString(),
          end_time: new Date(stageDate.getTime() + 30 * 60 * 1000).toISOString(),
          candidate_name: c.candidate_name,
        };
      })
      .filter((e) => new Date(e.start_time) >= now);

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
