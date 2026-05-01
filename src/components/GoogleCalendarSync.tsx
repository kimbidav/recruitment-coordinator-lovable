import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Candidate } from "@/data/candidates";
import { supabase } from "@/integrations/supabase/client";

interface GoogleCalendarSyncProps {
  candidates: Candidate[];
}

export const GoogleCalendarSync = ({ candidates }: GoogleCalendarSyncProps) => {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("google_calendar_tokens")
        .select("google_email")
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setConnected(false);
        return;
      }
      setConnected(!!data);
      setEmail(data?.google_email ?? null);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleConnect = async () => {
    setIsLoading(true);
    try {
      const redirectUri = `${window.location.origin}/google-calendar/callback`;
      const { data, error } = await supabase.functions.invoke("google-calendar-connect", {
        body: { redirect_uri: redirectUri },
      });
      if (error || !data?.url) {
        toast.error(`Failed to start Google auth: ${error?.message || data?.error || "no url"}`);
        return;
      }
      window.location.href = data.url;
    } finally {
      setIsLoading(false);
    }
  };

  const handleSync = async () => {
    const now = new Date();
    const currentYear = now.getFullYear();

    const extractInterviewType = (raw: string): string => {
      const cleaned = raw.replace(/^•\s*/, "").split("\n")[0].trim();
      const match = cleaned.match(/^(.+?)\s*\(\d{2}\/\d{2}\)/);
      let type = match ? match[1].trim() : cleaned.split(" - ")[0].trim();
      type = type.replace(/\s+Interview$/i, "");
      return type;
    };

    const extractDateFromInterviews = (interviews: string, fallbackDate?: string): Date | null => {
      const dateMatch = interviews.match(/\((\d{2})\/(\d{2})\)/);
      if (dateMatch) {
        return new Date(currentYear, parseInt(dateMatch[1], 10) - 1, parseInt(dateMatch[2], 10), 17, 0, 0);
      }
      if (fallbackDate) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(fallbackDate)) return new Date(fallbackDate + "T17:00:00");
        return new Date(fallbackDate);
      }
      return null;
    };

    const events = candidates
      .filter((c) => c.current_stage_interviews)
      .map((c) => {
        const stageDate = extractDateFromInterviews(c.current_stage_interviews!, c.current_stage_date);
        if (!stageDate || isNaN(stageDate.getTime())) return null;
        extractInterviewType(c.current_stage_interviews!);
        return {
          id: c.candidate_id,
          interview_title: `${c.candidate_name} x ${c.company_name} (${c.pipeline_stage})`,
          start_time: stageDate.toISOString(),
          end_time: new Date(stageDate.getTime() + 30 * 60 * 1000).toISOString(),
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null && new Date(e.start_time) >= now);

    if (events.length === 0) {
      toast.info("No upcoming interviews to sync");
      return;
    }

    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("google-calendar-sync", {
        body: { events },
      });
      if (error || data?.error) {
        toast.error(`Sync failed: ${error?.message || data?.error}`);
        if ((data?.error || "").toLowerCase().includes("not connected")) setConnected(false);
        return;
      }
      toast.success(data?.message || `Synced ${events.length} events`);
    } finally {
      setIsLoading(false);
    }
  };

  if (connected === null) {
    return (
      <Button variant="outline" size="sm" disabled className="gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  if (!connected) {
    return (
      <Button variant="outline" size="sm" onClick={handleConnect} disabled={isLoading} className="gap-2">
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
        Connect Google Calendar
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleSync}
      disabled={isLoading}
      className="gap-2"
      title={email ? `Connected as ${email}` : "Connected"}
    >
      {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
      Sync to Calendar
    </Button>
  );
};
