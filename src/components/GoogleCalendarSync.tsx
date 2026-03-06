import { useState, useEffect, useCallback } from "react";
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

  const handleMessage = useCallback((event: MessageEvent) => {
    if (event.data?.type === "google_tokens" && event.data.tokens) {
      localStorage.setItem(TOKENS_KEY, JSON.stringify(event.data.tokens));
      setTokens(event.data.tokens);
      toast.success("Google Calendar connected!");
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  const handleConnect = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/google/auth`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || `Failed to get auth URL (${res.status})`);
        return;
      }
      const { url } = await res.json();
      const w = 500;
      const h = 600;
      const left = window.screenX + (window.innerWidth - w) / 2;
      const top = window.screenY + (window.innerHeight - h) / 2;
      window.open(url, "google_auth", `width=${w},height=${h},left=${left},top=${top}`);
    } catch {
      toast.error("Failed to start Google auth");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSync = async () => {
    const now = new Date().toISOString();
    const events = candidates
      .flatMap((c) => (c.interview_events || []).map((e) => ({ ...e, candidate_name: c.candidate_name })))
      .filter((e) => e.start_time > now);

    if (events.length === 0) {
      toast.info("No upcoming interviews to sync");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/calendar/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events, google_tokens: tokens }),
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
      toast.success(result.message || `Synced ${events.length} events to Google Calendar`);
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
